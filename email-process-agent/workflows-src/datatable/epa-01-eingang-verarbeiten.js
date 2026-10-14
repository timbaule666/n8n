'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const C = "$('Config laden').first().json.config";
const N = "$('Mail normalisieren').first().json";
const M = `${N}.mail`;
const Z = "$('Zuordnen').first().json";
const V = "$('Vorgang anlegen').first().json.vorgang";
const K = "$('Klasse auswerten').first().json";
const P = "$('Pflichtfelder prüfen').first().json";

function weiche(wf, name, pos, ausdruck, werte) {
	return wf.node(name, 'n8n-nodes-base.switch', pos, {
		mode: 'rules',
		rules: {
			values: werte.map((w) => ({
				conditions: bedingungen([bedingung(ausdruck, { type: 'string', operation: 'equals' }, w)]),
				renameOutput: true,
				outputKey: w,
			})),
		},
		options: {},
	});
}

module.exports = function () {
	const wf = new Workflow('EPA-01 Eingang verarbeiten');

	wf.notiz('Notiz Zweck', [-80, -760], [
		'## EPA-01 Eingang verarbeiten (Phase A + B)',
		'**Zweck:** Verarbeitet eine eingegangene Mail: Config laden (B1), normalisieren, Schleifenschutz/Auto-Replies (A1), Dedupe (A2), Vorgangszuordnung nach Punkteliste (A3), Klassifizierung per KI (A4), Extraktion per KI (B2), deterministische Pflichtfeld-Prüfung (B3), Speichern mit Versionsprüfung (B4), Statusweiche und Mitarbeiter-Meldung (B5).',
		'**Trigger:** Aufruf durch den Postfach-Workflow (EPA-00) mit der Graph-Message. Enthält selbst keine Microsoft-Zugänge, daher ohne Postfach testbar.',
		'**Eingaben:** postfach, mail (Graph-Message inkl. internetMessageHeaders, webLink), anhaenge (Liste mit name, contentType, size, isInline, text, status, hinweis, bild_data_url), aufrufer_execution_id (damit EPA-05 den Eingang bei einem Fehler wieder freigeben kann).',
		'**Ausgabe:** { ergebnis, vorgangs_id, archivieren, archivordner }. ergebnis: duplikat | ignoriert_<grund> | antwort_<bereit|luecken|keine_daten|gemeldet|extraktion_fehlgeschlagen> | zuordnung_unklar | klassifizierung_unklar | ignoriert | bereit | luecken | extraktion_fehlgeschlagen.',
		'**Weiterleitung:** Eindeutig zugeordnete Antworten verarbeitet EPA-03 (Phase D). Bei "luecken" bereitet EPA-02 die Rückfrage zur Freigabe vor.',
	].join('\n'), { breite: 900, hoehe: 400 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['postfach', 'string'],
		['mail', 'object'],
		['anhaenge', 'array'],
		['aufrufer_execution_id', 'string'],
	]);

	const config = wf.aufruf('Config laden', [220, 0], 'EPA SW Config laden', [
		['kunde_id', 'string', ''],
		['postfach', 'string', '={{ $json.postfach }}'],
	]);

	const normalisieren = wf.code('Mail normalisieren', [440, 0], ['fehlerklassen', 'mailNormalisieren', 'eingang'], `
const e = $('Bei Aufruf').first().json;
const config = $input.first().json.config;
if (!e.mail || typeof e.mail !== 'object' || Array.isArray(e.mail)) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', null, 'mail fehlt');
const mail = mailNormalisieren.normalisieren(e.mail, config, Array.isArray(e.anhaenge) ? e.anhaenge : []);
mail.web_link = typeof e.mail.webLink === 'string' && /^https:\\/\\//.test(e.mail.webLink) ? e.mail.webLink : null;
return [{ json: {
	mail,
	vor: mailNormalisieren.vorpruefung(mail),
	heute: DateTime.now().setZone(config.zeitzone).toISODate(),
	hinweise_klassifizierung: eingang.klassifizierungsHinweise(mail),
	hinweise_extraktion: eingang.extraktionsHinweise(mail),
} }];
`);

	const vormerken = wf.code('Eingang vormerken', [660, 0], [], `
const n = $input.first().json;
const config = $('Config laden').first().json.config;
return [{ json: {
	kunde_id: config.kunde_id,
	message_id: n.mail.message_id || ('ohne-id:' + (n.mail.graph_id || $execution.id)),
	status: 'in_arbeit',
	ergebnis: null,
	vorgangs_id: null,
	execution_id: String($execution.id),
	aufrufer_execution_id: $('Bei Aufruf').first().json.aufrufer_execution_id ? String($('Bei Aufruf').first().json.aufrufer_execution_id) : null,
} }];
`);
	const eintragen = wf.tabelle('Eingang eintragen', [880, 0], 'insert', 'epa_verarbeitete_mails');
	const lesen = wf.tabelle('Eingänge zur Mail lesen', [1100, 0], 'get', 'epa_verarbeitete_mails', {
		bedingungen: [
			['kunde_id', 'eq', "={{ $('Eingang vormerken').first().json.kunde_id }}"],
			['message_id', 'eq', "={{ $('Eingang vormerken').first().json.message_id }}"],
		],
		alle: true,
		sortierung: ['id', 'ASC'],
	}, { alwaysOutputData: true });

	const weg = wf.code('Weg bestimmen', [1320, 0], ['eingang'], `
const eigene = $('Eingang eintragen').first().json.id;
const d = eingang.dedupeEntscheiden($input.all().map((i) => i.json), eigene);
const n = $('Mail normalisieren').first().json;
const weg = d.duplikat ? 'duplikat' : n.vor ? 'ignorieren' : 'zuordnen';
return [{ json: { weg, claim_id: eigene, dedupe: d } }];
`);
	const wegWeiche = weiche(wf, 'Weg', [1540, 0], '={{ $json.weg }}', ['duplikat', 'ignorieren', 'zuordnen']);

	const W = "$('Weg bestimmen').first().json";
	const MID = `${M}.message_id`;

	// ---------------------------------------------------------------- Duplikat (A2)
	const dupAudit = wf.aufruf('Duplikat protokollieren', [1760, -560], 'EPA SW Audit schreiben', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${W}.dedupe.vorgangs_id || '' }}`],
		['typ', 'string', 'DEDUPE'],
		['alt', 'string', ''],
		['neu', 'string', 'Duplikat übersprungen'],
		['ausloeser', 'string', 'System'],
		['details', 'object', `={{ { original_eintrag: ${W}.dedupe.original_id, original_status: ${W}.dedupe.original_status } }}`],
		['referenz', 'string', `={{ ${MID} || '' }}`],
	]);
	const dupErgebnis = wf.code('Ergebnis: Duplikat', [1980, -560], [], `
