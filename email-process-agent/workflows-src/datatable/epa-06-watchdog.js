'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');
const { SCHLUESSEL } = require('../../src/watchdog');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const L = "$('Lauf vorbereiten').first().json";
const VOLL = { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } };

module.exports = function () {
	const wf = new Workflow('EPA-06 Watchdog');
	wf.settings.timezone = 'Europe/Berlin';

	wf.notiz('Notiz Zweck', [-120, -640], [
		'## EPA-06 Watchdog (Phase F)',
		'**Zweck:** Prüft unabhängig vom Tagesgeschäft, ob alles läuft, und meldet Auffälligkeiten mit Handlungsempfehlung im Betriebskanal (src/watchdog.js).',
		'**Prüfungen:** 1) Heartbeat von EPA-04 (letzter Lauf älter als 3 h). 2) Hängende Vorgänge ("Neu", "In Prüfung", "Lücken erkannt" > 1 h; "Freigabe ausstehend" > 72 h; Arbeitslisten > 24 h werden gezählt). 3) Stille im Postfach (stille_alarm_stunden in der Config, in Geschäftsstunden). 4) Aktive Testaufrufe: Teams (Graph /me), OpenAI (/models), jedes Postfach (EPA-00-Kopie, Aktion verbindung_pruefen). 5) Fehler der letzten 24 h, die nicht nach Teams gemeldet werden konnten.',
		'**Heartbeat:** Ohne Befund einmal täglich "Alles in Ordnung". Bleibt diese Meldung aus, ist der Watchdog selbst ausgefallen. Ergebnis zusätzlich in epa_system_status (Zeile "' + SCHLUESSEL + '").',
		'**Trigger:** täglich 07:30 und 13:30 (Europe/Berlin), anpassbar im Node "Zweimal täglich". Zusätzlich Aufruf mit "jetzt" für Tests.',
		'**Einrichten:** Im Node "Betriebskanal benachrichtigen" Team und Kanal eintragen (wie EPA-05). Credentials: Teams (Dienstkonto) in "Teams prüfen" und im Betriebskanal-Node, OpenAI in "KI prüfen".',
	].join('\n'), { breite: 960, hoehe: 400 });

	const zeitplan = wf.node('Zweimal täglich', 'n8n-nodes-base.scheduleTrigger', [0, -100], {
		rule: { interval: [{ field: 'cronExpression', expression: '30 7,13 * * *' }] },
	});
	const manuell = wf.trigger('Bei Aufruf (Test/manuell)', [0, 100], [['jetzt', 'string']]);
	const vorbereiten = wf.code('Lauf vorbereiten', [220, 0], ['fehlerklassen'], `
const e = $input.first().json || {};
let jetzt = new Date().toISOString();
if (typeof e.jetzt === 'string' && e.jetzt.trim()) {
	if (!Number.isFinite(new Date(e.jetzt).getTime())) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', null, 'Eingabe "jetzt" ist kein gültiger Zeitpunkt');
	jetzt = new Date(e.jetzt).toISOString();
}
return [{ json: { jetzt, seit: new Date(new Date(jetzt).getTime() - 24 * 3600000).toISOString() } }];
`);
	const einmal = { alwaysOutputData: true, executeOnce: true };
	const status = wf.tabelle('Systemstatus lesen', [440, 0], 'get', 'epa_system_status', { alle: true }, einmal);
	const vorgaenge = wf.tabelle('Offene Vorgänge lesen', [660, 0], 'get', 'epa_vorgaenge', {
		bedingungen: [['status', 'neq', 'Abgeschlossen'], ['status', 'neq', 'Ignoriert']],
		alle: true,
	}, einmal);
	const configs = wf.tabelle('Configs lesen', [880, 0], 'get', 'epa_config_allgemein', { bedingungen: [['aktiv', 'isTrue']], alle: true }, einmal);
	const felder = wf.tabelle('Pflichtfelder lesen', [1100, 0], 'get', 'epa_config_pflichtfelder', { bedingungen: [['aktiv', 'isTrue']], alle: true }, einmal);
	const fehler = wf.tabelle('Fehlerlog lesen', [1320, 0], 'get', 'epa_fehler_log', { bedingungen: [['createdAt', 'gte', `={{ ${L}.seit }}`]], alle: true }, einmal);

	const kunden = wf.code('Kunden ermitteln', [1540, 0], ['configValidator'], `
// Nur aktive Kunden mit gültiger Config; ungültige meldet bereits EPA-04 bzw. jeder Eingang (EPA-05).
const zeilen = (n) => $(n).all().map((i) => i.json).filter((z) => z && z.id !== undefined);
const pflicht = zeilen('Pflichtfelder lesen');
const liste = [];
for (const a of zeilen('Configs lesen')) {
	const r = configValidator.validiereConfig(a, pflicht.filter((p) => p.kunde_id === a.kunde_id), { zeitzoneGueltig: (zone) => DateTime.now().setZone(zone).isValid });
	if (r.gueltig) liste.push(r.config);
}
// KI-Endpunkt für den Testaufruf: wie in der Config (Standard OpenAI).
const basis = (c) => String((c && c.llm_profil.klassifizierung.basis_url) || 'https://api.openai.com/v1').replace(/[/]+$/, '');
// Mindestens ein Eintrag, damit die Kette weiterläuft (Platzhalter liefert bei den Abfragen nichts).
if (!liste.length) return [{ json: { kunde_id: '__keiner__', platzhalter: true, llm_basis: basis(null) } }];
return liste.map((c) => ({ json: { kunde_id: c.kunde_id, platzhalter: false, llm_basis: basis(c) } }));
`);
	const letzteMail = wf.tabelle('Letzte Mail je Kunde lesen', [1760, 0], 'get', 'epa_verarbeitete_mails', {
		bedingungen: [['kunde_id', 'eq', '={{ $json.kunde_id }}']],
		limit: 1,
		sortierung: ['createdAt', 'DESC'],
	}, { alwaysOutputData: true });

	const teams = wf.node('Teams prüfen', 'n8n-nodes-base.httpRequest', [1980, 0], {
		method: 'GET',
		url: `${GRAPH}/me`,
		authentication: 'predefinedCredentialType',
		nodeCredentialType: 'microsoftTeamsOAuth2Api',
		sendQuery: true,
		specifyQuery: 'keypair',
		queryParameters: { parameters: [{ name: '$select', value: 'id' }] },
		options: { ...VOLL, timeout: 20000 },
	}, { executeOnce: true, onError: 'continueRegularOutput', alwaysOutputData: true });
	const kiZiele = wf.code('KI-Endpunkte', [2200, 0], [], `
// Je unterschiedlichem Endpunkt ein Testaufruf (Standard: OpenAI).
const ziele = [...new Set($('Kunden ermitteln').all().map((i) => i.json.llm_basis))];
return ziele.map((u) => ({ json: { llm_basis: u } }));
`);
	const ki = wf.node('KI prüfen', 'n8n-nodes-base.httpRequest', [2420, 0], {
		method: 'GET',
		url: '={{ $json.llm_basis }}/models',
		authentication: 'predefinedCredentialType',
		nodeCredentialType: 'openAiApi',
		options: { response: { response: { fullResponse: true, neverError: true, responseFormat: 'text' } }, timeout: 20000 },
	}, { onError: 'continueRegularOutput', alwaysOutputData: true });

	const auftraege = wf.code('Postfach-Prüfungen', [2640, 0], ['configValidator'], `
const zeilen = (n) => $(n).all().map((i) => i.json).filter((z) => z && z.id !== undefined);
const pflicht = zeilen('Pflichtfelder lesen');
const liste = [];
for (const a of zeilen('Configs lesen')) {
	const r = configValidator.validiereConfig(a, pflicht.filter((p) => p.kunde_id === a.kunde_id), { zeitzoneGueltig: (zone) => DateTime.now().setZone(zone).isValid });
	if (r.gueltig && r.config.postfach_workflow_id) liste.push({ kunde_id: r.config.kunde_id, postfach: r.config.postfach, postfach_workflow_id: r.config.postfach_workflow_id });
}
return liste.length ? liste.map((x) => ({ json: { ...x, pruefen: true } })) : [{ json: { pruefen: false } }];
`);
	const pruefenNoetig = wf.node('Postfächer zu prüfen?', 'n8n-nodes-base.if', [2860, 0], {
		conditions: bedingungen([bedingung('={{ $json.pruefen }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const postfach = wf.aufrufDynamisch('Postfach prüfen', [3080, -80], '={{ $json.postfach_workflow_id }}', [
		['aktion', 'string', 'verbindung_pruefen'],
		['postfach', 'string', '={{ $json.postfach }}'],
		['graph_id', 'string', ''],
		['internet_message_id', 'string', ''],
		['entwurf_id', 'string', ''],
		['freigabe_id', 'string', ''],
		['vorgangs_id', 'string', ''],
		['html', 'string', ''],
	], { onError: 'continueRegularOutput', alwaysOutputData: true }, 'each');

	const auswerten = wf.code('Auswerten', [3300, 0], ['configValidator', 'fristen', 'watchdog', 'telegram'], `
const l = $('Lauf vorbereiten').first().json;
const zeilen = (n) => $(n).all().map((i) => i.json).filter((z) => z && z.id !== undefined);
const sys = zeilen('Systemstatus lesen');
const cron = sys.find((z) => z.schluessel === 'epa04_lauf') || null;
const eigen = sys.find((z) => z.schluessel === '${SCHLUESSEL}') || null;
const pflicht = zeilen('Pflichtfelder lesen');
const configs = {};
for (const a of zeilen('Configs lesen')) {
	const r = configValidator.validiereConfig(a, pflicht.filter((p) => p.kunde_id === a.kunde_id), { zeitzoneGueltig: (zone) => DateTime.now().setZone(zone).isValid });
	if (r.gueltig) configs[a.kunde_id] = r.config;
}
const letzteMails = {};
for (const m of zeilen('Letzte Mail je Kunde lesen')) if (!letzteMails[m.kunde_id] || m.createdAt > letzteMails[m.kunde_id]) letzteMails[m.kunde_id] = m.createdAt;
const test = (name, art, extra = {}) => {
	const r = $(name).first().json || {};
	const status = Number(r.statusCode) || null;
	const meldung = r.error ? String(r.error.message || r.error).slice(0, 160) : status && status !== 200 ? String((r.body && r.body.error && (r.body.error.code || r.body.error.message)) || '').slice(0, 160) : '';
	return { art, ok: status === 200 && !r.error, status, meldung, ...extra };
};
// Alarmziel: Teams (Standard). Nur interne Tests: Zeile "alarmierung" mit alarm_kanal = telegram_test (über EPA-T2).
const alarm = sys.find((z) => z.schluessel === 'alarmierung') || {};
const alarmTest = alarm.alarm_kanal === 'telegram_test' && telegram.istChatId(alarm.telegram_chat_id) && /^[A-Za-z0-9]{8,32}$/.test(String(alarm.telegram_workflow_id || ''));
// Teams nur prüfen, wenn es jemand nutzt (Alarmziel oder ein aktiver Kunde); im reinen Testbetrieb ohne Lizenz sonst täglich ein Fehlalarm.
const teamsGenutzt = !alarmTest || Object.values(configs).some((c) => c.benachrichtigung && c.benachrichtigung.kanal === 'teams');
const verbindungen = teamsGenutzt ? [test('Teams prüfen', 'teams')] : [];
for (const it of $('KI prüfen').all()) {
	const r = it.json || {};
	const status = Number(r.statusCode) || null;
	verbindungen.push({ art: 'llm', ok: status === 200 && !r.error, status, meldung: r.error ? String(r.error.message || r.error).slice(0, 160) : '' });
}
if ($('Postfach prüfen').isExecuted) {
	const auftrag = $('Postfach-Prüfungen').all().map((i) => i.json);
	$('Postfach prüfen').all().forEach((it, i) => {
		const r = it.json || {};
		verbindungen.push({ art: 'postfach', kunde_id: (auftrag[i] || {}).kunde_id, ok: r.ok === true, status: r.status || null, meldung: r.error ? String(r.error.message || r.error).slice(0, 160) : r.meldung || '' });
	});
}
const ergebnis = watchdog.pruefen({ jetzt: l.jetzt, cron, vorgaenge: zeilen('Offene Vorgänge lesen'), configs, letzteMails, fehler: zeilen('Fehlerlog lesen'), verbindungen, fristen });
let letzteOk = null;
try { letzteOk = eigen && eigen.letztes_ergebnis ? JSON.parse(eigen.letztes_ergebnis).ok_gemeldet_am || null : null; } catch (e) { letzteOk = null; }
const melden = watchdog.meldenNoetig(ergebnis, letzteOk, l.jetzt, 'Europe/Berlin', DateTime);
const zeitText = DateTime.fromISO(l.jetzt).setZone('Europe/Berlin').toFormat('dd.LL.yyyy, HH:mm');
return [{ json: { ...ergebnis, melden, letzte_ok: letzteOk, nachricht_html: watchdog.nachricht(ergebnis, zeitText), kanal: alarmTest ? 'telegram_test' : 'teams', chat_id: alarmTest ? String(alarm.telegram_chat_id).trim() : '', telegram_workflow_id: alarmTest ? alarm.telegram_workflow_id : '' } }];
`);
	const melden = wf.node('Melden?', 'n8n-nodes-base.if', [3520, 0], {
		conditions: bedingungen([bedingung('={{ $json.melden }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const welcherKanal = wf.node('Testkanal Telegram?', 'n8n-nodes-base.if', [3740, -80], {
		conditions: bedingungen([bedingung('={{ $json.kanal }}', { type: 'string', operation: 'equals' }, 'telegram_test')]),
		options: {},
	});
	const telegramBetrieb = wf.aufrufDynamisch('Betrieb per Telegram (Test)', [3960, -260], '={{ $json.telegram_workflow_id }}', [
		['chat_id', 'string', '={{ $json.chat_id }}'],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const kanal = wf.node('Betriebskanal benachrichtigen', 'n8n-nodes-base.microsoftTeams', [3960, -80], {
		resource: 'channelMessage',
		operation: 'create',
		teamId: { __rl: true, mode: 'id', value: '<TEAM_ID_ENTWICKLER>' },
		channelId: { __rl: true, mode: 'id', value: '<CHANNEL_ID_ENTWICKLER>' },
		contentType: 'html',
		message: '={{ $json.nachricht_html }}',
		options: { includeLinkToWorkflow: false },
	}, { ...Workflow.retry(), onError: 'continueRegularOutput', alwaysOutputData: true });
	const statusDaten = wf.code('Ergebnis vermerken (Daten)', [4180, 0], [], `
// Nur Codes und Zähler speichern (keine Mail-Inhalte). ok_gemeldet_am steuert den täglichen Heartbeat.
const a = $('Auswerten').first().json;
const tg = $('Betrieb per Telegram (Test)').isExecuted ? ($('Betrieb per Telegram (Test)').first().json || {}) : null;
const gesendet = tg ? tg.gesendet === true && !tg.error : $('Betriebskanal benachrichtigen').isExecuted ? !($('Betriebskanal benachrichtigen').first().json || {}).error : false;
const jetzt = $('Lauf vorbereiten').first().json.jetzt;
const okAm = a.gesamt === 'ok' && gesendet ? jetzt : a.letzte_ok;
return [{ json: {
	schluessel: '${SCHLUESSEL}',
	letzter_lauf: new Date().toISOString(),
	letztes_ergebnis: JSON.stringify({ gesamt: a.gesamt, befunde: a.befunde.map((b) => ({ code: b.code, schwere: b.schwere, kunde_id: b.kunde_id || null, vorgangs_id: b.vorgangs_id || null })), zaehler: a.zaehler, gemeldet: a.melden ? gesendet : null, ok_gemeldet_am: okAm }),
} }];
`);
	const speichern = wf.tabelle('Ergebnis vermerken', [4400, 0], 'upsert', 'epa_system_status', { bedingungen: [['schluessel', 'eq', SCHLUESSEL]] });
	const ergebnis = wf.code('Ergebnis melden', [4620, 0], [], `
const a = $('Auswerten').first().json;
const z = JSON.parse($('Ergebnis vermerken (Daten)').first().json.letztes_ergebnis);
return [{ json: { ergebnis: 'watchdog_' + a.gesamt, befunde: a.befunde.map((b) => b.code), gemeldet: z.gemeldet, nachricht_html: a.nachricht_html } }];
`);

	wf.kette(zeitplan, vorbereiten);
	wf.kette(manuell, vorbereiten);
	wf.kette(vorbereiten, status, vorgaenge, configs, felder, fehler, kunden, letzteMail, teams, kiZiele, ki, auftraege, pruefenNoetig);
	wf.verbinde(pruefenNoetig, postfach, 0);
	wf.verbinde(pruefenNoetig, auswerten, 1);
	wf.kette(postfach, auswerten, melden);
	wf.verbinde(melden, welcherKanal, 0);
	wf.verbinde(melden, statusDaten, 1);
	wf.verbinde(welcherKanal, telegramBetrieb, 0);
	wf.verbinde(welcherKanal, kanal, 1);
	wf.kette(telegramBetrieb, statusDaten);
	wf.kette(kanal, statusDaten, speichern, ergebnis);
	return wf;
};
