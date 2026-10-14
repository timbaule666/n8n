'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

module.exports = function () {
	const wf = new Workflow('EPA SW Benachrichtigen');

	wf.notiz('Notiz Zweck', [-80, -400], [
		'## EPA SW Benachrichtigen',
		'**Zweck:** Info-Meldungen an Mitarbeiter (Teams-Kanal aus der Kunden-Config). Kanal-Adapter: ein Wechsel auf Slack betrifft nur diesen Workflow.',
		'**Nur für interne Tests:** Config benachrichtigung.kanal = "telegram_test" schickt die Meldung stattdessen per Telegram-Bot an chat_id. Kunden nutzen immer Teams.',
		'**Trigger:** Aufruf durch andere Workflows.',
		'**Eingaben:** kunde_id, vorgangs_id, team_id, channel_id, kanal, chat_id, nachricht_html, anlass.',
		'**Ausgabe:** { gesendet, fehler_id }',
		'**Fehler:** Ein Versandfehler bricht die Verarbeitung NICHT ab. Er wird in epa_fehler_log eingetragen (alarmiert_am leer), der Watchdog (M6) meldet ihn an den Entwickler-Kanal.',
		'**Einrichten:** Im Node "Teams-Nachricht senden" das Teams-Credential (OAuth2, delegiert) zuweisen. Der Testkanal ruft "EPA-T2 Telegram senden (Test)" auf (ID in benachrichtigung.telegram_workflow_id).',
	].join('\n'), { breite: 680, hoehe: 320 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['team_id', 'string'],
		['channel_id', 'string'],
		['kanal', 'string'],
		['chat_id', 'string'],
		['telegram_workflow_id', 'string'],
		['nachricht_html', 'string'],
		['anlass', 'string'],
	]);

	const eingabe = wf.code('Eingabe prüfen', [220, 0], ['fehlerklassen', 'telegram'], `
const e = $input.first().json;
const vid = e.vorgangs_id || null;
const kanal = e.kanal === 'telegram_test' ? 'telegram_test' : 'teams';
if (typeof e.nachricht_html !== 'string' || !e.nachricht_html.trim()) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', vid, 'Nachricht fehlt');
if (kanal === 'telegram_test') {
	if (!telegram.istChatId(e.chat_id)) throw fehlerklassen.epaFehler('KONFIGURATIONSFEHLER', vid, 'Telegram-Chat-ID (benachrichtigung.chat_id) fehlt oder ist ungültig');
	if (!/^[A-Za-z0-9]{8,32}$/.test(String(e.telegram_workflow_id || ''))) throw fehlerklassen.epaFehler('KONFIGURATIONSFEHLER', vid, 'benachrichtigung.telegram_workflow_id (ID von "EPA-T2 Telegram senden (Test)") fehlt');
	return [{ json: { ...e, kanal, vorgangs_id: vid, chat_id: String(e.chat_id).trim() } }];
}
if (!e.team_id || !e.channel_id) throw fehlerklassen.epaFehler('KONFIGURATIONSFEHLER', vid, 'Teams-Ziel (team_id/channel_id) fehlt in der Config');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.team_id)) throw fehlerklassen.epaFehler('KONFIGURATIONSFEHLER', vid, 'team_id muss eine GUID sein');
return [{ json: { ...e, kanal, vorgangs_id: vid } }];
`);
	const welcherKanal = wf.node('Testkanal Telegram?', 'n8n-nodes-base.if', [440, 0], {
		conditions: bedingungen([bedingung('={{ $json.kanal }}', { type: 'string', operation: 'equals' }, 'telegram_test')]),
		options: {},
	});
	// Testkanal: eigener Workflow mit dem Telegram-Node, damit Kunden-Workflows kein Telegram-Credential brauchen.
	const telegramSenden = wf.aufrufDynamisch('Telegram-Nachricht senden', [660, -120], '={{ $json.telegram_workflow_id }}', [
		['chat_id', 'string', '={{ $json.chat_id }}'],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const senden = wf.node('Teams-Nachricht senden', 'n8n-nodes-base.microsoftTeams', [660, 80], {
		resource: 'channelMessage',
		operation: 'create',
		teamId: { __rl: true, mode: 'id', value: '={{ $json.team_id }}' },
		channelId: { __rl: true, mode: 'id', value: '={{ $json.channel_id }}' },
		contentType: 'html',
		message: '={{ $json.nachricht_html }}',
		options: { includeLinkToWorkflow: false },
	}, Workflow.retry({ onError: 'continueRegularOutput', alwaysOutputData: true }));

	const pruefen = wf.code('Versand prüfen', [880, 0], ['fehlerklassen'], `
const e = $('Eingabe prüfen').first().json;
const r = $input.first().json || {};
if (!r.error && r.gesendet !== false) return [{ json: { gesendet: true } }];
const node = e.kanal === 'telegram_test' ? 'Telegram-Nachricht senden' : 'Teams-Nachricht senden';
const meldung = r.error ? (typeof r.error === 'string' ? r.error : (r.error.message || 'Versand fehlgeschlagen')) : (r.meldung || 'Versand fehlgeschlagen');
return [{ json: {
	gesendet: false,
	fehler: {
		statuscode: 502, fehlercode: 'UPSTREAM_FEHLER', klasse: 'Upstream', retrybar: true, eskalieren: false,
		workflow_id: String($workflow.id), workflow_name: $workflow.name, node,
		execution_id: String($execution.id), execution_url: null, modus: $execution.mode,
		vorgangs_id: e.vorgangs_id, kunde_id: e.kunde_id || null,
		meldung: fehlerklassen.bereinigeMeldung(\`Meldung "\${e.anlass || '-'}" nicht zugestellt: \${meldung}\`),
		eskaliert: false, alarmiert_am: null,
	},
} }];
`);

	const fehlgeschlagen = wf.node('Versand fehlgeschlagen?', 'n8n-nodes-base.if', [1100, 0], {
		conditions: bedingungen([bedingung('={{ $json.gesendet }}', { type: 'boolean', operation: 'false', singleValue: true })]),
		options: {},
	});
	const fehlerZeile = wf.code('Fehlerlog vorbereiten', [1320, -100], [], `
return [{ json: $input.first().json.fehler }];
`);
	const protokoll = wf.tabelle('Fehler protokollieren', [1540, -100], 'insert', 'epa_fehler_log', {}, { onError: 'continueRegularOutput' });
	const melden = wf.code('Ergebnis melden', [1760, 0], [], `
const v = $('Versand prüfen').first().json;
const p = $('Fehler protokollieren').isExecuted ? $('Fehler protokollieren').first().json : null;
return [{ json: { gesendet: v.gesendet, fehler_id: p && p.id !== undefined ? p.id : null } }];
`);

	wf.kette(trigger, eingabe, welcherKanal);
	wf.verbinde(welcherKanal, telegramSenden, 0);
	wf.verbinde(welcherKanal, senden, 1);
	wf.kette(telegramSenden, pruefen);
	wf.kette(senden, pruefen, fehlgeschlagen);
	wf.verbinde(fehlgeschlagen, fehlerZeile, 0);
	wf.verbinde(fehlgeschlagen, melden, 1);
	wf.kette(fehlerZeile, protokoll, melden);
	return wf;
};