return [{ json: { ergebnis: 'duplikat', vorgangs_id: $('Weg bestimmen').first().json.dedupe.vorgangs_id || null } }];
`);

	// ---------------------------------------------------------------- Nicht verarbeiten (A1: eigene Mail, Auto-Reply, Blockliste)
	const ignAudit = wf.aufruf('Nicht verarbeitet protokollieren', [1760, -400], 'EPA SW Audit schreiben', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', ''],
		['typ', 'string', 'SYSTEM'],
		['alt', 'string', ''],
		['neu', 'string', `={{ 'nicht verarbeitet: ' + ${N}.vor.ergebnis }}`],
		['ausloeser', 'string', 'System'],
		['details', 'object', `={{ { grund: ${N}.vor.grund } }}`],
		['referenz', 'string', `={{ ${MID} || '' }}`],
	]);
	const ignErgebnis = wf.code('Ergebnis: Nicht verarbeitet', [1980, -400], [], `
return [{ json: { ergebnis: 'ignoriert_' + $('Mail normalisieren').first().json.vor.ergebnis, vorgangs_id: null } }];
`);

	// ---------------------------------------------------------------- Zuordnung (A3)
	const kandidaten = wf.aufruf('Kandidaten suchen', [1760, 0], 'EPA SW Vorgang verwalten', [
		['aktion', 'string', 'kandidaten_suchen'],
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', ''],
		['daten', 'object', `={{ { message_ids: ${M}.bezug_message_ids, conversation_id: ${M}.conversation_id, absender_adresse: ${M}.absender_adresse, betreff_normalisiert: ${M}.betreff_normalisiert, vorgangs_ids: ${M}.vorgangs_ids_erwaehnt } }}`],
		['erwartete_version', 'number', '={{ null }}'],
		['referenz', 'string', `={{ ${MID} }}`],
		['lock_sekunden', 'number', '={{ null }}'],
	]);
	const zuordnen = wf.code('Zuordnen', [1980, 0], ['zuordnung'], `
