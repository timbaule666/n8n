'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mn = require('../src/mailNormalisieren');

const CFG = { postfach: 'anfragen@spedition.de', absender_allowlist: ['@stammkunde.de'], absender_blocklist: ['spam@werbung.de', 'newsletter.example'] };

function mail(extra = {}) {
	return {
		id: 'AAMk1',
		internetMessageId: '<m1@kunde.de>',
		conversationId: 'conv-1',
		subject: 'Transportanfrage',
		from: { emailAddress: { address: 'Max@Kunde.de', name: 'Max Muster' } },
		sender: { emailAddress: { address: 'max@kunde.de', name: 'Max Muster' } },
		replyTo: [],
		receivedDateTime: '2026-10-13T08:00:00Z',
		body: { contentType: 'text', content: 'Hallo,\nbitte Angebot für 2 Paletten.\nGruß Max' },
		internetMessageHeaders: [],
		...extra,
	};
}

test('Betreff normalisieren: mehrfache und gemischte Präfixe, Ticketmarken', () => {
	assert.equal(mn.betreffNormalisieren('AW: WG: Re:  Transport   Hamburg'), 'transport hamburg');
	assert.equal(mn.betreffNormalisieren('RE[2]: [Ticket#123] Anfrage'), 'anfrage');
	assert.equal(mn.betreffNormalisieren('Fwd: SV: Anfrage V-2026-0001'), 'anfrage v-2026-0001');
	assert.equal(mn.betreffNormalisieren(''), '');
	assert.equal(mn.betreffNormalisieren('Reklamation'), 'reklamation'); // "Re" ohne Doppelpunkt bleibt
});

test('Message-IDs aus In-Reply-To und References', () => {
	assert.deepEqual(mn.messageIds('<a@x> <b@y>\n <a@x>'), ['<a@x>', '<b@y>']);
	assert.deepEqual(mn.messageIds(''), []);
	const n = mn.normalisieren(mail({ internetMessageHeaders: [{ name: 'In-Reply-To', value: '<v1@spedition.de>' }, { name: 'References', value: '<v0@kunde.de> <v1@spedition.de>' }] }), CFG);
	assert.deepEqual(n.bezug_message_ids, ['<v1@spedition.de>', '<v0@kunde.de>']);
	assert.equal(n.ist_antwort, true);
});

test('HTML -> Text mit Entities, Listen, Zitatblöcken', () => {
	const t = mn.htmlZuText('<html><head><style>p{}</style></head><body><p>Gr&uuml;&szlig;e&nbsp;aus K&ouml;ln &amp; Bonn</p><ul><li>2 Paletten</li></ul><blockquote>alt</blockquote><script>x()</script></body></html>');
	assert.match(t, /Grüße aus Köln & Bonn/);
	assert.match(t, /- 2 Paletten/);
	assert.match(t, /> alt/);
	assert.doesNotMatch(t, /x\(\)|p\{\}/);
	assert.equal(mn.htmlZuText('&#8364; &#x20AC;'), '€ €');
});

test('Zitate abschneiden: deutsche/englische Muster, Outlook-Kopf, >-Zeilen; Weiterleitung bleibt', () => {
	const fall = (text) => mn.zitateAbschneiden(text).neu;
	assert.equal(fall('Neu\n\nAm 12.10.2026 um 10:00 schrieb Dispo <d@x.de>:\n> alt'), 'Neu');
	assert.equal(fall('Neu\nOn Mon, Oct 12, 2026 at 10:00 AM Dispo\n<d@x.de> wrote:\nalt'), 'Neu');
	assert.equal(fall('Neu\n-----Ursprüngliche Nachricht-----\nVon: x'), 'Neu');
	assert.equal(fall('Neu\n\nVon: Dispo <d@x.de>\nGesendet: Montag\nAn: k@y.de\nBetreff: Anfrage\n\nalt'), 'Neu');
	assert.equal(fall('Neu\n________________________________\nFrom: a'), 'Neu');
	assert.equal(fall('Zeile\n> zitiert\nweiter'), 'Zeile\nweiter');
	assert.equal(fall('Von: Max (nur Signatur)\nTelefon 123'), 'Von: Max (nur Signatur)\nTelefon 123');
	const w = mn.zitateAbschneiden('FYI\n-----Original Message-----\nFrom: k\nGewicht 500 kg', { weiterleitung: true });
	assert.match(w.neu, /Gewicht 500 kg/);
	assert.equal(w.zitat_entfernt, false);
});

