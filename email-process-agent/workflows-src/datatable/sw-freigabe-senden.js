'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');


module.exports = function () {
	const wf = new Workflow('EPA SW Freigabe senden');
	// Härtung (M6): Erfolgreiche Ausführungen enthalten Klartext-Links bzw. Mail-Text und werden nicht gespeichert.
	wf.settings.saveDataSuccessExecution = 'none';

	wf.notiz('Notiz Zweck', [-80, -420], [
		'## EPA SW Freigabe senden',
		'**Zweck:** Schickt einem Freigeber seinen persönlichen Freigabe-Link als Teams-Nachricht im 1:1-Chat (Variante B, Bauplan 6). Der Link geht nur an diese Person, nicht in einen Kanal.',
		'**Trigger:** Aufruf durch EPA-02 (je Freigeber ein Aufruf).',
		'**Eingaben:** kunde_id, vorgangs_id, freigeber (E-Mail/UPN), kanal, chat_id, nachricht_html.',
		'**Nur für interne Tests:** kanal = "telegram_test" schickt den Link über "EPA-T2 Telegram senden (Test)" an chat_id (Zuordnung je Freigeber in benachrichtigung.freigeber_chat_ids, sonst benachrichtigung.chat_id). Kunden nutzen immer Teams.',
		'**Ausgabe:** { gesendet, fehler_id }. Ein Fehler bricht nichts ab; er landet im Fehlerlog, EPA-02 meldet dann im Kanal, dass die Freigabe nicht zugestellt wurde.',
		'**Teams je Kunde:** Der Chat läuft über die Postfach-Kopie des Kunden (Aktion teams_chat). Dort steckt das Teams-Credential aus dem Tenant des Kunden; Agent-Konto und Freigeber müssen in diesem Tenant zwei verschiedene Benutzer sein.',
		'**Einrichten:** nichts.',
	].join('\n'), { breite: 700, hoehe: 320 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['freigeber', 'string'],
		['kanal', 'string'],
		['chat_id', 'string'],
		['telegram_workflow_id', 'string'],
		['nachricht_html', 'string'],
	]);
	const eingabe = wf.code('Eingabe prüfen', [220, 0], ['fehlerklassen', 'telegram'], `
const e = $input.first().json;
const vid = e.vorgangs_id || null;
const kanal = e.kanal === 'telegram_test' ? 'telegram_test' : 'teams';
if (!/^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$/.test(String(e.freigeber || ''))) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', vid, 'freigeber ist keine gültige Adresse');
if (typeof e.nachricht_html !== 'string' || !e.nachricht_html.trim()) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', vid, 'Nachricht fehlt');
const basis = { ...e, kanal, vorgangs_id: vid, freigeber: e.freigeber.trim().toLowerCase() };
if (kanal !== 'telegram_test') return [{ json: basis }];
// Ohne gültige Chat-ID: nicht abbrechen, sondern wie ein Zustellfehler behandeln (EPA-02 warnt dann im Kanal).
const wfOk = /^[A-Za-z0-9]{8,32}$/.test(String(e.telegram_workflow_id || ''));
return [{ json: { ...basis, chat_id: telegram.istChatId(e.chat_id) && wfOk ? String(e.chat_id).trim() : '' } }];
`);
	const welcherKanal = wf.node('Testkanal Telegram?', 'n8n-nodes-base.if', [440, 0], {
		conditions: bedingungen([bedingung('={{ $json.kanal }}', { type: 'string', operation: 'equals' }, 'telegram_test')]),
		options: {},
	});
	// Testkanal: eigener Workflow mit dem Telegram-Node, damit Kunden-Workflows kein Telegram-Credential brauchen.
	const telegramSenden = wf.aufrufDynamisch('Telegram-Link senden', [660, -160], "={{ $json.chat_id ? $json.telegram_workflow_id : 'keineId0' }}", [
		['chat_id', 'string', '={{ $json.chat_id }}'],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const kunde = wf.tabelle('Kunde lesen', [660, 80], 'get', 'epa_config_allgemein', {
		bedingungen: [['kunde_id', 'eq', "={{ $json.kunde_id || '__kein_kunde__' }}"]],
	}, { alwaysOutputData: true });
	const chat = wf.aufrufDynamisch('Freigabe-Chat senden', [880, 80], "={{ /^[A-Za-z0-9]{8,32}$/.test(String($json.postfach_workflow_id || '')) ? $json.postfach_workflow_id : 'keineId0' }}", [
		['aktion', 'string', 'teams_chat'],
		['postfach', 'string', '={{ $json.postfach }}'],
		['graph_id', 'string', ''],
		['internet_message_id', 'string', ''],
		['entwurf_id', 'string', ''],
		['freigabe_id', 'string', ''],
		['vorgangs_id', 'string', "={{ $('Eingabe prüfen').first().json.vorgangs_id || '' }}"],
		['html', 'string', "={{ $('Eingabe prüfen').first().json.nachricht_html }}"],
		['empfaenger', 'string', "={{ $('Eingabe prüfen').first().json.freigeber }}"],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });

	const pruefen = wf.code('Zustellung prüfen', [1320, 0], ['fehlerklassen'], `
const e = $('Eingabe prüfen').first().json;
const schritte = e.kanal === 'telegram_test' ? ['Telegram-Link senden'] : ['Freigabe-Chat senden'];
let fehler = e.kanal === 'telegram_test' && !e.chat_id ? 'keine gültige Telegram-Chat-ID bzw. telegram_workflow_id für diesen Freigeber' : null;
for (const s of fehler ? [] : schritte) {
	if (!$(s).isExecuted) { fehler = fehler || s + ' nicht ausgeführt'; continue; }
	const j = $(s).first().json || {};
	const ok = j.gesendet === true;
	if (j.error || !ok) { fehler = s + ': ' + (j.error ? (j.error.message || String(j.error)) : (j.meldung || 'keine ID')); break; }
}
if (!fehler) return [{ json: { gesendet: true } }];
return [{ json: {
	gesendet: false,
	fehler: {
		statuscode: 502, fehlercode: 'UPSTREAM_FEHLER', klasse: 'Upstream', retrybar: true, eskalieren: false,
		workflow_id: String($workflow.id), workflow_name: $workflow.name, node: 'Freigabe-Nachricht', execution_id: String($execution.id),
		execution_url: null, modus: $execution.mode, vorgangs_id: e.vorgangs_id, kunde_id: e.kunde_id || null,
		meldung: fehlerklassen.bereinigeMeldung('Freigabe-Link nicht zugestellt: ' + fehler), eskaliert: false, alarmiert_am: null,
	},
} }];
`);
	const fehlgeschlagen = wf.node('Zustellung fehlgeschlagen?', 'n8n-nodes-base.if', [1540, 0], {
		conditions: bedingungen([bedingung('={{ $json.gesendet }}', { type: 'boolean', operation: 'false', singleValue: true })]),
		options: {},
	});
	const zeile = wf.code('Fehlerlog vorbereiten', [1760, -100], [], `
return [{ json: $input.first().json.fehler }];
`);
	const protokoll = wf.tabelle('Fehler protokollieren', [1980, -100], 'insert', 'epa_fehler_log', {}, { onError: 'continueRegularOutput' });
	const melden = wf.code('Ergebnis melden', [2200, 0], [], `
const p = $('Fehler protokollieren').isExecuted ? $('Fehler protokollieren').first().json : null;
return [{ json: { gesendet: $('Zustellung prüfen').first().json.gesendet, fehler_id: p && p.id !== undefined ? p.id : null } }];
`);

	wf.kette(trigger, eingabe, welcherKanal);
	wf.verbinde(welcherKanal, telegramSenden, 0);
	wf.verbinde(welcherKanal, kunde, 1);
	wf.kette(telegramSenden, pruefen);
	wf.kette(kunde, chat, pruefen, fehlgeschlagen);
	wf.verbinde(fehlgeschlagen, zeile, 0);
	wf.verbinde(fehlgeschlagen, melden, 1);
	wf.kette(zeile, protokoll, melden);
	return wf;
};