const config = $('Config laden').first().json.config;
const mail = $('Mail normalisieren').first().json.mail;
return [{ json: zuordnung.zuordnen(mail, $input.first().json.kandidaten || [], config.zuordnung_schwellen) }];
`);
	const zWeiche = weiche(wf, 'Zuordnung', [2200, 0], '={{ $json.ergebnis }}', ['eindeutig', 'unklar', 'neu']);

	// eindeutig: Zuordnung protokollieren, dann Phase D (EPA-03: Merge, Prüfung, ggf. neue Rückfrage, Meldung)
	const zAudit = wf.aufruf('Zuordnung protokollieren', [2420, -240], 'EPA SW Audit schreiben', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${Z}.vorgangs_id }}`],
		['typ', 'string', 'ZUORDNUNG'],
		['alt', 'string', ''],
		['neu', 'string', `={{ ${Z}.vorgangs_id }}`],
		['ausloeser', 'string', 'System'],
		['details', 'object', `={{ { ergebnis: ${Z}.ergebnis, grund: ${Z}.grund, bewertung: ${Z}.bewertung.slice(0, 3) } }}`],
		['referenz', 'string', `={{ ${MID} }}`],
	]);
	const antwortVerarbeiten = wf.aufruf('Antwort verarbeiten', [2640, -240], 'EPA-03 Antwort verarbeiten', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${Z}.vorgangs_id }}`],
		['mail', 'object', `={{ ${M} }}`],
		['referenz', 'string', `={{ ${MID} }}`],
	]);
	const antwortErgebnis = wf.code('Ergebnis: Antwort', [2860, -240], [], `
const r = $input.first().json;
return [{ json: { ergebnis: 'antwort_' + r.ergebnis, vorgangs_id: r.vorgangs_id } }];
`);

	// unklar und neu: Vorgang anlegen (Status "Neu")
	const anlegen = wf.aufruf('Vorgang anlegen', [2420, 120], 'EPA SW Vorgang verwalten', [
		['aktion', 'string', 'anlegen'],
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', ''],
		['daten', 'object', `={{ { conversation_id: ${M}.conversation_id, erste_message_id: ${MID}, absender_adresse: ${M}.absender_adresse, absender_name: ${M}.absender_name, betreff: ${M}.betreff, betreff_normalisiert: ${M}.betreff_normalisiert, spoofing_hinweis: ${M}.spoofing.auffaellig ? ${M}.spoofing.hinweise.join('; ') : null } }}`],
		['erwartete_version', 'number', '={{ null }}'],
		['referenz', 'string', `={{ ${MID} }}`],
		['lock_sekunden', 'number', '={{ null }}'],
	]);
	const unklarFrage = wf.node('Zuordnung unklar?', 'n8n-nodes-base.if', [2640, 120], {
		conditions: bedingungen([bedingung(`={{ ${Z}.ergebnis }}`, { type: 'string', operation: 'equals' }, 'unklar')]),
		options: {},
	});
	const statusUnklar = wf.aufruf('Status: Zuordnung unklar', [2860, 0], 'EPA SW Status setzen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['neuer_status', 'string', 'Zuordnung unklar'],
		['ausloeser', 'string', 'System'],
		['details', 'object', `={{ { grund: ${Z}.grund, kandidaten: ${Z}.bewertung } }}`],
		['referenz', 'string', `={{ ${MID} }}`],
		['erwartete_version', 'number', `={{ ${V}.version }}`],
		['nur_wenn_erlaubt', 'boolean', '={{ false }}'],
	]);
	const mUnklar = wf.code('Meldung: Zuordnung unklar', [3080, 0], ['eingang'], `
