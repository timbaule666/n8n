'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const f = require('../src/freigabe');

test('Token: 256 Bit, base64url, nur Hash wird gespeichert', () => {
	const a = f.tokenErzeugen(crypto);
	const b = f.tokenErzeugen(crypto);
	assert.ok(f.istGueltigesToken(a.token));
	assert.notEqual(a.token, b.token);
	assert.equal(a.hash, crypto.createHash('sha256').update(a.token).digest('hex'));
	assert.equal(a.hash.length, 64);
	assert.ok(!a.hash.includes(a.token));
	assert.equal(f.istGueltigesToken('kurz'), false);
	assert.equal(f.istGueltigesToken(a.token + '!'), false);
	assert.match(f.freigabeIdErzeugen(crypto), /^F-[0-9a-f-]{36}$/);
});

test('Basis-URL aus resumeUrl, Override und Link', () => {
	assert.equal(f.basisUrl('https://timbaule.app.n8n.cloud/webhook-waiting/123'), 'https://timbaule.app.n8n.cloud');
	assert.equal(f.basisUrl('http://127.0.0.1:5678/webhook-waiting/9'), 'http://127.0.0.1:5678');
	assert.equal(f.basisUrl('', 'https://n8n.firma.de/'), 'https://n8n.firma.de');
	assert.throws(() => f.basisUrl('kaputt'));
	assert.equal(f.link('https://x.de', 'ab_c'), 'https://x.de/webhook/epa-freigabe?t=ab_c');
});

const JETZT = '2026-10-13T10:00:00Z';
const ok = { token: { id: 1, verbraucht_am: null }, freigabe: { id: 2, status: 'offen', ablauf: '2026-10-15T10:00:00Z' }, freigeberErlaubt: true, jetzt: JETZT };

test('Freigabe prüfen: gültig, unbekannt, verbraucht, entschieden, abgelaufen, nicht berechtigt', () => {
	assert.deepEqual(f.freigabePruefen(ok), { ok: true });
	assert.equal(f.freigabePruefen({ ...ok, token: null }).status, 404);
	assert.equal(f.freigabePruefen({ ...ok, freigabe: {} }).status, 404);
	assert.equal(f.freigabePruefen({ ...ok, token: { id: 1, verbraucht_am: JETZT } }).status, 409);
	const gesendet = f.freigabePruefen({ ...ok, freigabe: { ...ok.freigabe, status: 'gesendet', entscheider: 'a@b.de' } });
	assert.equal(gesendet.status, 409);
	assert.match(gesendet.meldung, /bereits freigegeben und gesendet von a@b\.de/);
	// Betreff nennen, damit klar ist, welche Anfrage gemeint ist
	assert.match(f.freigabePruefen({ ...ok, freigabe: { ...ok.freigabe, status: 'gesendet', betreff: 'RE: Paletten Hagen [V-1]' } }).meldung, /Betrifft: RE: Paletten Hagen \[V-1\]$/);
	assert.equal(f.freigabePruefen({ ...ok, freigabe: { ...ok.freigabe, status: 'in_versand' } }).status, 409);
	const ab = f.freigabePruefen({ ...ok, freigabe: { ...ok.freigabe, ablauf: '2026-10-13T09:59:59Z' } });
	assert.deepEqual([ab.status, ab.code], [410, 'FREIGABE_ABGELAUFEN']);
	assert.equal(f.freigabePruefen({ ...ok, freigeberErlaubt: false }).status, 403);
});

test('Formular lesen', () => {
	const t = f.tokenErzeugen(crypto).token;
	assert.deepEqual(f.formularLesen({ t, aktion: 'senden', text: 'Hallo' }), { ok: true, aktion: 'senden', token: t, text: 'Hallo', grund: '' });
	assert.equal(f.formularLesen({ t, aktion: 'ablehnen' }).ok, false);
	assert.equal(f.formularLesen({ t, aktion: 'ablehnen', grund: 'Kunde ruft an' }).ok, true);
	assert.equal(f.formularLesen({ t, aktion: 'loeschen' }).ok, false);
	assert.equal(f.formularLesen({ t: 'x', aktion: 'senden' }).ok, false);
	assert.equal(f.formularLesen(null).ok, false);
});

