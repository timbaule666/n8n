'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const AKTIONEN = ['lesen', 'anlegen', 'aktualisieren', 'kandidaten_suchen', 'sperren', 'entsperren'];

module.exports = function () {
	const wf = new Workflow('EPA SW Vorgang verwalten');

	wf.notiz('Notiz Zweck', [-80, -420], [
		'## EPA SW Vorgang verwalten',
		'**Zweck:** Einziger Lese- und Schreibzugriff auf epa_vorgaenge (Speicher-Adapter, Bauplan 4.6). Ein Wechsel des Speichers betrifft nur diesen Workflow.',
		'**Trigger:** Aufruf durch andere Workflows.',
		'**Eingaben:** aktion (lesen | anlegen | aktualisieren | kandidaten_suchen | sperren | entsperren), kunde_id, vorgangs_id, daten (Objekt), erwartete_version, referenz, lock_sekunden.',
		'**Ausgabe:** lesen/anlegen/aktualisieren -> { vorgang }; kandidaten_suchen -> { kandidaten }; sperren -> { gesperrt, sperre }; entsperren -> { entsperrt }.',
		'**Regeln:** Status ist hier nicht änderbar (nur EPA SW Status setzen). aktualisieren braucht erwartete_version (409 bei Konflikt). Nur Whitelist-Felder.',
	].join('\n'), { breite: 660, hoehe: 300 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['aktion', 'string'],
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['daten', 'object'],
		['erwartete_version', 'number'],
		['referenz', 'string'],
		['lock_sekunden', 'number'],
	]);

	const eingabe = wf.code('Eingabe prüfen', [220, 0], ['fehlerklassen'], `
const AKTIONEN = ${JSON.stringify(AKTIONEN)};
const AENDERBAR = ['vorgangstyp', 'conversation_id', 'letzte_message_id', 'neue_message_ids', 'absender_name', 'betreff',
	'betreff_normalisiert', 'extrahierte_daten', 'fehlende_felder', 'konflikte', 'rundenzaehler', 'antwort_frist',
	'erinnerungen_gesendet', 'bearbeiter', 'freigabe_id_aktuell', 'spoofing_hinweis', 'sprache'];
const ANLEGBAR = ['vorgangstyp', 'conversation_id', 'erste_message_id', 'absender_adresse', 'absender_name', 'betreff',
	'betreff_normalisiert', 'spoofing_hinweis'];
const e = $input.first().json;
const vid = typeof e.vorgangs_id === 'string' ? e.vorgangs_id.trim() : '';
const fehler = (code, text) => fehlerklassen.epaFehler(code, vid || null, text);
if (!AKTIONEN.includes(e.aktion)) throw fehler('UNGUELTIGES_FORMAT', \`Aktion "\${e.aktion}" ist unbekannt\`);
if (typeof e.kunde_id !== 'string' || !e.kunde_id.trim()) throw fehler('UNGUELTIGES_FORMAT', 'kunde_id fehlt');
const daten = e.daten && typeof e.daten === 'object' && !Array.isArray(e.daten) ? e.daten : {};
const brauchtId = ['lesen', 'aktualisieren', 'sperren', 'entsperren'].includes(e.aktion);
if (brauchtId && !/^V-\\d{4}-\\d{4,}$/.test(vid)) throw fehler('UNGUELTIGES_FORMAT', \`vorgangs_id "\${vid}" ist ungültig\`);
if (e.aktion === 'aktualisieren') {
	const unbekannt = Object.keys(daten).filter((k) => !AENDERBAR.includes(k));
	if (unbekannt.length) throw fehler('UNGUELTIGES_FORMAT', \`Nicht änderbare Felder: \${unbekannt.join(', ')}\`);
	if (Object.keys(daten).length === 0) throw fehler('UNGUELTIGES_FORMAT', 'Keine Änderungen übergeben');
	if (!Number.isInteger(e.erwartete_version)) throw fehler('UNGUELTIGES_FORMAT', 'erwartete_version ist Pflicht beim Aktualisieren');
	if ('neue_message_ids' in daten && !Array.isArray(daten.neue_message_ids)) throw fehler('UNGUELTIGES_FORMAT', 'neue_message_ids muss eine Liste sein');
}
if (e.aktion === 'anlegen') {
	const unbekannt = Object.keys(daten).filter((k) => !ANLEGBAR.includes(k));
	if (unbekannt.length) throw fehler('UNGUELTIGES_FORMAT', \`Nicht anlegbare Felder: \${unbekannt.join(', ')}\`);
}
const lockSekunden = e.lock_sekunden === undefined || e.lock_sekunden === null ? 300 : Number(e.lock_sekunden);
if (e.aktion === 'sperren' && (!Number.isInteger(lockSekunden) || lockSekunden < 10 || lockSekunden > 3600)) {
	throw fehler('UNGUELTIGES_FORMAT', 'lock_sekunden muss zwischen 10 und 3600 liegen');
}
return [{ json: {
	aktion: e.aktion,
	kunde_id: e.kunde_id.trim(),
	vorgangs_id: vid || null,
	daten,
	erwartete_version: Number.isInteger(e.erwartete_version) ? e.erwartete_version : null,
	referenz: e.referenz ? String(e.referenz) : String($execution.id),
	lock_sekunden: lockSekunden,
} }];
`);

	const regeln = AKTIONEN.map((a) => ({
		conditions: bedingungen([bedingung('={{ $json.aktion }}', { type: 'string', operation: 'equals' }, a)]),
		renameOutput: true,
		outputKey: a,
	}));
	const weiche = wf.node('Aktion verteilen', 'n8n-nodes-base.switch', [440, 0], {
		mode: 'rules',
		rules: { values: regeln },
		options: {},
	});

	const y = (i) => -300 + i * 120;
	const pg = {
		lesen: wf.postgres('Vorgang lesen', [700, y(0)], 'vorgang_lesen', '[ $json.vorgangs_id, $json.kunde_id ]'),
		anlegen: wf.postgres('Vorgang anlegen', [700, y(1)], 'vorgang_anlegen', '[ $json.kunde_id, $json.daten, $json.referenz ]', { retryOnFail: false }),
		aktualisieren: wf.postgres('Vorgang aktualisieren', [700, y(2)], 'vorgang_aktualisieren',
			'[ $json.vorgangs_id, $json.kunde_id, $json.daten, $json.erwartete_version, $json.referenz ]', { retryOnFail: false }),
		kandidaten_suchen: wf.postgres('Kandidaten suchen', [700, y(3)], 'vorgang_kandidaten', '[ $json.kunde_id, $json.daten ]'),
		sperren: wf.postgres('Vorgang sperren', [700, y(4)], 'vorgang_sperren', '[ $json.vorgangs_id, $json.kunde_id, $json.referenz, $json.lock_sekunden ]'),
		entsperren: wf.postgres('Vorgang entsperren', [700, y(5)], 'vorgang_entsperren', '[ $json.vorgangs_id, $json.kunde_id, $json.referenz ]'),
	};

	const auswerten = wf.code('Ergebnis auswerten', [960, 0], ['fehlerklassen'], `
const e = $('Eingabe prüfen').first().json;
const r = $input.first().json;
const fehler = (code, text) => fehlerklassen.epaFehler(code, e.vorgangs_id, text);
switch (e.aktion) {
	case 'lesen':
		if (!r.vorgang) throw fehler('VORGANG_NICHT_GEFUNDEN', 'Vorgang existiert nicht für diesen Kunden');
		return [{ json: { vorgang: r.vorgang } }];
	case 'anlegen':
		if (!r.vorgang) throw fehlerklassen.epaFehler('KONFIG_NICHT_GEFUNDEN', null, \`Kunde "\${e.kunde_id}" hat keine Config, Vorgang nicht angelegt\`);
		return [{ json: { vorgang: r.vorgang, audit_id: r.audit_id } }];
	case 'aktualisieren':
		if (r.vorgang) return [{ json: { vorgang: r.vorgang } }];
		if (r.version_vorher === null || r.version_vorher === undefined) throw fehler('VORGANG_NICHT_GEFUNDEN', 'Vorgang existiert nicht für diesen Kunden');
		throw fehler('VERSIONSKONFLIKT', \`erwartet Version \${e.erwartete_version}, aktuell \${r.version_vorher}\`);
	case 'kandidaten_suchen':
		return [{ json: { kandidaten: r.kandidaten || [] } }];
	case 'sperren':
		if (r.sperre) return [{ json: { gesperrt: true, sperre: r.sperre } }];
		if (!r.vorher) throw fehler('VORGANG_NICHT_GEFUNDEN', 'Vorgang existiert nicht für diesen Kunden');
		return [{ json: { gesperrt: false, gesperrt_durch: r.vorher.lock_durch, gesperrt_bis: r.vorher.lock_bis } }];
	case 'entsperren':
		return [{ json: { entsperrt: r.entsperrt === true } }];
}
throw fehler('UNGUELTIGES_FORMAT', \`Aktion "\${e.aktion}" ohne Auswertung\`);
`);

	wf.kette(trigger, eingabe, weiche);
	AKTIONEN.forEach((a, i) => {
		wf.verbinde(weiche, pg[a], i);
		wf.verbinde(pg[a], auswerten);
	});
	return wf;
};