const z = $('Zuordnen').first().json;
const v = $('Vorgang anlegen').first().json.vorgang;
const mail = $('Mail normalisieren').first().json.mail;
return [{ json: {
	vorgangs_id: v.vorgangs_id,
	anlass: 'zuordnung_unklar',
	nachricht_html: eingang.meldungZuordnungUnklar(v.vorgangs_id, mail, z),
	ergebnis: { ergebnis: 'zuordnung_unklar', vorgangs_id: v.vorgangs_id },
} }];
`);

	// ---------------------------------------------------------------- Klassifizierung (A4)
	const klassifizieren = wf.aufruf('Klassifizieren', [2860, 240], 'EPA SW LLM aufrufen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['aufgabe', 'string', 'klassifizierung'],
		['prompt_version', 'string', `={{ ${C}.prompt_versionen.klassifizierung }}`],
		['profil', 'object', `={{ ${C}.llm_profil.klassifizierung }}`],
		['kontext', 'object', `={{ { mail: ${M}, vorgangstypen: Object.keys(${C}.vorgangstypen), hinweise: ${N}.hinweise_klassifizierung } }}`],
		['fehler_als_ergebnis', 'boolean', '={{ false }}'],
	]);
	const klasse = wf.code('Klasse auswerten', [3080, 240], ['eingang'], `
const config = $('Config laden').first().json.config;
const mail = $('Mail normalisieren').first().json.mail;
const llm = $input.first().json;
const a = eingang.klasseAuswerten(llm, config, mail);
return [{ json: { ...a, llm: { modell: llm.modell, prompt_version: llm.prompt_version, versuche: llm.versuche, korrekturen: llm.korrekturen } } }];
`);
	const statusKlasse = wf.aufruf('Status nach Klassifizierung', [3300, 240], 'EPA SW Status setzen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['neuer_status', 'string', `={{ ${K}.status }}`],
		['ausloeser', 'string', `={{ ${K}.ausloeser }}`],
		['details', 'object', `={{ { grund: ${K}.grund, ...${K}.details, llm: ${K}.llm } }}`],
		['referenz', 'string', `={{ ${MID} }}`],
		['erwartete_version', 'number', `={{ ${V}.version }}`],
		['nur_wenn_erlaubt', 'boolean', '={{ false }}'],
	]);
	const kWeiche = weiche(wf, 'Nach Klasse', [3520, 240], `={{ ${K}.weg }}`, ['pruefen', 'unklar', 'ignoriert']);

	const mKlasse = wf.code('Meldung: Klassifizierung unklar', [3740, 300], ['eingang'], `
const k = $('Klasse auswerten').first().json;
const v = $('Vorgang anlegen').first().json.vorgang;
const mail = $('Mail normalisieren').first().json.mail;
return [{ json: {
	vorgangs_id: v.vorgangs_id,
	anlass: 'klassifizierung_unklar',
	nachricht_html: eingang.meldungKlassifizierung(v.vorgangs_id, mail, k),
	ergebnis: { ergebnis: 'klassifizierung_unklar', vorgangs_id: v.vorgangs_id },
} }];
`);
	const kiIgnoriert = wf.code('Ergebnis: Keine Anfrage', [3740, 460], [], `
return [{ json: { ergebnis: 'ignoriert', vorgangs_id: $('Vorgang anlegen').first().json.vorgang.vorgangs_id } }];
`);

	// ---------------------------------------------------------------- Extraktion (B2), Prüfung (B3), Speichern (B4), Weiche (B5)
	const extrahieren = wf.aufruf('Daten extrahieren', [3740, 120], 'EPA SW LLM aufrufen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['aufgabe', 'string', 'extraktion'],
		['prompt_version', 'string', `={{ ${C}.prompt_versionen.extraktion }}`],
		['profil', 'object', `={{ ${C}.llm_profil.extraktion }}`],
		['kontext', 'object', `={{ { mail: ${M}, felder: ${C}.vorgangstypen[${K}.vorgangstyp], heute: ${N}.heute, hinweise: ${N}.hinweise_extraktion } }}`],
		['fehler_als_ergebnis', 'boolean', '={{ false }}'],
	]);
	const pruefen = wf.code('Pflichtfelder prüfen', [3960, 120], ['pflichtfelder'], `
