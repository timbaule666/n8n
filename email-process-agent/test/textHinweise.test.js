'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../src/textHinweise');
const antwort = require('../src/antwort');
const eingang = require('../src/eingang');

test('Mehrere Aufträge: H03 erkannt, normale Anfrage und Signatur mit gleicher PLZ nicht', () => {
	const h03 = 'Hallo,\n\nwir brauchen zwei Transporte:\n1) am 10.12.2026 von 50667 Köln nach 53111 Bonn, 2 Paletten, 500 kg\n2) am 11.12.2026 von 53111 Bonn nach 56068 Koblenz, 1 Palette, 300 kg\n\nTelefon 0221 5551503';
	assert.equal(t.mehrereAuftraege(h03).verdacht, true);
	assert.deepEqual(t.mehrereAuftraege(h03).plz, ['50667', '53111', '56068']);
	// nummerierte Liste ohne Mengenwort reicht auch
	assert.equal(t.mehrereAuftraege('1) 50667 Köln nach 53111 Bonn\n2) 53111 Bonn nach 50667 Köln').verdacht, true);
	assert.equal(t.mehrereAuftraege('Transport von 50667 Köln nach 80331 München, Tel. 0221 5550101, Rechnung 2026-11870').verdacht, false);
	assert.equal(t.mehrereAuftraege('Abholung in 04109 Leipzig, Lieferung nach 01067 Dresden.\nMuster GmbH | Beispielstraße 1 | 04109 Leipzig').verdacht, false);
	// Telefonnummern und längere Nummern sind keine PLZ
	assert.deepEqual(t.mehrereAuftraege('Tel. +44 20 5551406, Auftrag 123456, Fax 0341/55515').plz, []);
});

test('Stornierung: typische Formulierungen, nicht in Zitaten, keine Fehlalarme', () => {
	for (const s of ['der Transport hat sich leider erledigt, bitte stornieren.', 'Wir müssen den Auftrag leider absagen.', 'wir sagen den Termin ab', 'Please cancel the shipment.', 'Die Abholung ist nicht mehr nötig.']) {
		assert.ok(t.stornoStelle(s), s);
	}
	assert.equal(t.stornoStelle('> bitte stornieren\nHier die Telefonnummer: 0221 555'), null);
	for (const s of ['Abholung am 12.12.', 'Hier die Telefonnummer', 'Vielen Dank!', 'Ich melde mich morgen mit der Nummer.']) assert.equal(t.stornoStelle(s), null, s);
	assert.equal(t.alle({ text: 'bitte stornieren' }).storno, null, 'nur bei Antworten');
	assert.match(t.alle({ text: 'bitte stornieren' }, { antwort: true }).storno, /stornieren/);
});

test('Mehrdeutiges Datum: 12/11/2026 ja, 25/11/2026 und 12.11.2026 nein', () => {
	assert.deepEqual(t.mehrdeutigeDaten('pickup on 12/11/2026'), ['12/11/2026']);
	assert.deepEqual(t.mehrdeutigeDaten('pickup on 25/11/2026 or 12.11.2026 or 11/11/26'), []);
	assert.match(t.alle({ text: 'on 03/04/26' }).hinweise[0], /mehrdeutig/);
});

test('Meldungen: Stornierung oben und escaped, Hinweise unten, Vertröstungstext ersetzt', () => {
	const mail = { absender_adresse: 'a@b.de', betreff: 'AW: x' };
	const merge = { uebernommen: [], konflikte_neu: [], hinweise: [], unsicher: [], fehlende: [] };
	const html = antwort.meldungAntwort({ vorgangs_id: 'V-1', mail, merge, entscheidung: { weg: 'keine_daten' }, storno: 'bitte <stornieren>', text_hinweise: ['Hinweis & mehr'] });
	assert.match(html, /^<b>⚠️ Mögliche Stornierung \/ Absage – bitte prüfen<\/b><br>Kunde schreibt: „bitte &lt;stornieren&gt;“/);
	assert.ok(!html.includes('Vertröstung'));
	assert.match(html, /<br>⚠️ Hinweis &amp; mehr$/);
	const ohne = antwort.meldungAntwort({ vorgangs_id: 'V-1', mail, merge, entscheidung: { weg: 'keine_daten' } });
	assert.match(ohne, /Vertröstung/);
	assert.ok(!ohne.includes('Stornierung'));
	const neu = eingang.meldungGeprueft('V-2', mail, [], { vollstaendig: true, daten: {}, fehlende: [] }, { text_hinweise: ['mehrere Aufträge'] });
	assert.match(neu, /⚠️ mehrere Aufträge/);
});

test('handlungKeineAnfrage: Stornierung, Rückruf, Statusfrage, nur Anhang', () => {
	const h = t.handlungKeineAnfrage;
	assert.equal(h({ text: 'bitte stornieren Sie unseren Transport vom 02.12.2026. Hat sich erledigt.' }).anlass, 'storno');
	assert.equal(h({ text: 'Hallo, bitte rufen Sie mich zurück wegen eines größeren Projekts. 0611 5557050.' }).anlass, 'rueckruf');
	assert.equal(h({ text: 'Could you call me back tomorrow?' }).anlass, 'rueckruf');
	const s = h({ text: 'wie ist der Stand zu Vorgang V-2026-9999?', vorgangs_ids_erwaehnt: ['V-2026-9999'] });
	assert.equal(s.anlass, 'status');
	assert.deepEqual(s.vorgangs_ids, ['V-2026-9999']);
	assert.equal(h({ text: 'Guten Tag,\n\nsiehe Foto im Anhang.\n\nGrüße', anhaenge: [{ name: 'f.png' }] }).anlass, 'anhang');
	assert.equal(h({ text: 'Grüße', anhaenge: [{ name: 'f.png' }] }, 'Mail enthält nur ein Foto ohne Anfrage').anlass, 'anhang');
});

test('handlungKeineAnfrage: normale Nicht-Anfragen bleiben still', () => {
	const h = t.handlungKeineAnfrage;
	for (const text of ['Newsletter Dezember', 'Vielen Dank für die schnelle Lieferung!', 'Anbei unsere Rechnung 2026-4471.', 'Ich bin bis 05.11. nicht im Büro.', 'Bitte bestätigen Sie Ihr Konto.']) {
		assert.equal(h({ text }), null, text);
	}
	// Rechnung mit Anhang ist kein Fall für "nur Anhang"
	assert.equal(h({ text: 'Anbei die Rechnung.', anhaenge: [{ name: 'r.pdf' }] }, 'Rechnung ohne Anfrage'), null);
	// Abwesenheitsnotiz, Newsletter und eigene Mails nie melden
	assert.equal(h({ text: 'bitte stornieren', auto_antwort: { ist: true } }), null);
	assert.equal(h({ text: 'bitte stornieren', newsletter_hinweise: ['List-Unsubscribe'] }), null);
	assert.equal(h({ text: 'bitte stornieren', eigene_mail: true }), null);
});
