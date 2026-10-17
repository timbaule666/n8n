'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../src/unzustellbar');

const NDR = {
	absender_adresse: 'MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@agentdemo666.onmicrosoft.com',
	betreff: 'Undeliverable: RE: Abholung nächste Woche Bielefeld [V-2026-0132]',
	text: "Delivery has failed to these recipients or groups:\nSandra Jung (timbaule666@gmail.com)\nYour message wasn't delivered.\nDiagnostic information for administrators:\nGenerating server: BENP281MB6248.DEUP281.PROD.OUTLOOK.COM\ntimbaule666@gmail.com\nRemote server returned '550 5.7.708 Service unavailable. Access denied, traffic not accepted from this IP. AS(7910)'\nFrom: Tim Baule <TimBaule@agentdemo666.onmicrosoft.com>",
};

test('Unzustellbarkeitsmeldung von Exchange: Vorgang, Empfänger und SMTP-Grund', () => {
	const r = u.erkennen(NDR, 'timbaule@agentdemo666.onmicrosoft.com');
	assert.equal(r.ist, true);
	assert.equal(r.vorgangs_id, 'V-2026-0132');
	assert.equal(r.empfaenger, 'timbaule666@gmail.com');
	assert.match(r.grund, /^550 5\.7\.708 Service unavailable/);
});

test('Keine NDR: Kundenmail, fremder Absender oder ohne Vorgangs-ID', () => {
	assert.equal(u.erkennen({ ...NDR, absender_adresse: 'kunde@firma.de' }).ist, false);
	assert.equal(u.erkennen({ ...NDR, betreff: 'Undeliverable: Newsletter' }).ist, false);
	assert.equal(u.erkennen({ absender_adresse: 'mailer-daemon@googlemail.com', betreff: 'Abwesend [V-2026-0001]', text: 'Ich bin im Urlaub' }).ist, false);
	// Gmail-NDR mit deutschem Betreff, Grund ohne "Remote server returned"
	const g = u.erkennen({ absender_adresse: 'mailer-daemon@googlemail.com', betreff: 'Unzustellbar: RE: Transport [V-2026-0007]', text: 'Die Nachricht konnte nicht zugestellt werden an x@y.de\n550 5.1.1 The email account does not exist' });
	assert.deepEqual([g.ist, g.vorgangs_id, g.empfaenger], [true, 'V-2026-0007', 'x@y.de']);
	assert.match(g.grund, /^550 5\.1\.1/);
});

test('Meldung: escaped, mit Grund und Status-Hinweis', () => {
	const html = u.meldung({ vorgangs_id: 'V-1', empfaenger: 'a@b.de', grund: '550 <x>', betreff: 'RE: Test', eskaliert: true });
	assert.match(html, /^<b>📭 Nachricht nicht zugestellt<\/b>/);
	assert.match(html, /550 &lt;x&gt;/);
	assert.match(html, /Eskaliert \/ Manuell/);
	assert.match(u.meldung({ vorgangs_id: 'V-1', grund: 'x', eskaliert: false }), /nicht umgestellt/);
});