const config = $('Config laden').first().json.config;
const k = $('Klasse auswerten').first().json;
const n = $('Mail normalisieren').first().json;
const llm = $input.first().json;
const felder = config.vorgangstypen[k.vorgangstyp];
if (!llm.ok) {
	return [{ json: {
		weg: 'extraktion_fehlgeschlagen', status: 'Eskaliert / Manuell', fehlercode: llm.code,
		speichern: { vorgangstyp: k.vorgangstyp },
		details: { grund: 'Extraktion fehlgeschlagen', fehlercode: llm.code, fehler: llm.fehler },
	} }];
}
const p = pflichtfelder.pruefen(llm.ergebnis.felder, felder, { heute: n.heute });
const manipulation = llm.ergebnis.verdacht_manipulation === true || k.details.verdacht_manipulation === true;
return [{ json: {
	weg: p.vollstaendig ? 'bereit' : 'luecken',
	status: p.vollstaendig ? 'Bereit zur Bearbeitung' : 'Lücken erkannt',
	pruefung: p,
	verdacht_manipulation: manipulation,
	speichern: { vorgangstyp: k.vorgangstyp, extrahierte_daten: p.daten, fehlende_felder: p.fehlende },
	details: {
		fehlende: p.fehlende.map((f) => f.feldname),
		verworfen: p.hinweise.map((f) => f.feldname),
		unsicher: p.unsicher.map((f) => f.feldname),
		verdacht_manipulation: manipulation,
		llm: { modell: llm.modell, prompt_version: llm.prompt_version, versuche: llm.versuche, korrekturen: llm.korrekturen },
	},
} }];
`);
	const speichern = wf.aufruf('Daten speichern', [4180, 120], 'EPA SW Vorgang verwalten', [
		['aktion', 'string', 'aktualisieren'],
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['daten', 'object', `={{ ${P}.speichern }}`],
		['erwartete_version', 'number', "={{ $('Status nach Klassifizierung').first().json.version }}"],
		['referenz', 'string', `={{ ${MID} }}`],
		['lock_sekunden', 'number', '={{ null }}'],
	]);
	const statusPruefung = wf.aufruf('Status nach Prüfung', [4400, 120], 'EPA SW Status setzen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['neuer_status', 'string', `={{ ${P}.status }}`],
		['ausloeser', 'string', 'System'],
		['details', 'object', `={{ ${P}.details }}`],
		['referenz', 'string', `={{ ${MID} }}`],
		['erwartete_version', 'number', "={{ $('Daten speichern').first().json.vorgang.version }}"],
		['nur_wenn_erlaubt', 'boolean', '={{ false }}'],
	]);
	const lueckenFrage = wf.node('Lücken?', 'n8n-nodes-base.if', [4620, 120], {
		conditions: bedingungen([bedingung(`={{ ${P}.weg }}`, { type: 'string', operation: 'equals' }, 'luecken')]),
		options: {},
	});
	// Fehler in EPA-02 meldet EPA-05 selbst (Alarm, Vorgang sichern); die Mailverarbeitung läuft weiter.
	const rueckfrage = wf.aufruf('Rückfrage anfordern', [4840, 40], 'EPA-02 Rückfrage anfordern', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['art', 'string', 'rueckfrage'],
		['referenz', 'string', `={{ ${MID} }}`],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const mGeprueft = wf.code('Meldung: geprüft', [5060, 120], ['eingang'], `
const config = $('Config laden').first().json.config;
const k = $('Klasse auswerten').first().json;
const p = $('Pflichtfelder prüfen').first().json;
const v = $('Vorgang anlegen').first().json.vorgang;
const mail = $('Mail normalisieren').first().json.mail;
const html = p.weg === 'extraktion_fehlgeschlagen'
	? eingang.meldungExtraktionFehlgeschlagen(v.vorgangs_id, mail, p.fehlercode)
	: eingang.meldungGeprueft(v.vorgangs_id, mail, config.vorgangstypen[k.vorgangstyp], p.pruefung, {
		verdacht_manipulation: p.verdacht_manipulation,
		rueckfrage: $('Rückfrage anfordern').isExecuted ? $('Rückfrage anfordern').first().json : null,
	});
