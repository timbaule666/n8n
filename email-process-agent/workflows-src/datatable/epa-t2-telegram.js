'use strict';
const { Workflow } = require('../../tools/lib/n8n');

// NUR für interne Tests ohne Microsoft-365-Lizenz. Kunden nutzen immer Teams; dieser Workflow wird bei Kunden
// weder gebraucht noch veröffentlicht. Er kapselt den Telegram-Node, damit kein Kunden-Workflow ein
// Telegram-Credential braucht.
module.exports = function () {
	const wf = new Workflow('EPA-T2 Telegram senden (Test)');
	// Nachrichten können Freigabe-Links enthalten: keine Erfolgsdaten speichern.
	wf.settings.saveDataSuccessExecution = 'none';

	wf.notiz('Notiz Zweck', [-80, -400], [
		'## EPA-T2 Telegram senden (Test)',
		'**Nur für interne Tests, nicht für Kunden.** Ersetzt Teams, wenn in der Config benachrichtigung.kanal = "telegram_test" steht (bzw. im Systemstatus "alarmierung" für EPA-05/EPA-06).',
		'**Trigger:** Aufruf durch EPA SW Benachrichtigen, EPA SW Freigabe senden, EPA-05 und EPA-06.',
		'**Eingaben:** chat_id, nachricht_html (Teams-HTML; wird in das Telegram-Format umgesetzt).',
		'**Ausgabe:** { gesendet, meldung }. Wirft keinen Fehler; der Aufrufer entscheidet.',
		'**Einrichten:** Bot bei @BotFather anlegen, Telegram-Credential (Bot-Token) im Node "Telegram senden" zuweisen, dem Bot einmal schreiben, Chat-ID in die Config. Die ID dieses Workflows gehört in benachrichtigung.telegram_workflow_id.',
	].join('\n'), { breite: 700, hoehe: 320 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [['chat_id', 'string'], ['nachricht_html', 'string']]);
	const vorbereiten = wf.code('Text vorbereiten', [220, 0], ['telegram'], `
const e = $input.first().json;
const chat = String(e.chat_id ?? '').trim();
if (!telegram.istChatId(chat)) return [{ json: { ok: false, meldung: 'Telegram-Chat-ID fehlt oder ist ungültig' } }];
const text = telegram.htmlZuTelegram(e.nachricht_html);
if (!text) return [{ json: { ok: false, meldung: 'Nachricht fehlt' } }];
return [{ json: { ok: true, chat_id: chat, text } }];
`);
	const senden = wf.node('Telegram senden', 'n8n-nodes-base.telegram', [440, 0], {
		resource: 'message',
		operation: 'sendMessage',
		chatId: '={{ $json.chat_id }}',
		text: '={{ $json.text }}',
		additionalFields: { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true },
	}, Workflow.retry({ onError: 'continueRegularOutput', alwaysOutputData: true }));
	const ergebnis = wf.code('Ergebnis melden', [660, 0], [], `
const v = $('Text vorbereiten').first().json;
if (!v.ok) return [{ json: { gesendet: false, meldung: v.meldung } }];
const r = $input.first().json || {};
const id = r.result ? r.result.message_id : r.message_id;
if (!r.error && id) return [{ json: { gesendet: true, meldung: '' } }];
const m = r.error ? (typeof r.error === 'string' ? r.error : (r.error.message || 'Telegram-Fehler')) : 'keine Bestätigung von Telegram';
return [{ json: { gesendet: false, meldung: String(m).slice(0, 200) } }];
`);
	wf.kette(trigger, vorbereiten, senden, ergebnis);
	return wf;
};
