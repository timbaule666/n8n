'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

module.exports = function () {
	const wf = new Workflow('EPA SW Status setzen');

	wf.notiz('Notiz Zweck', [-80, -380], [
		'## EPA SW Status setzen',
		'**Zweck:** Einziger Weg, den Status eines Vorgangs zu ändern. Prüft die Übergangsmatrix (src/statusMatrix.js), schreibt den Status per bedingtem Update (Compare-and-Set auf Status + Version) und danach den Audit-Eintrag.',
		'**Speicher:** n8n Data Tables epa_vorgaenge, epa_audit_log.',
		'**Trigger:** Aufruf durch andere Workflows.',
		'**Eingaben:** kunde_id, vorgangs_id, neuer_status, ausloeser (KI | System | Cronjob | Mitarbeiter:<Name>), details (Objekt), referenz, erwartete_version (optional), nur_wenn_erlaubt.',
		'**Ausgabe:** { ok, uebersprungen, vorgangs_id, alter_status, neuer_status, version, audit_id }',
		'**Outlook-Markierung:** Nach jedem Statuswechsel startet "EPA SW Outlook-Kategorie" ohne zu warten; ein Fehler dort ändert nichts am Ergebnis.',
		'**Fehler:** 400 Eingabe, 404 Vorgang fehlt, 409 unzulässiger Übergang oder Versionskonflikt.',
	].join('\n'), { breite: 660, hoehe: 300 });

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

	const laden = wf.tabelle('Vorgang laden', [440, 0], 'get', 'epa_vorgaenge', {
		bedingungen: [['vorgangs_id', 'eq', '={{ $json.vorgangs_id }}'], ['kunde_id', 'eq', '={{ $json.kunde_id }}']],
	}, { alwaysOutputData: true });

	const pruefen = wf.code('Übergang prüfen', [660, 0], ['fehlerklassen', 'statusMatrix'], `
const e = $('Eingabe prüfen').first().json;
const v = $input.first().json;
if (!v || v.id === undefined) throw fehlerklassen.epaFehler('VORGANG_NICHT_GEFUNDEN', e.vorgangs_id, 'Vorgang existiert nicht für diesen Kunden');
if (e.erwartete_version !== null && v.version !== e.erwartete_version) {
	throw fehlerklassen.epaFehler('VERSIONSKONFLIKT', e.vorgangs_id, \`erwartet Version \${e.erwartete_version}, aktuell \${v.version}\`);
}
const p = statusMatrix.pruefeUebergang(v.status, e.neuer_status, e.ausloeser);
if (!p.erlaubt && !e.nur_wenn_erlaubt) throw fehlerklassen.epaFehler(p.code, e.vorgangs_id, p.grund);
return [{ json: { ...e, zeilen_id: v.id, alter_status: v.status, aktuelle_version: v.version, erlaubt: p.erlaubt, grund: p.grund, pruefcode: p.code } }];
`);

	const weiche = wf.node('Übergang erlaubt?', 'n8n-nodes-base.if', [880, 0], {
		conditions: bedingungen([bedingung('={{ $json.erlaubt }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});

	const vorbereiten = wf.code('Statuswechsel vorbereiten', [1100, -100], [], `
const e = $input.first().json;
return [{ json: { status: e.neuer_status, version: e.aktuelle_version + 1 } }];
`);

	// Compare-and-Set: nur ändern, wenn Status und Version noch dem gelesenen Stand entsprechen.
	const schreiben = wf.tabelle('Status schreiben', [1320, -100], 'update', 'epa_vorgaenge', {
		bedingungen: [
			['id', 'eq', "={{ $('Übergang prüfen').first().json.zeilen_id }}"],
			['version', 'eq', "={{ $('Übergang prüfen').first().json.aktuelle_version }}"],
			['status', 'eq', "={{ $('Übergang prüfen').first().json.alter_status }}"],
		],
	}, { alwaysOutputData: true });

	const ergebnis = wf.code('Ergebnis prüfen', [1540, -100], ['fehlerklassen'], `
const e = $('Übergang prüfen').first().json;
const r = $input.first().json;
if (!r || r.id === undefined) {
	throw fehlerklassen.epaFehler('VERSIONSKONFLIKT', e.vorgangs_id, \`Status wurde parallel geändert (erwartet "\${e.alter_status}")\`);
}
return [{ json: {
	kunde_id: e.kunde_id,
	vorgangs_id: e.vorgangs_id,
	typ: 'STATUS',
	alt: e.alter_status,
	neu: e.neuer_status,
	ausloeser: e.ausloeser,
	details: JSON.stringify(e.details || {}),
	referenz: e.referenz,
} }];
`);

	const audit = wf.tabelle('Audit schreiben', [1760, -100], 'insert', 'epa_audit_log');

	const melden = wf.code('Ergebnis melden', [1980, -100], [], `
const e = $('Übergang prüfen').first().json;
return [{ json: {
	ok: true,
	uebersprungen: false,
	vorgangs_id: e.vorgangs_id,
	alter_status: e.alter_status,
	neuer_status: e.neuer_status,
	version: e.aktuelle_version + 1,
	audit_id: $input.first().json.id,
} }];
`);

	const ueberspringen = wf.code('Übersprungen melden', [1100, 140], [], `
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
	wf.verbinde(weiche, vorbereiten, 0);
	wf.verbinde(weiche, ueberspringen, 1);
	const markieren = wf.aufruf('Outlook markieren', [2200, -100], 'EPA SW Outlook-Kategorie', [
		['kunde_id', 'string', "={{ $('Übergang prüfen').first().json.kunde_id }}"],
		['vorgangs_id', 'string', "={{ $('Übergang prüfen').first().json.vorgangs_id }}"],
		['neuer_status', 'string', "={{ $('Übergang prüfen').first().json.neuer_status }}"],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	// Nicht warten: die Markierung darf den Statuswechsel weder verzögern noch scheitern lassen.
	wf.nodes.find((n) => n.name === markieren).parameters.options.waitForSubWorkflow = false;
	const zurueck = wf.code('Ergebnis zurückgeben', [2420, -100], [], `
return [{ json: $('Ergebnis melden').first().json }];
`);

	wf.kette(vorbereiten, schreiben, ergebnis, audit, melden, markieren, zurueck);
	return wf;
};