return [{ json: {
	vorgangs_id: v.vorgangs_id,
	anlass: p.weg,
	nachricht_html: html,
	ergebnis: { ergebnis: p.weg, vorgangs_id: v.vorgangs_id },
} }];
`);

	// ---------------------------------------------------------------- Meldung und Abschluss
	const MELDUNGEN = ['Meldung: Zuordnung unklar', 'Meldung: Klassifizierung unklar', 'Meldung: geprüft'];
	const informieren = wf.aufruf('Mitarbeiter informieren', [5280, 0], 'EPA SW Benachrichtigen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', '={{ $json.vorgangs_id }}'],
		['team_id', 'string', `={{ ${C}.benachrichtigung.team_id }}`],
		['channel_id', 'string', `={{ ${C}.benachrichtigung.channel_id }}`],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
		['anlass', 'string', '={{ $json.anlass }}'],
	]);
	const nachMeldung = wf.code('Ergebnis nach Meldung', [5500, 0], [], `
const MELDUNGEN = ${JSON.stringify(MELDUNGEN)};
const quelle = MELDUNGEN.find((n) => $(n).isExecuted);
return [{ json: { ...$(quelle).first().json.ergebnis, benachrichtigt: $input.first().json.gesendet === true } }];
`);

	const abschluss = wf.code('Abschluss vorbereiten', [5720, -200], [], `
const r = $input.first().json;
return [{ json: { status: 'fertig', ergebnis: r.ergebnis, vorgangs_id: r.vorgangs_id || null } }];
`);
	const abschliessen = wf.tabelle('Eingang abschließen', [5940, -200], 'update', 'epa_verarbeitete_mails', {
		bedingungen: [['id', 'eq', "={{ $('Weg bestimmen').first().json.claim_id }}"]],
	});
	const melden = wf.code('Ergebnis melden', [6160, -200], ['eingang'], `
const a = $('Abschluss vorbereiten').first().json;
const config = $('Config laden').first().json.config;
return [{ json: {
	ergebnis: a.ergebnis,
	vorgangs_id: a.vorgangs_id,
	archivieren: eingang.archivieren(a.ergebnis),
	archivordner: config.archivordner,
} }];
`);

	wf.kette(trigger, config, normalisieren, vormerken, eintragen, lesen, weg, wegWeiche);
	wf.verbinde(wegWeiche, dupAudit, 0);
	wf.verbinde(wegWeiche, ignAudit, 1);
	wf.verbinde(wegWeiche, kandidaten, 2);
	wf.kette(dupAudit, dupErgebnis, abschluss);
	wf.kette(ignAudit, ignErgebnis, abschluss);
	wf.kette(kandidaten, zuordnen, zWeiche);
	wf.verbinde(zWeiche, zAudit, 0);
	wf.verbinde(zWeiche, anlegen, 1);
	wf.verbinde(zWeiche, anlegen, 2);
	wf.kette(zAudit, antwortVerarbeiten, antwortErgebnis, abschluss);
	wf.kette(anlegen, unklarFrage);
	wf.verbinde(unklarFrage, statusUnklar, 0);
	wf.verbinde(unklarFrage, klassifizieren, 1);
	wf.kette(statusUnklar, mUnklar, informieren);
	wf.kette(klassifizieren, klasse, statusKlasse, kWeiche);
	wf.verbinde(kWeiche, extrahieren, 0);
	wf.verbinde(kWeiche, mKlasse, 1);
	wf.verbinde(kWeiche, kiIgnoriert, 2);
	wf.kette(mKlasse, informieren);
	wf.kette(kiIgnoriert, abschluss);
	wf.kette(extrahieren, pruefen, speichern, statusPruefung, lueckenFrage);
	wf.verbinde(lueckenFrage, rueckfrage, 0);
	wf.verbinde(lueckenFrage, mGeprueft, 1);
	wf.kette(rueckfrage, mGeprueft, informieren);
	wf.kette(informieren, nachMeldung, abschluss);
	wf.kette(abschluss, abschliessen, melden);
	return wf;
};
