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
		'**Ausgabe:** { ergebnis, vorgangs_id, archivieren, archivordner }. ergebnis: duplikat | ignoriert_<grund> | unzustellbar (NDR zu einem Vorgang: Eskaliert / Manuell, Freigabe "unzustellbar" bzw. "nicht_zugestellt", Warnung im Kanal und an den Betreiber) | antwort_<bereit|luecken|keine_daten|gemeldet|extraktion_fehlgeschlagen> | zuordnung_unklar | klassifizierung_unklar | ignoriert | bereit | luecken | extraktion_fehlgeschlagen.',
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

	const normalisieren = wf.code('Mail normalisieren', [440, 0], ['fehlerklassen', 'mailNormalisieren', 'eingang', 'unzustellbar'], `
const e = $('Bei Aufruf').first().json;
const config = $input.first().json.config;
if (!e.mail || typeof e.mail !== 'object' || Array.isArray(e.mail)) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', null, 'mail fehlt');
const mail = mailNormalisieren.normalisieren(e.mail, config, Array.isArray(e.anhaenge) ? e.anhaenge : []);
mail.web_link = typeof e.mail.webLink === 'string' && /^https:\\/\\//.test(e.mail.webLink) ? e.mail.webLink : null;
const vor = mailNormalisieren.vorpruefung(mail);
// Unzustellbarkeitsmeldung zu einer gesendeten Rückfrage: nicht still ignorieren, sondern melden
const ndr = vor && (vor.ergebnis === 'auto_antwort' || vor.ergebnis === 'eigene_mail') ? unzustellbar.erkennen(mail, config.postfach) : { ist: false };
return [{ json: {
	mail,
	vor,
	ndr,
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
const weg = d.duplikat ? 'duplikat' : n.ndr && n.ndr.ist ? 'unzustellbar' : n.vor ? 'ignorieren' : 'zuordnen';
return [{ json: { weg, claim_id: eigene, dedupe: d } }];
`);
	const wegWeiche = weiche(wf, 'Weg', [1540, 0], '={{ $json.weg }}', ['duplikat', 'ignorieren', 'zuordnen', 'unzustellbar']);

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

	// ---------------------------------------------------------------- Unzustellbarkeitsmeldung zu einer Rückfrage
	// Der Kunde hat die Nachricht nicht bekommen: Vorgang auf "Eskaliert / Manuell" (keine Erinnerungen ins Leere)
	// und Warnung im Kanal mit dem Grund des Mailservers. Nur für Vorgänge dieses Kunden.
	const NDR = `${N}.ndr`;
	const uLesen = wf.aufruf('Vorgang zur Unzustellbarkeit lesen', [1760, -240], 'EPA SW Vorgang verwalten', [
		['aktion', 'string', 'lesen'],
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${NDR}.vorgangs_id }}`],
		['daten', 'object', '={{ {} }}'],
		['erwartete_version', 'number', '={{ null }}'],
		['referenz', 'string', `={{ ${MID} || '' }}`],
		['lock_sekunden', 'number', '={{ null }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const uBekannt = wf.node('Vorgang bekannt?', 'n8n-nodes-base.if', [1980, -240], {
		conditions: bedingungen([bedingung("={{ Boolean($json.vorgang && $json.vorgang.vorgangs_id) }}", { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const uStatus = wf.aufruf('Status: Eskaliert (unzustellbar)', [2200, -300], 'EPA SW Status setzen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${NDR}.vorgangs_id }}`],
		['neuer_status', 'string', 'Eskaliert / Manuell'],
		['ausloeser', 'string', 'System'],
		['details', 'object', `={{ { grund: 'Nachricht nicht zugestellt', smtp: ${NDR}.grund, empfaenger: ${NDR}.empfaenger } }}`],
		['referenz', 'string', `={{ ${MID} || '' }}`],
		['erwartete_version', 'number', '={{ null }}'],
		['nur_wenn_erlaubt', 'boolean', '={{ true }}'],
	]);
	// Gesendete Freigabe des Vorgangs vermerken: "unzustellbar" (kommt nach erfolgreichem Zustelltest über EPA-04
	// erneut zur Freigabe) oder "nicht_zugestellt" (Adresse abgelehnt bzw. schon der zweite Fehlversuch).
	const uFgLesen = wf.tabelle('Freigabe zur Unzustellbarkeit lesen', [2420, -300], 'get', 'epa_freigaben', {
		bedingungen: [
			['freigabe_id', 'eq', "={{ $('Vorgang zur Unzustellbarkeit lesen').first().json.vorgang.freigabe_id_aktuell || '__keine__' }}"],
			['kunde_id', 'eq', `={{ ${C}.kunde_id }}`],
		],
	}, { alwaysOutputData: true, onError: 'continueRegularOutput' });
	const uFgAuswerten = wf.code('Unzustellbarkeit auswerten', [2640, -300], ['unzustellbar'], `
const f = $input.first().json;
const r = unzustellbar.freigabeVermerk({ freigabe: f && f.id !== undefined ? f : null, grund: $('Mail normalisieren').first().json.ndr.grund });
return [{ json: { ...r, freigabe_id: r.ok ? f.freigabe_id : null } }];
`);
	const uFgBetroffen = wf.node('Freigabe betroffen?', 'n8n-nodes-base.if', [2860, -300], {
		conditions: bedingungen([bedingung('={{ $json.ok }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const uFgDaten = wf.code('Vermerk-Daten', [3080, -380], [], `
return [{ json: $input.first().json.daten }];
`);
	// Bedingt auf status = gesendet: doppelte Meldungen ändern nichts.
	const uFgSchreiben = wf.tabelle('Freigabe als nicht zugestellt vermerken', [3300, -380], 'update', 'epa_freigaben', {
		bedingungen: [['freigabe_id', 'eq', "={{ $('Unzustellbarkeit auswerten').first().json.freigabe_id }}"], ['status', 'eq', 'gesendet']],
	}, { alwaysOutputData: true, onError: 'continueRegularOutput' });
	const uMeldung = wf.code('Meldung: nicht zugestellt', [3520, -300], ['unzustellbar'], `
const n = $('Mail normalisieren').first().json;
const s = $('Status: Eskaliert (unzustellbar)').first().json;
const v = $('Vorgang zur Unzustellbarkeit lesen').first().json.vorgang;
const a = $('Unzustellbarkeit auswerten').first().json;
const vermerkt = $('Freigabe als nicht zugestellt vermerken').isExecuted && $('Freigabe als nicht zugestellt vermerken').first().json.id !== undefined;
return [{ json: { nachricht_html: unzustellbar.meldung({ ...n.ndr, betreff: v.betreff, eskaliert: s.ok === true, erneut: vermerkt ? a.erneut : undefined }) } }];
`, { executeOnce: true });
	const uInfo = wf.aufruf('Kanal warnen (unzustellbar)', [3740, -300], 'EPA SW Benachrichtigen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${NDR}.vorgangs_id }}`],
		['team_id', 'string', `={{ ${C}.benachrichtigung.team_id }}`],
		['channel_id', 'string', `={{ ${C}.benachrichtigung.channel_id }}`],
		['kanal', 'string', `={{ ${C}.benachrichtigung.kanal }}`],
		['chat_id', 'string', `={{ ${C}.benachrichtigung.chat_id || '' }}`],
		['telegram_workflow_id', 'string', `={{ ${C}.benachrichtigung.telegram_workflow_id || '' }}`],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
		['anlass', 'string', 'nicht_zugestellt'],
	], { onError: 'continueRegularOutput' });
	// Störung zusätzlich an den Betreiber (wie EPA-05): Zeile "alarmierung" in epa_system_status. Nur wenn dort
	// Telegram eingetragen ist; ohne Eintrag bleibt es bei der Warnung im Kanal des Kunden. Kein Abbruch bei Fehlern.
	const uZiel = wf.tabelle('Alarmziel lesen (unzustellbar)', [3960, -300], 'get', 'epa_system_status', {
		bedingungen: [['schluessel', 'eq', 'alarmierung']],
	}, { alwaysOutputData: true, onError: 'continueRegularOutput', executeOnce: true });
	const uAlarm = wf.code('Betreiber-Alarm vorbereiten', [4180, -300], ['telegram'], `
const z = $input.all().map((i) => i.json).find((r) => r && r.schluessel === 'alarmierung') || {};
const ok = z.alarm_kanal === 'telegram_test' && telegram.istChatId(z.telegram_chat_id) && /^[A-Za-z0-9]{8,32}$/.test(String(z.telegram_workflow_id || ''));
return [{ json: { senden: ok, chat_id: ok ? String(z.telegram_chat_id).trim() : '', telegram_workflow_id: ok ? z.telegram_workflow_id : '', nachricht_html: $('Meldung: nicht zugestellt').first().json.nachricht_html } }];
`);
	const uAlarmFrage = wf.node('Telegram-Alarm?', 'n8n-nodes-base.if', [4400, -300], {
		conditions: bedingungen([bedingung('={{ $json.senden }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const uTelegram = wf.aufrufDynamisch('Betreiber per Telegram alarmieren', [4620, -380], '={{ $json.telegram_workflow_id }}', [
		['chat_id', 'string', '={{ $json.chat_id }}'],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
	], { onError: 'continueRegularOutput' });
	const uErg = wf.code('Ergebnis: unzustellbar', [4840, -300], [], `
const a = $('Unzustellbarkeit auswerten').first().json;
return [{ json: { ergebnis: 'unzustellbar', vorgangs_id: $('Mail normalisieren').first().json.ndr.vorgangs_id, erneut_zur_freigabe: a.ok ? a.erneut : false } }];
`, { executeOnce: true });
	const uErgNein = wf.code('Ergebnis: Unzustellbar ohne Vorgang', [2200, -160], [], `
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
		['daten', 'object', `={{ { conversation_id: ${M}.conversation_id, erste_message_id: ${MID}, absender_adresse: ${M}.absender_adresse, absender_name: ${M}.absender_name, betreff: ${M}.betreff, betreff_normalisiert: ${M}.betreff_normalisiert, spoofing_hinweis: ${M}.spoofing.auffaellig ? ${M}.spoofing.hinweise.join('; ') : null, erste_mail_am: ${M}.empfangen_am || null, erste_mail_link: ${M}.web_link || null } }}`],
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
		speichern: { vorgangstyp: k.vorgangstyp, sprache: k.details.sprache || null },
		details: { grund: 'Extraktion fehlgeschlagen', fehlercode: llm.code, fehler: llm.fehler },
	} }];
}
const p = pflichtfelder.pruefen(llm.ergebnis.felder, felder, { heute: n.heute, quelltext: pflichtfelder.quelltextAus(n.mail), absenderName: n.mail.absender_name });
const manipulation = llm.ergebnis.verdacht_manipulation === true || k.details.verdacht_manipulation === true;
return [{ json: {
	weg: p.vollstaendig ? 'bereit' : 'luecken',
	status: p.vollstaendig ? 'Bereit zur Bearbeitung' : 'Lücken erkannt',
	pruefung: p,
	verdacht_manipulation: manipulation,
	speichern: { vorgangstyp: k.vorgangstyp, sprache: k.details.sprache || null, extrahierte_daten: p.daten, fehlende_felder: p.fehlende },
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
	// Übersicht zur Mail für die Freigabe-Nachricht: so kommt bei einer Rückfrage nur eine Nachricht.
	const uebersicht = wf.code('Übersicht für Freigabe', [4730, 40], ['eingang', 'textHinweise'], `
const config = $('Config laden').first().json.config;
const k = $('Klasse auswerten').first().json;
const p = $('Pflichtfelder prüfen').first().json;
const v = $('Vorgang anlegen').first().json.vorgang;
const mail = $('Mail normalisieren').first().json.mail;
return [{ json: { kontext_html: eingang.meldungGeprueft(v.vorgangs_id, mail, config.vorgangstypen[k.vorgangstyp], p.pruefung, { verdacht_manipulation: p.verdacht_manipulation, ohneRueckfrageText: true, text_hinweise: textHinweise.alle(mail).hinweise }) } }];
`);
	// Fehler in EPA-02 meldet EPA-05 selbst (Alarm, Vorgang sichern); die Mailverarbeitung läuft weiter.
	const rueckfrage = wf.aufruf('Rückfrage anfordern', [4840, 40], 'EPA-02 Rückfrage anfordern', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['art', 'string', 'rueckfrage'],
		['referenz', 'string', `={{ ${MID} }}`],
		['kontext_html', 'string', '={{ $json.kontext_html }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const mGeprueft = wf.code('Meldung: geprüft', [5060, 120], ['eingang', 'textHinweise'], `
const config = $('Config laden').first().json.config;
const k = $('Klasse auswerten').first().json;
const p = $('Pflichtfelder prüfen').first().json;
const v = $('Vorgang anlegen').first().json.vorgang;
const mail = $('Mail normalisieren').first().json.mail;
const html = p.weg === 'extraktion_fehlgeschlagen'
	? eingang.meldungExtraktionFehlgeschlagen(v.vorgangs_id, mail, p.fehlercode)
	: eingang.meldungGeprueft(v.vorgangs_id, mail, config.vorgangstypen[k.vorgangstyp], p.pruefung, {
		verdacht_manipulation: p.verdacht_manipulation,
		text_hinweise: textHinweise.alle(mail).hinweise,
		rueckfrage: $('Rückfrage anfordern').isExecuted ? $('Rückfrage anfordern').first().json : null,
	});
const r = $('Rückfrage anfordern').isExecuted ? $('Rückfrage anfordern').first().json : null;
return [{ json: {
	vorgangs_id: v.vorgangs_id,
	anlass: p.weg,
	nachricht_html: html,
	// Rückfrage samt Übersicht ist beim Freigeber angekommen: keine zweite Nachricht.
	stumm: p.weg === 'luecken' && eingang.meldungInFreigabe(r),
	ergebnis: { ergebnis: p.weg, vorgangs_id: v.vorgangs_id },
} }];
`);
	const meldenFrage = wf.node('Meldung senden?', 'n8n-nodes-base.if', [5170, 120], {
		conditions: bedingungen([bedingung('={{ $json.stumm }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: { looseTypeValidation: true },
	});

	// ---------------------------------------------------------------- Meldung und Abschluss
	const MELDUNGEN = ['Meldung: Zuordnung unklar', 'Meldung: Klassifizierung unklar', 'Meldung: geprüft'];
	const informieren = wf.aufruf('Mitarbeiter informieren', [5280, 0], 'EPA SW Benachrichtigen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', '={{ $json.vorgangs_id }}'],
		['team_id', 'string', `={{ ${C}.benachrichtigung.team_id }}`],
		['channel_id', 'string', `={{ ${C}.benachrichtigung.channel_id }}`],
		['kanal', 'string', `={{ ${C}.benachrichtigung.kanal }}`],
		['chat_id', 'string', `={{ ${C}.benachrichtigung.chat_id || '' }}`],
		['telegram_workflow_id', 'string', `={{ ${C}.benachrichtigung.telegram_workflow_id || '' }}`],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
		['anlass', 'string', '={{ $json.anlass }}'],
	]);
	const nachMeldung = wf.code('Ergebnis nach Meldung', [5500, 0], [], `
const MELDUNGEN = ${JSON.stringify(MELDUNGEN)};
const quelle = MELDUNGEN.find((n) => $(n).isExecuted);
return [{ json: { ...$(quelle).first().json.ergebnis, benachrichtigt: $input.first().json.gesendet === true || $input.first().json.stumm === true } }];
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
	archivieren: eingang.archivieren(a.ergebnis, config.archivordner),
	archivordner: config.archivordner,
} }];
`);

	// ---------------------------------------------------------------- Systemwarnung Prompt-Injection
	// Eigene Meldung, sobald Klassifizierung, Extraktion oder Antwort-Auswertung Anweisungen an die KI erkennt
	// (auch bei Mails, die keine Anfrage sind). Ein Fehler beim Senden stoppt die Verarbeitung nicht.
	const warnungPruefen = wf.code('Manipulation prüfen', [5940, 100], ['eingang'], `
const erkannt = [];
let begruendung = null;
if ($('Klasse auswerten').isExecuted) {
	const k = $('Klasse auswerten').first().json;
	if (k.details && k.details.verdacht_manipulation === true) { erkannt.push('Klassifizierung'); begruendung = k.details.begruendung || null; }
}
if ($('Pflichtfelder prüfen').isExecuted && $('Pflichtfelder prüfen').first().json.verdacht_manipulation === true && !erkannt.length) erkannt.push('Datenauslesen');
if ($('Antwort verarbeiten').isExecuted && $('Antwort verarbeiten').first().json.verdacht_manipulation === true) erkannt.push('Kundenantwort');
if (!erkannt.length) return [];
const a = $('Abschluss vorbereiten').first().json;
const config = $('Config laden').first().json.config;
const mail = $('Mail normalisieren').first().json.mail;
const BEHANDLUNG = {
	ignoriert: 'keine Anfrage – nicht bearbeitet, die Mail bleibt im Posteingang',
	bereit: 'als Anfrage bearbeitet (vollständig) – bitte die Angaben vor der Bearbeitung prüfen',
	luecken: 'als Anfrage bearbeitet – die Rückfrage geht nur nach Freigabe raus',
	klassifizierung_unklar: 'nicht automatisch bearbeitet – bitte manuell prüfen',
};
const eingangText = mail.empfangen_am ? DateTime.fromISO(mail.empfangen_am).setZone(config.zeitzone).toFormat('dd.LL.yyyy, HH:mm') : null;
return [{ json: {
	vorgangs_id: a.vorgangs_id,
	nachricht_html: eingang.meldungManipulation({ vorgangs_id: a.vorgangs_id, mail, erkannt_bei: erkannt, begruendung,
		behandlung: BEHANDLUNG[a.ergebnis] || (String(a.ergebnis || '').startsWith('antwort_') ? 'Kundenantwort ausgewertet – übernommene Werte bitte prüfen' : String(a.ergebnis || '')),
		eingang_text: eingangText }),
} }];
`);
	const warnen = wf.aufruf('Systemwarnung senden', [6160, 100], 'EPA SW Benachrichtigen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', '={{ $json.vorgangs_id || "" }}'],
		['team_id', 'string', `={{ ${C}.benachrichtigung.team_id }}`],
		['channel_id', 'string', `={{ ${C}.benachrichtigung.channel_id }}`],
		['kanal', 'string', `={{ ${C}.benachrichtigung.kanal }}`],
		['chat_id', 'string', `={{ ${C}.benachrichtigung.chat_id || '' }}`],
		['telegram_workflow_id', 'string', `={{ ${C}.benachrichtigung.telegram_workflow_id || '' }}`],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
		['anlass', 'string', 'systemwarnung_manipulation'],
	], { onError: 'continueRegularOutput' });

	wf.kette(trigger, config, normalisieren, vormerken, eintragen, lesen, weg, wegWeiche);
	wf.verbinde(wegWeiche, dupAudit, 0);
	wf.verbinde(wegWeiche, ignAudit, 1);
	wf.verbinde(wegWeiche, kandidaten, 2);
	wf.verbinde(wegWeiche, uLesen, 3);
	wf.kette(uLesen, uBekannt);
	wf.verbinde(uBekannt, uStatus, 0);
	wf.verbinde(uBekannt, uErgNein, 1);
	wf.kette(uStatus, uFgLesen, uFgAuswerten, uFgBetroffen);
	wf.verbinde(uFgBetroffen, uFgDaten, 0);
	wf.verbinde(uFgBetroffen, uMeldung, 1);
	wf.kette(uFgDaten, uFgSchreiben, uMeldung);
	wf.kette(uMeldung, uInfo, uZiel, uAlarm, uAlarmFrage);
	wf.verbinde(uAlarmFrage, uTelegram, 0);
	wf.verbinde(uAlarmFrage, uErg, 1);
	wf.kette(uTelegram, uErg, abschluss);
	wf.kette(uErgNein, abschluss);
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
	wf.verbinde(lueckenFrage, uebersicht, 0);
	wf.verbinde(lueckenFrage, mGeprueft, 1);
	wf.kette(uebersicht, rueckfrage, mGeprueft, meldenFrage);
	wf.verbinde(meldenFrage, nachMeldung, 0);
	wf.verbinde(meldenFrage, informieren, 1);
	wf.kette(informieren, nachMeldung, abschluss);
	wf.verbinde(abschluss, warnungPruefen);
	wf.kette(warnungPruefen, warnen);
	wf.kette(abschluss, abschliessen, melden);
	return wf;
};
