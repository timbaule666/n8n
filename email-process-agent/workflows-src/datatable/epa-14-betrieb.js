'use strict';
const { Workflow, bedingung, bedingungen, uuid } = require('../../tools/lib/n8n');
const { PFAD, BETREIBER, LINK_TAGE } = require('../../src/betrieb');

const SEITE_HEADER = {
	entries: [
		{ name: 'Content-Type', value: 'text/html; charset=utf-8' },
		{ name: 'Cache-Control', value: 'no-store' },
		{ name: 'Referrer-Policy', value: 'no-referrer' },
		{ name: 'X-Robots-Tag', value: 'noindex' },
		{ name: 'X-Frame-Options', value: 'DENY' },
		{ name: 'X-Content-Type-Options', value: 'nosniff' },
	],
};

module.exports = function () {
	const wf = new Workflow('EPA-14 Betrieb-Dashboard');
	// Seite und Link-Nachricht enthalten den Klartext-Schlüssel bzw. Kundendaten: Erfolgsdaten nicht speichern.
	wf.settings.saveDataSuccessExecution = 'none';

	wf.notiz('Notiz Zweck', [-120, -620], [
		'## EPA-14 Betrieb-Dashboard',
		'**Zweck:** Eine Seite für den Betreiber. Oben der Gesamtzustand (🟢 Alle Systeme normal / 🟡 N Agents benötigen Aufmerksamkeit / 🔴 Kritischer Fehler, mit Grund) und sechs Kennzahlen: aktive Kunden, aktive Agents (aktive Postfach-Verbindungen), Vorgänge heute, Erfolgsquote heute (verarbeitete Mails ohne technischen Fehler), offene Exceptions (Eskaliert, Zuordnung/Klassifizierung unklar), kritische Fehler. Grundlage sind dieselben Prüfungen wie bisher (Verbindungen, Zustelltest, Läufe, Fehler, Sicherheit). Nur lesen.',
		`**Zugang:** geheimer Link …/webhook/${PFAD}?k=<Schlüssel>, gespeichert nur als Hash in epa_uebersicht_zugaenge mit kunde_id "${BETREIBER}". Kunden-Links öffnen dieses Dashboard nicht.`,
		`**Neuer Link:** diesen Workflow manuell starten. Alle bisherigen Dashboard-Links werden gesperrt, der neue (${LINK_TAGE} Tage gültig) kommt per Telegram (Zeile "alarmierung" in epa_system_status). Ohne Telegram steht er im Ergebnis dieser manuellen Ausführung.`,
		'**Trigger:** Webhook GET (muss veröffentlicht sein) bzw. manuell. Keine Credentials nötig.',
	].join('\n'), { breite: 900, hoehe: 340 });

	// ---------------------------------------------------------------- Seite
	const hook = wf.node('Dashboard-Link', 'n8n-nodes-base.webhook', [0, 0], {
		httpMethod: 'GET',
		path: PFAD,
		responseMode: 'responseNode',
		options: {},
	}, { webhookId: uuid('EPA-14', PFAD) });
	const lesen = wf.code('Anfrage lesen', [220, 0], ['uebersicht'], `
const crypto = require('crypto');
const k = String(($input.first().json.query || {}).k || '');
const gueltig = uebersicht.istGueltigesToken(k);
const jetzt = new Date();
// "Heute" in der Zeitzone des Betreibers (Kennzahlen Vorgänge und Erfolgsquote).
const heuteAb = DateTime.fromJSDate(jetzt).setZone('Europe/Berlin').startOf('day').toUTC().toISO();
return [{ json: { hash: gueltig ? uebersicht.tokenHash(crypto, k) : '__ungueltig__', jetzt: jetzt.toISOString(), seit7: new Date(jetzt.getTime() - 7 * 86400000).toISOString(), heuteAb } }];
`);
	const zugang = wf.tabelle('Zugang lesen', [440, 0], 'get', 'epa_uebersicht_zugaenge', { bedingungen: [['schluessel_hash', 'eq', '={{ $json.hash }}']] }, { alwaysOutputData: true });
	const pruefen = wf.code('Zugang prüfen', [660, 0], ['uebersicht'], `
const z = $input.first().json;
const r = uebersicht.zugangPruefen({ zugang: z && z.id !== undefined ? z : null, jetzt: $('Anfrage lesen').first().json.jetzt, betreiber: true });
return [{ json: { ...r, ablauf: r.ok ? z.ablauf : null } }];
`);
	const ok = wf.node('Zugang gültig?', 'n8n-nodes-base.if', [880, 0], {
		conditions: bedingungen([bedingung('={{ $json.ok }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const A = "$('Anfrage lesen').first().json";
	const einmal = { alwaysOutputData: true, executeOnce: true };
	const configs = wf.tabelle('Configs lesen', [1100, -100], 'get', 'epa_config_allgemein', { alle: true }, einmal);
	const felder = wf.tabelle('Pflichtfelder lesen', [1320, -100], 'get', 'epa_config_pflichtfelder', { bedingungen: [['aktiv', 'isTrue']], alle: true }, einmal);
	// Offene Vorgänge (Exceptions, hängende, Fälschungsverdacht) und alle heute angelegten (Kennzahl "Vorgänge heute").
	const vorgaenge = wf.tabelle('Vorgänge lesen', [1540, -100], 'get', 'epa_vorgaenge', {
		bedingungen: [['status', 'neq', 'Abgeschlossen'], ['createdAt', 'gte', `={{ ${A}.heuteAb }}`]],
		match: 'anyCondition',
		alle: true,
	}, einmal);
	// Versandfehler und alle Entscheidungen der letzten 7 Tage (Freigaben nur durch eingetragene Freigeber?).
	const freigaben = wf.tabelle('Freigaben lesen', [1760, -100], 'get', 'epa_freigaben', {
		bedingungen: [['status', 'eq', 'fehler'], ['updatedAt', 'gte', `={{ ${A}.seit7 }}`]],
		match: 'anyCondition',
		alle: true,
	}, einmal);
	const system = wf.tabelle('Systemstatus lesen', [1980, -100], 'get', 'epa_system_status', { alle: true }, einmal);
	const fehler = wf.tabelle('Fehler lesen', [2200, -100], 'get', 'epa_fehler_log', { bedingungen: [['createdAt', 'gte', `={{ ${A}.seit7 }}`]], alle: true }, einmal);
	const zugaenge = wf.tabelle('Zugänge lesen', [2310, -220], 'get', 'epa_uebersicht_zugaenge', { alle: true }, einmal);
	// Verarbeitete Mails der letzten 7 Tage (Letzter Lauf je Agent); Erfolgsquote und Tageszahlen nur von heute.
	const mails = wf.tabelle('Mails lesen', [2420, -220], 'get', 'epa_verarbeitete_mails', { bedingungen: [['createdAt', 'gte', `={{ ${A}.seit7 }}`]], alle: true }, einmal);
	const bauen = wf.code('Dashboard bauen', [2420, -100], ['configValidator', 'betrieb'], `
const a = $('Anfrage lesen').first().json;
const zeilen = (n) => $(n).all().map((i) => i.json).filter((z) => z && z.id !== undefined);
const pflicht = zeilen('Pflichtfelder lesen');
const configs = zeilen('Configs lesen');
const gueltig = {};
for (const c of configs) {
	try { gueltig[c.kunde_id] = configValidator.validiereConfig(c, pflicht.filter((p) => p.kunde_id === c.kunde_id), { zeitzoneGueltig: (zone) => DateTime.now().setZone(zone).isValid }).gueltig === true; } catch (e) { gueltig[c.kunde_id] = false; }
}
const vorgaenge = zeilen('Vorgänge lesen');
// Befunde nur aus offenen Vorgängen; die heute angelegten zählen zusätzlich für "Vorgänge heute".
const offen = vorgaenge.filter((v) => v.status !== 'Abgeschlossen' && v.status !== 'Ignoriert');
const daten = betrieb.auswerten({ configs, gueltig, vorgaenge: offen, freigaben: zeilen('Freigaben lesen'), system: zeilen('Systemstatus lesen'), fehler: zeilen('Fehler lesen'), zugaenge: zeilen('Zugänge lesen'), jetzt: a.jetzt });
const mails = zeilen('Mails lesen');
const agenten = betrieb.agentStatus({ daten, mails, heuteAb: a.heuteAb, jetzt: a.jetzt });
const kopf = betrieb.kennzahlen({ daten, configs, vorgaenge, mails, heuteAb: a.heuteAb, agenten });
return [{ json: { status: 200, html: betrieb.seite({ daten, kopf, agenten, jetzt: a.jetzt, ablauf: $('Zugang prüfen').first().json.ablauf }) } }];
`);
	const abweisen = wf.code('Seite: kein Zugang', [1100, 120], ['uebersicht'], `
const z = $input.first().json;
return [{ json: { status: z.status || 404, html: uebersicht.seiteMeldung(z.status === 410 ? 'Link abgelaufen' : z.status === 403 ? 'Link gesperrt' : 'Link ungültig', 'Einen neuen Link erzeugt der Workflow „EPA-14 Betrieb-Dashboard“ (manuell starten).') } }];
`);
	const antwort = wf.node('Seite ausliefern', 'n8n-nodes-base.respondToWebhook', [2640, 0], {
		respondWith: 'text',
		responseBody: '={{ $json.html }}',
		options: { responseCode: '={{ $json.status }}', responseHeaders: SEITE_HEADER },
	});

	// ---------------------------------------------------------------- Neuer Link (manuell)
	const manuell = wf.node('Neuen Link erzeugen', 'n8n-nodes-base.manualTrigger', [0, 500], {});
	const erzeugen = wf.code('Schlüssel erzeugen', [220, 500], ['uebersicht', 'freigabe', 'betrieb'], `
const crypto = require('crypto');
const jetzt = new Date().toISOString();
const t = uebersicht.tokenErzeugen(crypto);
const zugang = uebersicht.zugangZeile({ kunde_id: betrieb.BETREIBER, hash: t.hash, jetzt, tage: betrieb.LINK_TAGE });
const basis = freigabe.basisUrl($execution.resumeUrl, null);
return [{ json: { jetzt, zugang, link: basis + '/webhook/' + betrieb.PFAD + '?k=' + encodeURIComponent(t.token) } }];
`);
	const sperrDaten = wf.code('Sperrdaten', [440, 500], [], `
return [{ json: { gesperrt_am: $input.first().json.jetzt } }];
`);
	const sperren = wf.tabelle('Alte Links sperren', [660, 500], 'update', 'epa_uebersicht_zugaenge', {
		bedingungen: [['kunde_id', 'eq', BETREIBER], ['gesperrt_am', 'isEmpty']],
	}, { alwaysOutputData: true, executeOnce: true });
	const neuDaten = wf.code('Neuer Zugang', [880, 500], [], `
return [{ json: $('Schlüssel erzeugen').first().json.zugang }];
`, { executeOnce: true });
	const speichern = wf.tabelle('Zugang speichern', [1100, 500], 'insert', 'epa_uebersicht_zugaenge');
	const ziel = wf.tabelle('Alarmziel lesen', [1320, 500], 'get', 'epa_system_status', { bedingungen: [['schluessel', 'eq', 'alarmierung']] }, { alwaysOutputData: true });
	const nachricht = wf.code('Nachricht vorbereiten', [1540, 500], ['telegram', 'betrieb'], `
if ($('Zugang speichern').first().json.id === undefined) throw new Error('Neuer Zugang wurde nicht gespeichert');
const z = $input.all().map((i) => i.json).find((r) => r && r.schluessel === 'alarmierung') || {};
const s = $('Schlüssel erzeugen').first().json;
const telegramOk = z.alarm_kanal === 'telegram_test' && telegram.istChatId(z.telegram_chat_id) && /^[A-Za-z0-9]{8,32}$/.test(String(z.telegram_workflow_id || ''));
return [{ json: { telegram: telegramOk, chat_id: telegramOk ? String(z.telegram_chat_id).trim() : '', telegram_workflow_id: telegramOk ? z.telegram_workflow_id : '', nachricht_html: betrieb.linkNachricht({ link: s.link, ablauf: s.zugang.ablauf }) } }];
`);
	const perTelegram = wf.node('Per Telegram?', 'n8n-nodes-base.if', [1760, 500], {
		conditions: bedingungen([bedingung('={{ $json.telegram }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const senden = wf.aufrufDynamisch('Link per Telegram senden', [1980, 420], '={{ $json.telegram_workflow_id }}', [
		['chat_id', 'string', '={{ $json.chat_id }}'],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const ergebnis = wf.code('Ergebnis', [2200, 500], [], `
const s = $('Schlüssel erzeugen').first().json;
const gesendet = $('Link per Telegram senden').isExecuted && ($('Link per Telegram senden').first().json || {}).gesendet === true;
// Ohne Telegram steht der Link nur hier (manuelle Ausführung, nur für n8n-Benutzer sichtbar).
return [{ json: gesendet ? { ergebnis: 'link_per_telegram_gesendet', gueltig_bis: s.zugang.ablauf } : { ergebnis: 'link_nicht_gesendet', link: s.link, gueltig_bis: s.zugang.ablauf } }];
`, { executeOnce: true });

	wf.kette(hook, lesen, zugang, pruefen, ok);
	wf.verbinde(ok, configs, 0);
	wf.verbinde(ok, abweisen, 1);
	wf.kette(configs, felder, vorgaenge, freigaben, system, fehler, zugaenge, mails, bauen, antwort);
	wf.kette(abweisen, antwort);
	wf.kette(manuell, erzeugen, sperrDaten, sperren, neuDaten, speichern, ziel, nachricht, perTelegram);
	wf.verbinde(perTelegram, senden, 0);
	wf.verbinde(perTelegram, ergebnis, 1);
	wf.kette(senden, ergebnis);
	return wf;
};