test('Normalisierung: Grundfelder, Kleinschreibung, erwähnte Vorgangs-IDs', () => {
	const n = mn.normalisieren(mail({ subject: 'AW: Ihre Anfrage V-2026-0042', body: { contentType: 'html', content: '<p>Gewicht: 500 kg</p><p>Bezug V-2026-0042 und V-2026-0007</p>' } }), CFG);
	assert.equal(n.message_id, '<m1@kunde.de>');
	assert.equal(n.absender_adresse, 'max@kunde.de');
	assert.equal(n.absender_domain, 'kunde.de');
	assert.equal(n.betreff_normalisiert, 'ihre anfrage v-2026-0042');
	assert.deepEqual(n.vorgangs_ids_erwaehnt.sort(), ['V-2026-0007', 'V-2026-0042']);
	assert.equal(n.eigene_mail, false);
	assert.equal(mn.vorpruefung(n), null);
});

test('Sehr lange Mail wird gekürzt', () => {
	const n = mn.normalisieren(mail({ body: { contentType: 'text', content: 'x'.repeat(20000) } }), { ...CFG, anhang_limits: { max_zeichen_text: 1000 } });
	assert.equal(n.text_gekuerzt, true);
	assert.ok(n.text.length < 1100);
});

test('Auto-Replies werden erkannt (Header und Betreff), normale Mails nicht', () => {
	const auto = (extra) => mn.vorpruefung(mn.normalisieren(mail(extra), CFG));
	assert.equal(auto({ internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'auto-replied' }] }).ergebnis, 'auto_antwort');
	assert.equal(auto({ internetMessageHeaders: [{ name: 'Auto-Submitted', value: 'no' }] }), null);
	assert.equal(auto({ subject: 'Automatische Antwort: Transportanfrage' }).ergebnis, 'auto_antwort');
	assert.equal(auto({ subject: 'Out of Office: Anfrage' }).ergebnis, 'auto_antwort');
	assert.equal(auto({ subject: 'AW: Abwesenheitsnotiz' }).ergebnis, 'auto_antwort');
	assert.equal(auto({ subject: 'Undeliverable: Anfrage' }).ergebnis, 'auto_antwort');
	assert.equal(auto({ from: { emailAddress: { address: 'MAILER-DAEMON@mx.de' } } }).ergebnis, 'auto_antwort');
	assert.equal(auto({ subject: 'Abholung Bürobedarf' }), null);
});

test('Eigene Mails, Blockliste, fehlende Message-ID', () => {
	const v = (extra, cfg = CFG) => mn.vorpruefung(mn.normalisieren(mail(extra), cfg));
	assert.equal(v({ from: { emailAddress: { address: 'Anfragen@Spedition.de' } } }).ergebnis, 'eigene_mail');
	assert.equal(v({ internetMessageHeaders: [{ name: 'X-EPA-Vorgang', value: 'V-2026-0001' }] }).ergebnis, 'eigene_mail');
	assert.equal(v({ from: { emailAddress: { address: 'spam@werbung.de' } } }).ergebnis, 'gesperrt');
	assert.equal(v({ from: { emailAddress: { address: 'info@mail.newsletter.example' } } }).ergebnis, 'gesperrt');
	assert.equal(v({ internetMessageId: '' }).ergebnis, 'ungueltig');
	assert.equal(mn.normalisieren(mail({ from: { emailAddress: { address: 'a@stammkunde.de' } } }), CFG).vertrauenswuerdig, true);
});

