'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

module.exports = function () {
	const wf = new Workflow('EPA SW Status setzen');

	wf.notiz('Notiz Zweck', [-80, -360], [
		'## EPA SW Status setzen',
		'**Zweck:** Einziger Weg, den Status eines Vorgangs zu ändern. Prüft die Übergangsmatrix (src/statusMatrix.js), schreibt Status und Audit atomar.',
		'**Trigger:** Aufruf durch andere Workflows.',
		'**Eingaben:** kunde_id, vorgangs_id, neuer_status, ausloeser (KI | System | Cronjob | Mitarbeiter:<Name>), details (Objekt), referenz (Mail-/Execution-ID), erwartete_version (optional), nur_wenn_erlaubt (true = unzulässigen Übergang still überspringen, z. B. im Error-Handler).',
		'**Ausgabe:** { ok, uebersprungen, vorgangs_id, alter_status, neuer_status, version, audit_id }',
		'**Fehler:** 400 Eingabe, 404 Vorgang fehlt, 409 unzulässiger Übergang oder Versionskonflikt.',
	].join('\n'), { breite: 620, hoehe: 280 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['neuer_status', 'string'],
		['ausloeser', 'string'],
		['details', 'object'],
		['referenz', 'string'],
		['erwartete_version', 'number'],
		['nur_wenn_erlaubt', 'boolean'],
	]);

	const eingabe = wf.code('Eingabe prüfen', [220, 0], ['fehlerklassen', 'statusMatrix'], `
const e = $input.first().json;
const vorgangsId = typeof e.vorgangs_id === 'string' ? e.vorgangs_id.trim() : '';
for (const feld of ['kunde_id', 'vorgangs_id', 'neuer_status', 'ausloeser']) {
	if (typeof e[feld] !== 'string' || e[feld].trim() === '') {
		throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', vorgangsId, \`Eingabe "\${feld}" fehlt\`);
	}
}
if (!statusMatrix.ALLE_STATUS.includes(e.neuer_status)) {
	throw fehlerklassen.epaFehler('UNBEKANNTER_STATUS', vorgangsId, \`Status "\${e.neuer_status}" ist unbekannt\`);
}
const version = e.erwartete_version === undefined || e.erwartete_version === null || e.erwartete_version === '' ? null : Number(e.erwartete_version);
if (version !== null && !Number.isInteger(version)) {
	throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', vorgangsId, 'erwartete_version muss ganzzahlig sein');
}
return [{ json: {
	kunde_id: e.kunde_id.trim(),
	vorgangs_id: vorgangsId,
	neuer_status: e.neuer_status,
	ausloeser: e.ausloeser.trim(),
	details: e.details && typeof e.details === 'object' && !Array.isArray(e.details) ? e.details : {},
	referenz: e.referenz ? String(e.referenz) : String($execution.id),
	erwartete_version: version,
	nur_wenn_erlaubt: e.nur_wenn_erlaubt === true,
} }];
`);

	const laden = wf.postgres('Vorgang laden', [440, 0], 'status_vorgang_laden', '[ $json.vorgangs_id, $json.kunde_id ]');

	const pruefen = wf.code('Übergang prüfen', [660, 0], ['fehlerklassen', 'statusMatrix'], `
const e = $('Eingabe prüfen').first().json;
const v = $input.first().json.vorgang;
if (!v) throw fehlerklassen.epaFehler('VORGANG_NICHT_GEFUNDEN', e.vorgangs_id, 'Vorgang existiert nicht für diesen Kunden');
if (e.erwartete_version !== null && v.version !== e.erwartete_version) {
	throw fehlerklassen.epaFehler('VERSIONSKONFLIKT', e.vorgangs_id, \`erwartet Version \${e.erwartete_version}, aktuell \${v.version}\`);
}
const p = statusMatrix.pruefeUebergang(v.status, e.neuer_status, e.ausloeser);
if (!p.erlaubt && !e.nur_wenn_erlaubt) throw fehlerklassen.epaFehler(p.code, e.vorgangs_id, p.grund);
return [{ json: { ...e, alter_status: v.status, aktuelle_version: v.version, erlaubt: p.erlaubt, grund: p.grund, pruefcode: p.code } }];
`);

	const weiche = wf.node('Übergang erlaubt?', 'n8n-nodes-base.if', [880, 0], {
		conditions: bedingungen([bedingung('={{ $json.erlaubt }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});

	const schreiben = wf.postgres('Status schreiben', [1100, -100], 'status_schreiben',
		'[ $json.vorgangs_id, $json.kunde_id, $json.alter_status, $json.neuer_status, $json.erwartete_version ?? null, $json.ausloeser, $json.details ?? {}, $json.referenz ]',
		// Kein automatischer Retry: Ein Retry nach erfolgreichem, aber nicht bestätigtem Commit würde als Versionskonflikt enden.
		{ retryOnFail: false });

	const ergebnis = wf.code('Ergebnis prüfen', [1320, -100], ['fehlerklassen'], `
const e = $('Übergang prüfen').first().json;
const r = $input.first().json;
if (!r.ergebnis) {
	throw fehlerklassen.epaFehler('VERSIONSKONFLIKT', e.vorgangs_id, \`Status wurde parallel geändert (erwartet "\${e.alter_status}")\`);
}
return [{ json: {
	ok: true,
	uebersprungen: false,
	vorgangs_id: e.vorgangs_id,
	alter_status: e.alter_status,
	neuer_status: r.ergebnis.status,
	version: r.ergebnis.version,
	audit_id: r.audit_id,
} }];
`);

	const ueberspringen = wf.code('Übersprungen melden', [1100, 120], [], `
const e = $input.first().json;
return [{ json: {
	ok: false,
	uebersprungen: true,
	vorgangs_id: e.vorgangs_id,
	alter_status: e.alter_status,
	neuer_status: e.alter_status,
	version: e.aktuelle_version,
	grund: e.grund,
	code: e.pruefcode,
} }];
`);

	wf.kette(trigger, eingabe, laden, pruefen, weiche);
	wf.verbinde(weiche, schreiben, 0);
	wf.verbinde(weiche, ueberspringen, 1);
	wf.verbinde(schreiben, ergebnis);
	return wf;
};
