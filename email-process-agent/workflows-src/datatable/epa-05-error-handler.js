'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

module.exports = function () {
	const wf = new Workflow('EPA-05 Error-Handler');

	wf.notiz('Notiz Zweck', [-80, -420], [
		'## EPA-05 Error-Handler',
		'**Zweck:** Fängt Abstürze aller EPA-Workflows. Bestimmt Fehlerklasse und Statuscode (src/fehlerklassen.js), schreibt die Data Table epa_fehler_log (nur IDs, Codes, bereinigte technische Meldung, keine Mail-Inhalte), sichert betroffene Vorgänge auf "Eskaliert / Manuell" (nicht bei Versionskonflikt, Sperre, Duplikat) und alarmiert den Entwickler-Kanal in Teams.',
		'**Trigger:** Error Trigger. In **jedem** EPA-Workflow unter Settings -> Error workflow eintragen (macht tools/deploy.js automatisch). Muss veröffentlicht sein.',
		'**Eingaben:** execution/workflow-Daten des fehlgeschlagenen Laufs.',
		'**Ausgabe:** Teams-Nachricht; epa_fehler_log.alarmiert_am wird gesetzt. Bleibt alarmiert_am leer, meldet der Watchdog (M6) den Fehler erneut.',
		'**Einrichten:** Im Node "Entwickler-Kanal alarmieren" Team (GUID) und Kanal auswählen bzw. eintragen und das Teams-Credential (Dienstkonto, OAuth2) zuweisen. Nur interne Tests: Zeile "alarmierung" in epa_system_status mit alarm_kanal = telegram_test leitet den Alarm über EPA-T2 an Telegram.',
	].join('\n'), { breite: 700, hoehe: 340 });

	const trigger = wf.node('Bei Workflow-Fehler', 'n8n-nodes-base.errorTrigger', [0, 0], {});

	const klassifizieren = wf.code('Fehler klassifizieren', [220, 0], ['fehlerklassen'], `
const eintrag = fehlerklassen.ausErrorTrigger($input.first().json);
return [{ json: eintrag }];
`);

	// Fällt der Speicher aus, soll der Alarm trotzdem rausgehen.
	const protokollieren = wf.tabelle('Fehler protokollieren', [1320, 0], 'insert', 'epa_fehler_log', {},
		{ onError: 'continueRegularOutput', alwaysOutputData: true });

	const K = "$('Fehler klassifizieren').first().json";
	// Ein Eingang, dessen Verarbeitung abgebrochen ist, gilt nicht mehr als "in Arbeit": eine erneute Ausführung
	// derselben Mail wird dann nicht als Duplikat verworfen (src/eingang.js dedupeEntscheiden).
	const freigabeDaten = wf.code('Eingang-Freigabe vorbereiten', [440, 0], [], `
return [{ json: { status: 'fehler' } }];
`);
	const freigeben = wf.tabelle('Eingang freigeben', [660, 0], 'update', 'epa_verarbeitete_mails', {
		match: 'anyCondition',
		bedingungen: [
			['execution_id', 'eq', `={{ ${K}.execution_id || '__keine__' }}`],
			['aufrufer_execution_id', 'eq', `={{ ${K}.execution_id || '__keine__' }}`],
		],
	}, { onError: 'continueRegularOutput', alwaysOutputData: true });
	const noetig = wf.node('Vorgang sichern nötig?', 'n8n-nodes-base.if', [1540, 0], {
		conditions: bedingungen([bedingung(`={{ ${K}.eskalieren }}`, { type: 'boolean', operation: 'true', singleValue: true })]),
		options: { looseTypeValidation: true },
	});

	const mandant = wf.tabelle('Mandant ermitteln', [1760, -140], 'get', 'epa_vorgaenge', {
		bedingungen: [['vorgangs_id', 'eq', `={{ ${K}.vorgangs_id }}`]],
	}, { onError: 'continueRegularOutput', alwaysOutputData: true });

	// Nur sichern, was es gibt: ohne Vorgang (oder ohne kunde_id) würde "Status setzen" selbst fehlschlagen.
	const gefunden = wf.node('Vorgang gefunden?', 'n8n-nodes-base.if', [1980, -140], {
		conditions: bedingungen([bedingung('={{ $json.kunde_id }}', { type: 'string', operation: 'notEmpty', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	const sichern = wf.aufruf('Vorgang sichern', [2200, -240], 'EPA SW Status setzen', [
		['kunde_id', 'string', '={{ $json.kunde_id }}'],
		['vorgangs_id', 'string', `={{ ${K}.vorgangs_id }}`],
		['neuer_status', 'string', 'Eskaliert / Manuell'],
		['ausloeser', 'string', 'System'],
		['details', 'object', `={{ { grund: 'Technischer Fehler', fehlercode: ${K}.fehlercode, execution_id: ${K}.execution_id } }}`],
		['referenz', 'string', `={{ 'fehler:' + (${K}.execution_id || '') }}`],
		['erwartete_version', 'number', '={{ null }}'],
		['nur_wenn_erlaubt', 'boolean', '={{ true }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });

	const eskDaten = wf.code('Eskalation vorbereiten', [2420, -240], [], `
return [{ json: { eskaliert: $input.first().json.ok === true } }];
`);
	const P = "$('Fehler protokollieren').first().json";
	const eskVermerken = wf.tabelle('Eskalation vermerken', [2640, -240], 'update', 'epa_fehler_log', {
		bedingungen: [['id', 'eq', `={{ ${P}.id ?? -1 }}`]],
	}, { onError: 'continueRegularOutput', alwaysOutputData: true });

	const vorbereiten = wf.code('Alarm vorbereiten', [2640, 0], ['fehlerklassen'], `
const e = ${K};
const protokoll = ${P};
let eskaliert = false;
let hinweis = '';
if (e.vorgangs_id && !e.eskalieren) {
	hinweis = fehlerklassen.OHNE_SICHERUNG_AUS.includes(String(e.workflow_name || '').replace(/\\s*\\*$/, ''))
		? 'Vorgang nicht automatisch gesichert (Fehler beim Statuswechsel selbst), bitte manuell prüfen.'
		: 'Vorgang bewusst nicht eskaliert (Konflikt mit parallel laufender Verarbeitung).';
} else if ($('Mandant ermitteln').isExecuted && !$('Vorgang sichern').isExecuted) {
	hinweis = 'Vorgang nicht gefunden, daher nicht gesichert.';
} else if ($('Vorgang sichern').isExecuted) {
	const s = $('Vorgang sichern').first().json;
	eskaliert = s.ok === true;
	if (s.error) hinweis = 'Vorgang konnte NICHT gesichert werden, bitte manuell prüfen.';
	else if (s.uebersprungen) hinweis = \`Vorgang nicht geändert (Status "\${s.alter_status}").\`;
	else if (eskaliert) hinweis = 'Vorgang wurde auf "Eskaliert / Manuell" gesetzt.';
}
const fehlerId = protokoll && protokoll.id !== undefined ? protokoll.id : null;
let html = fehlerklassen.alarmHtml(e);
if (hinweis) html += '<br>' + fehlerklassen.escapeHtml(hinweis);
if (!fehlerId) html += '<br><b>Achtung:</b> Eintrag im Fehlerlog fehlgeschlagen (Data Table prüfen).';
return [{ json: { fehler_id: fehlerId, eskaliert, alarm_html: html } }];
`);

	const teams = wf.node('Entwickler-Kanal alarmieren', 'n8n-nodes-base.microsoftTeams', [3520, 0], {
		resource: 'channelMessage',
		operation: 'create',
		teamId: { __rl: true, mode: 'id', value: '<TEAM_ID_ENTWICKLER>' },
		channelId: { __rl: true, mode: 'id', value: '<CHANNEL_ID_ENTWICKLER>' },
		contentType: 'html',
		message: '={{ $json.alarm_html }}',
		options: { includeLinkToWorkflow: false },
	}, Workflow.retry());

	// Alarmziel: Teams (Standard, Kunden). Nur für interne Tests kann die Zeile "alarmierung" in epa_system_status
	// alarm_kanal = "telegram_test" mit telegram_chat_id und telegram_workflow_id (EPA-T2) setzen.
	const zielLesen = wf.tabelle('Alarmziel lesen', [2860, -200], 'get', 'epa_system_status', {
		bedingungen: [['schluessel', 'eq', 'alarmierung']],
	}, { alwaysOutputData: true, onError: 'continueRegularOutput' });
	const ziel = wf.code('Alarmziel', [3080, -200], ['telegram'], `
const z = $input.all().map((i) => i.json).find((r) => r && r.schluessel === 'alarmierung') || {};
const html = $('Alarm vorbereiten').first().json.alarm_html;
const test = z.alarm_kanal === 'telegram_test' && telegram.istChatId(z.telegram_chat_id) && /^[A-Za-z0-9]{8,32}$/.test(String(z.telegram_workflow_id || ''));
return [{ json: { kanal: test ? 'telegram_test' : 'teams', chat_id: test ? String(z.telegram_chat_id).trim() : '', telegram_workflow_id: test ? z.telegram_workflow_id : '', alarm_html: html } }];
`);
	const welcherKanal = wf.node('Testkanal Telegram?', 'n8n-nodes-base.if', [3300, -200], {
		conditions: bedingungen([bedingung('={{ $json.kanal }}', { type: 'string', operation: 'equals' }, 'telegram_test')]),
		options: {},
	});
	const telegramAlarm = wf.aufrufDynamisch('Alarm per Telegram (Test)', [3520, -300], '={{ $json.telegram_workflow_id }}', [
		['chat_id', 'string', '={{ $json.chat_id }}'],
		['nachricht_html', 'string', '={{ $json.alarm_html }}'],
	]);
	// Wie beim Teams-Node: Ein nicht zugestellter Alarm lässt EPA-05 fehlschlagen, alarmiert_am bleibt leer,
	// der Watchdog meldet den Fehler erneut.
	const telegramPruefen = wf.code('Telegram-Alarm prüfen', [3740, -300], [], `
const r = $input.first().json || {};
if (r.gesendet !== true) throw new Error('Alarm per Telegram nicht zugestellt: ' + String(r.meldung || 'unbekannt').slice(0, 200));
return [{ json: { gesendet: true } }];
`);

	const A = "$('Alarm vorbereiten').first().json";
	const vorhanden = wf.node('Fehler-ID vorhanden?', 'n8n-nodes-base.if', [3960, 0], {
		conditions: bedingungen([bedingung(`={{ ${A}.fehler_id }}`, { type: 'number', operation: 'exists', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	const alarmDaten = wf.code('Alarmzeit vorbereiten', [4180, -80], [], `
return [{ json: { alarmiert_am: new Date().toISOString() } }];
`);
	const alarmVermerken = wf.tabelle('Alarm vermerken', [4400, -80], 'update', 'epa_fehler_log', {
		bedingungen: [['id', 'eq', `={{ ${A}.fehler_id }}`]],
	});

	// Ein Fehler in einem Sub-Workflow löst EPA-05 zweimal aus: im Sub-Workflow selbst und im Aufrufer, dessen
	// Execute-Workflow-Node den Fehler weiterreicht (erkennbar an error.executionId der Unter-Ausführung).
	// Protokoll und Alarm nur für den ursprünglichen Fehler; den Eingang gibt auch der Aufrufer frei.
	const eigener = wf.node('Ursprünglicher Fehler?', 'n8n-nodes-base.if', [880, 0], {
		conditions: bedingungen([bedingung("={{ ($('Bei Workflow-Fehler').first().json.execution || {}).error?.executionId }}", { type: 'string', operation: 'empty', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	wf.kette(trigger, klassifizieren, freigabeDaten, freigeben, eigener);
	const uebernehmen = wf.code('Fehlereintrag übernehmen', [1100, 0], [], `
return [{ json: $('Fehler klassifizieren').first().json }];
`);
	wf.verbinde(eigener, uebernehmen, 0);
	wf.kette(uebernehmen, protokollieren, noetig);
	wf.verbinde(noetig, mandant, 0);
	wf.verbinde(noetig, vorbereiten, 1);
	wf.kette(mandant, gefunden);
	wf.verbinde(gefunden, sichern, 0);
	wf.verbinde(gefunden, vorbereiten, 1);
	wf.kette(sichern, eskDaten, eskVermerken, vorbereiten);
	wf.kette(vorbereiten, zielLesen, ziel, welcherKanal);
	wf.verbinde(welcherKanal, telegramAlarm, 0);
	wf.verbinde(welcherKanal, teams, 1);
	wf.kette(telegramAlarm, telegramPruefen, vorhanden);
	wf.kette(teams, vorhanden);
	wf.verbinde(vorhanden, alarmDaten, 0);
	wf.kette(alarmDaten, alarmVermerken);
	return wf;
};
