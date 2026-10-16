'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tg = require('../src/telegram');
const fk = require('../src/fehlerklassen');

test('Teams-HTML wird zu Telegram-HTML: Umbrüche, Listen, erlaubte Tags, Links', () => {
	const ein = '<p>Vorgang <b>EPA-1</b> bereit.</p><ul><li>Start: Köln</li><li>Ziel: <i>München</i></li></ul>Link: <a href="https://x.example/f?t=1&amp;a=2">öffnen</a><br>Ende';
	assert.equal(tg.htmlZuTelegram(ein), 'Vorgang <b>EPA-1</b> bereit.\n\n• Start: Köln\n• Ziel: <i>München</i>\n\nLink: <a href="https://x.example/f?t=1&amp;a=2">öffnen</a>\nEnde');
	assert.equal(tg.htmlZuTelegram('<strong>a</strong> <em>b</em>'), '<b>a</b> <i>b</i>');
	assert.equal(tg.htmlZuTelegram('<b>Kopf</b><ul><li>eins</li><li>zwei</li></ul>'), '<b>Kopf</b>\n• eins\n• zwei');
	assert.equal(tg.htmlZuTelegram('<span style="x">a</span><div>b</div><table><tr><td>c</td><td>d</td></tr></table>'), 'ab\nc d');
});

test('Unsichere oder unbekannte Inhalte werden entschärft', () => {
	assert.equal(tg.htmlZuTelegram('<a href="javascript:alert(1)">x</a>'), 'x');
	assert.equal(tg.htmlZuTelegram('<script>böse()</script>ok'), 'ok');
	assert.equal(tg.htmlZuTelegram('A & B &nbsp;&uuml; &lt;c&gt; &#39;'), 'A &amp; B  &amp;uuml; &lt;c&gt; &#39;');
	assert.equal(tg.htmlZuTelegram('<constructor>x</constructor>'), 'x');
	assert.equal(tg.htmlZuTelegram(null), '');
});

test('Echte Meldung aus dem Fehler-Handler bleibt lesbar', () => {
	const html = fk.alarmHtml({ statuscode: 502, fehlercode: 'UPSTREAM_FEHLER', klasse: 'Upstream', workflow_name: 'EPA-01 <x>', node: 'n', vorgangs_id: 'EPA-1', meldung: 'a & b', retrybar: true, execution_url: 'https://n8n.example/e/1', execution_id: '1' });
	const t = tg.htmlZuTelegram(html);
	assert.match(t, /^🚨 <b>Systemfehler: a &amp; b<\/b>\n/);
	assert.match(t, /Grund: a &amp; b/);
	assert.match(t, /Technik: EPA-01 &lt;x&gt; · n · EPA-Fehler 502 UPSTREAM_FEHLER \(Upstream\)/);
	assert.match(t, /<a href="https:\/\/n8n.example\/e\/1">Ausführung 1 öffnen<\/a>$/);
	assert.doesNotMatch(t, /<br>/);
});

test('Zu lange Meldungen werden ohne Formatierung gekürzt (höchstens 4096 Zeichen)', () => {
	const t = tg.htmlZuTelegram('<b>Kopf</b><br>' + 'x &amp; y '.repeat(1000));
	assert.ok(t.length <= tg.MAX_LAENGE, String(t.length));
	assert.match(t, /^Kopf\nx &amp; y/);
	assert.match(t, /… \(gekürzt\)$/);
	assert.doesNotMatch(t, /<b>/);
	assert.doesNotMatch(t, /&[a-z#0-9]*\n… \(gekürzt\)$/i, 'keine halbe Entität am Ende');
});

test('Chat-IDs und Zuordnung je Freigeber', () => {
	for (const ok of ['123456789', '-1001234567890', '@epa_testkanal']) assert.equal(tg.istChatId(ok), true, ok);
	for (const nein of ['', 'abc', '12', '@ab', '<CHAT_ID>']) assert.equal(tg.istChatId(nein), false, nein);
	const b = { chat_id: '111', freigeber_chat_ids: { 'chef@firma.de': '222' } };
	assert.equal(tg.chatFuerFreigeber(b, 'Chef@Firma.de'), '222');
	assert.equal(tg.chatFuerFreigeber(b, 'andere@firma.de'), '111');
	assert.equal(tg.chatFuerFreigeber({}, 'x@y.de'), '');
});
