'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const z = require('../src/zustelltest');

const JETZT = '2026-10-16T05:40:00.000Z';
const configs = [
	{ kunde_id: 'k1', postfach: 'a@b.de', postfach_workflow_id: 'WF1', benachrichtigung: { kanal: 'telegram_test', chat_id: '1' } },
	{ kunde_id: 'k2', postfach: 'c@d.de', postfach_workflow_id: '' },
];

test('Aufträge: nur Kunden mit Postfach-Workflow, eindeutiger Betreff, Prüfadresse Pflicht', () => {
	const a = z.auftraege(configs, { jetzt: JETZT, zufall: 'x1', pruefadresse: 'pruef@beispiel.de' });
	assert.equal(a.length, 1);
	assert.equal(a[0].betreff, 'EPA-Zustelltest k1 202610160540-x1');
	assert.equal(a[0].empfaenger, 'pruef@beispiel.de');
	assert.throws(() => z.auftraege(configs, { jetzt: JETZT, zufall: 'x', pruefadresse: '<pruefadresse@ihre-domain.de>' }), /Prüfadresse/);
});

test('EPA-00 sendet nur Zustelltests', () => {
	assert.equal(z.sendenErlaubt({ empfaenger: 'p@b.de', betreff: 'EPA-Zustelltest k1 1-x' }).ok, true);
	assert.equal(z.sendenErlaubt({ empfaenger: 'p@b.de', betreff: 'Rechnung' }).ok, false);
	assert.equal(z.sendenErlaubt({ empfaenger: 'kein-empfaenger', betreff: 'EPA-Zustelltest k1' }).ok, false);
});

test('Auswerten: angekommen, nicht angekommen, Versand abgelehnt', () => {
	const a = z.auftraege([...configs, { kunde_id: 'k3', postfach: 'e@f.de', postfach_workflow_id: 'WF3' }, { kunde_id: 'k4', postfach: 'g@h.de', postfach_workflow_id: 'WF4' }], { jetzt: JETZT, zufall: 'y', pruefadresse: 'p@b.de' });
	const r = z.auswerten(a, [{ gesendet: true, status: 202 }, { gesendet: true, status: 202 }, { error: { message: 'ErrorAccountSuspend' } }], [a[0].betreff, 'anderes']);
	assert.deepEqual(r.map((x) => [x.kunde_id, x.ok, x.art]), [['k1', true, 'ok'], ['k3', false, 'nicht_angekommen'], ['k4', false, 'versand_abgelehnt']]);
	assert.match(r[2].grund, /ErrorAccountSuspend/);
	const html = z.meldung({ ...r[1], postfach: 'e@f.de <x>' });
	assert.match(html, /^<b>🚫 Systemwarnung: Postfach versendet keine Mails<\/b>/);
	assert.match(html, /e@f\.de &lt;x&gt;/);
	assert.deepEqual(z.stand(r[1], JETZT), { schluessel: 'zustelltest:k3', letzter_lauf: JETZT, letztes_ergebnis: '{"ok":false,"art":"nicht_angekommen"}' });
});