test('Newsletter-Hinweise aus Headern', () => {
	const n = mn.normalisieren(mail({ internetMessageHeaders: [{ name: 'List-Unsubscribe', value: '<mailto:x>' }, { name: 'Precedence', value: 'bulk' }] }), CFG);
	assert.deepEqual(n.newsletter_hinweise, ['List-Unsubscribe', 'Precedence: bulk']);
	assert.equal(mn.vorpruefung(n), null); // Entscheidung trifft die Klassifizierung
});

test('Spoofing-Basisprüfung', () => {
	const ok = mn.normalisieren(mail({ internetMessageHeaders: [{ name: 'Authentication-Results', value: 'spf=pass; dkim=pass; dmarc=pass' }] }), CFG);
	assert.equal(ok.spoofing.auffaellig, false);
	const n = mn.normalisieren(mail({
		from: { emailAddress: { address: 'chef@kunde.de', name: 'chef@andere-firma.de' } },
		sender: { emailAddress: { address: 'x@boese.example' } },
		replyTo: [{ emailAddress: { address: 'antwort@boese.example' } }],
		internetMessageHeaders: [{ name: 'Authentication-Results', value: 'spf=fail smtp.mailfrom=kunde.de; dkim=none; dmarc=fail' }],
	}), CFG);
	assert.equal(n.spoofing.auffaellig, true);
	assert.deepEqual(n.spoofing.hinweise, ['SPF fail', 'DMARC fail', 'Sender weicht von From ab (im Auftrag gesendet)', 'Reply-To zeigt auf andere Domain', 'Anzeigename enthält eine andere Adresse']);
});

test('Anhänge: Typ, Größe, Inline, leere PDF, Bilder, Textkürzung', () => {
	const MB = 1024 * 1024;
	const a = mn.anhaengeEinordnen([
		{ name: 'auftrag.pdf', contentType: 'application/pdf', size: MB, text: 'Gewicht 500 kg' },
		{ name: 'scan.pdf', contentType: 'application/pdf', size: MB, text: '   ' },
		{ name: 'logo.png', contentType: 'image/png', size: 1000, isInline: true },
		{ name: 'foto.jpg', contentType: 'image/jpeg', size: 2 * MB, bild_data_url: 'data:image/jpeg;base64,AAA' },
		{ name: 'foto2.jpg', contentType: 'image/jpeg', size: 2 * MB },
		{ name: 'tool.exe', contentType: 'application/x-msdownload', size: 10 },
		{ name: 'riesig.pdf', contentType: 'application/pdf', size: 11 * MB, text: 'x' },
		{ name: 'kaputt.pdf', contentType: 'application/pdf', size: 100, status: 'defekt', hinweis: 'PDF nicht lesbar' },
	], { max_mb_je_anhang: 10, max_mb_je_mail: 25, typen: ['application/pdf', 'image/jpeg', 'image/png'] });
	assert.deepEqual(a.map((x) => [x.name, x.status]), [
		['auftrag.pdf', 'ok'], ['scan.pdf', 'ohne_textebene'], ['foto.jpg', 'ok'], ['foto2.jpg', 'nicht_ausgewertet'],
		['tool.exe', 'typ_nicht_erlaubt'], ['riesig.pdf', 'zu_gross'], ['kaputt.pdf', 'defekt'],
	]);
	assert.equal(a[0].text, 'Gewicht 500 kg');
	assert.equal(a[2].bild, true);
	const lang = mn.anhaengeEinordnen([{ name: 'a.pdf', contentType: 'application/pdf', size: 1, text: 'y'.repeat(500) }], { max_zeichen_anhaenge: 100 });
	assert.equal(lang[0].gekuerzt, true);
	const summe = mn.anhaengeEinordnen([1, 2, 3].map((i) => ({ name: `${i}.pdf`, contentType: 'application/pdf', size: 9 * MB, text: 't' })), { max_mb_je_mail: 25 });
	assert.deepEqual(summe.map((x) => x.status), ['ok', 'ok', 'zu_gross']);
});
