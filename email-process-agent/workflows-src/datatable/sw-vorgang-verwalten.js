'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const AKTIONEN = ['lesen', 'anlegen', 'aktualisieren', 'kandidaten_suchen', 'sperren', 'entsperren'];

module.exports = function () {
	const wf = new Workflow('EPA SW Vorgang verwalten');

	wf.notiz('Notiz Zweck', [-80, -560], [
		'## EPA SW Vorgang verwalten',
		'**Zweck:** Einziger Lese- und Schreibzugriff auf die Data Table epa_vorgaenge (Speicher-Adapter, Bauplan 4.6). Ein Wechsel des Speichers betrifft nur diesen Workflow.',
		'**Trigger:** Aufruf durch andere Workflows.',
		'**Eingaben:** aktion (lesen | anlegen | aktualisieren | kandidaten_suchen | sperren | entsperren), kunde_id, vorgangs_id, daten (Objekt), erwartete_version, referenz, lock_sekunden.',
		'**Ausgabe:** lesen/anlegen/aktualisieren -> { vorgang }; kandidaten_suchen -> { kandidaten }; sperren -> { gesperrt, ... }; entsperren -> { entsperrt }.',
		'**Regeln:** Status ist hier nicht änderbar (nur EPA SW Status setzen). Schreiben nur per bedingtem Update (Compare-and-Set auf version bzw. lock_durch). Nur Whitelist-Felder.',
	].join('\n'), { breite: 700, hoehe: 320 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['aktion', 'string'],
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['daten', 'object'],
		['erwartete_version', 'number'],
		['referenz', 'string'],
		['lock_sekunden', 'number'],
	]);

	const eingabe = wf.code('Eingabe prüfen', [220, 0], ['fehlerklassen', 'datenTabellen'], `
const AKTIONEN = ${JSON.stringify(AKTIONEN)};
const ANLEGBAR = ['vorgangstyp', 'conversation_id', 'erste_message_id', 'absender_adresse', 'absender_name', 'betreff',
	'betreff_normalisiert', 'spoofing_hinweis', 'erste_mail_am', 'erste_mail_link'];
const e = $input.first().json;
const vid = typeof e.vorgangs_id === 'string' ? e.vorgangs_id.trim() : '';
const fehler = (code, text) => fehlerklassen.epaFehler(code, vid || null, text);
if (!AKTIONEN.includes(e.aktion)) throw fehler('UNGUELTIGES_FORMAT', \`Aktion "\${e.aktion}" ist unbekannt\`);
if (typeof e.kunde_id !== 'string' || !e.kunde_id.trim()) throw fehler('UNGUELTIGES_FORMAT', 'kunde_id fehlt');
const daten = e.daten && typeof e.daten === 'object' && !Array.isArray(e.daten) ? e.daten : {};
const brauchtId = ['lesen', 'aktualisieren', 'sperren', 'entsperren'].includes(e.aktion);
if (brauchtId && !/^V-\\d{4}-\\d{4,}$/.test(vid)) throw fehler('UNGUELTIGES_FORMAT', \`vorgangs_id "\${vid}" ist ungültig\`);
if (e.aktion === 'aktualisieren') {
	const unbekannt = Object.keys(daten).filter((k) => !datenTabellen.AENDERBAR.includes(k));
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

	const weiche = wf.node('Aktion verteilen', 'n8n-nodes-base.switch', [440, 0], {
		mode: 'rules',
		rules: {
			values: AKTIONEN.map((a) => ({
				conditions: bedingungen([bedingung('={{ $json.aktion }}', { type: 'string', operation: 'equals' }, a)]),
				renameOutput: true,
				outputKey: a,
			})),
		},
		options: {},
	});

	const E = "$('Eingabe prüfen').first().json";
	const vorgangLesen = (name, pos) => wf.tabelle(name, pos, 'get', 'epa_vorgaenge', {
		bedingungen: [['vorgangs_id', 'eq', `={{ ${E}.vorgangs_id }}`], ['kunde_id', 'eq', `={{ ${E}.kunde_id }}`]],
	}, { alwaysOutputData: true });
	const auditVorbereiten = (vorgangsquelle, typ, alt, neu, details) => `
const e = ${E};
const v = ${vorgangsquelle};
return [{ json: {
	kunde_id: e.kunde_id,
	vorgangs_id: v.vorgangs_id,
	typ: '${typ}',
	alt: ${alt},
	neu: ${neu},
	ausloeser: 'System',
	details: JSON.stringify(${details}),
	referenz: e.referenz,
} }];
`;

	// ---- lesen
	const lLesen = vorgangLesen('Vorgang lesen', [700, -480]);
	const lErgebnis = wf.code('Lesen auswerten', [920, -480], ['fehlerklassen', 'datenTabellen'], `
const e = ${E};
const v = datenTabellen.zeileLesen($input.first().json, 'epa_vorgaenge');
if (!v) throw fehlerklassen.epaFehler('VORGANG_NICHT_GEFUNDEN', e.vorgangs_id, 'Vorgang existiert nicht für diesen Kunden');
return [{ json: { vorgang: v } }];
`);

	// ---- anlegen: Kunde prüfen -> Zeile einfügen -> Vorgangs-ID aus Zeilen-ID vergeben -> Audit
	const aKunde = wf.tabelle('Kunde prüfen', [700, -320], 'get', 'epa_config_allgemein', {
		bedingungen: [['kunde_id', 'eq', `={{ ${E}.kunde_id }}`]],
	}, { alwaysOutputData: true });
	const aVorbereiten = wf.code('Neuen Vorgang vorbereiten', [920, -320], ['fehlerklassen', 'datenTabellen'], `
const e = ${E};
const k = $input.first().json;
if (!k || k.id === undefined) throw fehlerklassen.epaFehler('KONFIG_NICHT_GEFUNDEN', null, \`Kunde "\${e.kunde_id}" hat keine Config, Vorgang nicht angelegt\`);
const zeile = datenTabellen.neuerVorgang(e.kunde_id, e.daten, {
	aufbewahrungTage: k.aufbewahrung_tage,
	jetzt: new Date().toISOString(),
	platzhalterId: 'NEU-' + $execution.id + '-' + Math.random().toString(36).slice(2, 10),
});
return [{ json: zeile }];
`);
	const aEinfuegen = wf.tabelle('Vorgang einfügen', [1140, -320], 'insert', 'epa_vorgaenge');
	const aId = wf.code('Vorgangs-ID vergeben', [1360, -320], ['datenTabellen'], `
const r = $input.first().json;
const jahr = DateTime.now().setZone('Europe/Berlin').year;
return [{ json: { vorgangs_id: datenTabellen.vorgangsIdAusZeile(r.id, jahr) } }];
`);
	const aIdSchreiben = wf.tabelle('Vorgangs-ID schreiben', [1580, -320], 'update', 'epa_vorgaenge', {
		bedingungen: [['id', 'eq', "={{ $('Vorgang einfügen').first().json.id }}"]],
	});
	const aAudit = wf.code('Anlage-Audit vorbereiten', [1800, -320], [],
		auditVorbereiten("$('Vorgangs-ID vergeben').first().json", 'STATUS', 'null', "'Neu'", "{ aktion: 'anlegen' }"));
	const aAuditSchreiben = wf.tabelle('Anlage-Audit schreiben', [2020, -320], 'insert', 'epa_audit_log');
	const aErgebnis = wf.code('Anlegen auswerten', [2240, -320], ['datenTabellen'], `
const zeile = $('Vorgangs-ID schreiben').first().json;
return [{ json: { vorgang: datenTabellen.zeileLesen(zeile, 'epa_vorgaenge'), audit_id: $input.first().json.id } }];
`);

	// ---- aktualisieren: lesen -> Patch berechnen -> CAS-Update auf version -> Audit
	const uLesen = vorgangLesen('Vorgang für Änderung lesen', [700, -160]);
	const uBerechnen = wf.code('Änderung berechnen', [920, -160], ['fehlerklassen', 'datenTabellen'], `
const e = ${E};
const v = datenTabellen.zeileLesen($input.first().json, 'epa_vorgaenge');
if (!v) throw fehlerklassen.epaFehler('VORGANG_NICHT_GEFUNDEN', e.vorgangs_id, 'Vorgang existiert nicht für diesen Kunden');
if (v.version !== e.erwartete_version) {
	throw fehlerklassen.epaFehler('VERSIONSKONFLIKT', e.vorgangs_id, \`erwartet Version \${e.erwartete_version}, aktuell \${v.version}\`);
}
return [{ json: datenTabellen.aktualisierungBerechnen(v, e.daten) }];
`);
	const uSchreiben = wf.tabelle('Vorgang aktualisieren', [1140, -160], 'update', 'epa_vorgaenge', {
		bedingungen: [
			['vorgangs_id', 'eq', `={{ ${E}.vorgangs_id }}`],
			['kunde_id', 'eq', `={{ ${E}.kunde_id }}`],
			['version', 'eq', `={{ ${E}.erwartete_version }}`],
		],
	}, { alwaysOutputData: true });
	const uPruefen = wf.code('Aktualisierung prüfen', [1360, -160], ['fehlerklassen'], `
const e = ${E};
const r = $input.first().json;
if (!r || r.id === undefined) throw fehlerklassen.epaFehler('VERSIONSKONFLIKT', e.vorgangs_id, \`Vorgang wurde parallel geändert (erwartet Version \${e.erwartete_version})\`);
return [{ json: {
	kunde_id: e.kunde_id,
	vorgangs_id: e.vorgangs_id,
	typ: 'SYSTEM',
	alt: null,
	neu: null,
	ausloeser: 'System',
	details: JSON.stringify({ aktion: 'aktualisieren', felder: Object.keys(e.daten).sort() }),
	referenz: e.referenz,
} }];
`);
	const uAudit = wf.tabelle('Änderungs-Audit schreiben', [1580, -160], 'insert', 'epa_audit_log');
	const uErgebnis = wf.code('Aktualisieren auswerten', [1800, -160], ['datenTabellen'], `
return [{ json: { vorgang: datenTabellen.zeileLesen($('Vorgang aktualisieren').first().json, 'epa_vorgaenge') } }];
`);

	// ---- kandidaten_suchen: alle Vorgänge des Kunden lesen, im Code filtern
	const kLesen = wf.tabelle('Vorgänge des Kunden lesen', [700, 0], 'get', 'epa_vorgaenge', {
		bedingungen: [['kunde_id', 'eq', `={{ ${E}.kunde_id }}`]],
		alle: true,
	}, { alwaysOutputData: true });
	const kFiltern = wf.code('Kandidaten filtern', [920, 0], ['datenTabellen'], `
const e = ${E};
const zeilen = $input.all().map((i) => i.json);
return [{ json: { kandidaten: datenTabellen.kandidatenFiltern(zeilen, e.daten) } }];
`);

	// ---- sperren: lesen -> entscheiden -> CAS-Update auf lock_durch
	const sLesen = vorgangLesen('Vorgang für Sperre lesen', [700, 160]);
	const sEntscheiden = wf.code('Sperre prüfen', [920, 160], ['fehlerklassen', 'datenTabellen'], `
const e = ${E};
const v = datenTabellen.zeileLesen($input.first().json, 'epa_vorgaenge');
if (!v) throw fehlerklassen.epaFehler('VORGANG_NICHT_GEFUNDEN', e.vorgangs_id, 'Vorgang existiert nicht für diesen Kunden');
const s = datenTabellen.sperreEntscheiden(v, e.referenz, e.lock_sekunden, new Date().toISOString());
return [{ json: { ...s, zeilen_id: v.id } }];
`);
	const sWeiche = wf.node('Sperre möglich?', 'n8n-nodes-base.if', [1140, 160], {
		conditions: bedingungen([bedingung('={{ $json.moeglich }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const sDaten = wf.code('Sperre vorbereiten', [1360, 100], [], `
return [{ json: $input.first().json.neu }];
`);
	const S = "$('Sperre prüfen').first().json";
	const sSchreiben = wf.tabelle('Vorgang sperren', [1580, 100], 'update', 'epa_vorgaenge', {
		bedingungen: [
			['id', 'eq', `={{ ${S}.zeilen_id }}`],
			['lock_durch', `={{ ${S}.vorher_durch ? 'eq' : 'isEmpty' }}`, `={{ ${S}.vorher_durch ?? '' }}`],
		],
	}, { alwaysOutputData: true });
	const sErgebnis = wf.code('Sperre auswerten', [1800, 100], [], `
const r = $input.first().json;
const s = ${S};
if (r && r.id !== undefined) return [{ json: { gesperrt: true, sperre: { vorgangs_id: r.vorgangs_id, lock_bis: r.lock_bis, lock_durch: r.lock_durch, version: r.version } } }];
return [{ json: { gesperrt: false, gesperrt_durch: null, grund: 'Sperre wurde parallel vergeben' } }];
`);
	const sBelegt = wf.code('Sperre belegt melden', [1360, 240], [], `
const s = $input.first().json;
return [{ json: { gesperrt: false, gesperrt_durch: s.vorher_durch, gesperrt_bis: s.vorher_bis } }];
`);

	// ---- entsperren: nur die eigene Sperre lösen
	const eDaten = wf.code('Entsperren vorbereiten', [700, 380], [], `
return [{ json: { lock_durch: null, lock_bis: null } }];
`);
	const eSchreiben = wf.tabelle('Vorgang entsperren', [920, 380], 'update', 'epa_vorgaenge', {
		bedingungen: [
			['vorgangs_id', 'eq', `={{ ${E}.vorgangs_id }}`],
			['kunde_id', 'eq', `={{ ${E}.kunde_id }}`],
			['lock_durch', 'eq', `={{ ${E}.referenz }}`],
		],
	}, { alwaysOutputData: true });
	const eErgebnis = wf.code('Entsperren auswerten', [1140, 380], [], `
const r = $input.first().json;
return [{ json: { entsperrt: Boolean(r && r.id !== undefined) } }];
`);

	wf.kette(trigger, eingabe, weiche);
	wf.verbinde(weiche, lLesen, 0);
	wf.verbinde(weiche, aKunde, 1);
	wf.verbinde(weiche, uLesen, 2);
	wf.verbinde(weiche, kLesen, 3);
	wf.verbinde(weiche, sLesen, 4);
	wf.verbinde(weiche, eDaten, 5);
	wf.kette(lLesen, lErgebnis);
	wf.kette(aKunde, aVorbereiten, aEinfuegen, aId, aIdSchreiben, aAudit, aAuditSchreiben, aErgebnis);
	wf.kette(uLesen, uBerechnen, uSchreiben, uPruefen, uAudit, uErgebnis);
	wf.kette(kLesen, kFiltern);
	wf.kette(sLesen, sEntscheiden, sWeiche);
	wf.verbinde(sWeiche, sDaten, 0);
	wf.verbinde(sWeiche, sBelegt, 1);
	wf.kette(sDaten, sSchreiben, sErgebnis);
	wf.kette(eDaten, eSchreiben, eErgebnis);
	return wf;
};