test('Bearbeitet-Erkennung ignoriert Zeilenenden und Leerraum am Ende', () => {
	assert.equal(f.istBearbeitet('A\nB', 'A\r\nB  \n'), false);
	assert.equal(f.istBearbeitet('A\nB', 'A\nC'), true);
});

test('Formularseite: alles escaped, Token als Hidden-Feld, beide Aktionen', () => {
	const t = f.tokenErzeugen(crypto).token;
	const html = f.seiteFormular({
		token: t,
		freigabe: { empfaenger: 'x@y.de', betreff: '<script>alert(1)</script>', ablauf: '2026-10-15T10:00:00Z', fallback: true },
		vorgang: { vorgangs_id: 'V-2026-0001', rundenzaehler: 0 },
		fehlende: [{ anzeigename: 'PLZ <Abholort>', grund: 'fehlt' }],
		text: 'Guten Tag,\n</textarea><script>x</script>',
		abschluss: 'Gruß',
	});
	assert.doesNotMatch(html, /<script>/);
	assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;/);
	assert.match(html, new RegExp(`name="t" value="${t}"`));
	assert.match(html, /value="senden"/);
	assert.match(html, /value="ablehnen"/);
	// Ein sofort deaktivierter Knopf überträgt seinen Wert nicht: sperren erst nach dem Absenden.
	assert.match(html, /onsubmit="var f=this;setTimeout\(/);
	assert.doesNotMatch(html, /onsubmit="for\(/);
	assert.match(html, /Standardvorlage/);
	assert.match(html, /PLZ &lt;Abholort&gt;/);
	assert.match(f.seiteMeldung('Gesendet', 'a<b'), /a&lt;b/);
});

test('Teams-Nachricht an den Freigeber', () => {
	const n = f.nachrichtFreigeber({ vorgang: { vorgangs_id: 'V-1' }, freigabe: { empfaenger: 'k@x.de', betreff: 'RE: A&B' }, fehlende: [{ anzeigename: 'Telefon' }], link: 'https://h/webhook/epa-freigabe?t=a&b', ablaufText: '15.10.2026, 12:00', art: 'rueckfrage' });
	assert.match(n, /RE: A&amp;B/);
	assert.match(n, /href="https:\/\/h\/webhook\/epa-freigabe\?t=a&amp;b"/);
	assert.match(n, /<li>Telefon<\/li>/);
	assert.match(n, /einmal verwendbar/);
});

test('Freigabe-Nachricht mit Übersicht ersetzt die zusätzliche Eingangsmeldung (eine Nachricht je Rückfrage)', () => {
	const fg = { empfaenger: 'kunde@x.example', betreff: 'RE: Anfrage [V-2026-0001]' };
	const ohne = f.nachrichtFreigeber({ vorgang: { vorgangs_id: 'V-2026-0001' }, freigabe: fg, fehlende: [{ anzeigename: 'Telefon' }], link: 'https://x.example/f?t=1', ablaufText: '17.10.2026, 10:00', art: 'rueckfrage' });
	assert.match(ohne, /Fehlende Angaben:<ul><li>Telefon<\/li>/);
	const mit = f.nachrichtFreigeber({ vorgang: { vorgangs_id: 'V-2026-0001' }, freigabe: fg, fehlende: [{ anzeigename: 'Telefon' }], link: 'https://x.example/f?t=1', ablaufText: '17.10.2026, 10:00', art: 'rueckfrage', kontext_html: '<b>Anfrage mit Lücken erkannt</b><br>Fehlende oder ungültige Pflichtangaben:<ul><li>Telefon: fehlt</li></ul>' });
	assert.match(mit, /^<b>Anfrage mit Lücken erkannt<\/b>/);
	assert.match(mit, /<b>Rückfrage an den Kunden freigeben<\/b><br>An: kunde@x\.example/);
	assert.match(mit, /Entwurf ansehen, bearbeiten oder freigeben/);
	assert.doesNotMatch(mit, /Fehlende Angaben:<ul>/, 'Liste nicht doppelt');
});
