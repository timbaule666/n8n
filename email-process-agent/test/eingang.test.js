'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('../src/eingang');
const { pruefeUebergang } = require('../src/statusMatrix');

const CONFIG = { konfidenz_schwelle: 0.75, vorgangstypen: { transport: [] } };
const MAIL = { absender_adresse: 'max@kunde.de', absender_name: 'Max <Admin>', betreff: 'Anfrage', anhaenge: [], spoofing: { auffaellig: false, hinweise: [] } };
const llm = (ergebnis) => ({ ok: true, ergebnis: { klasse: 'anfrage', konfidenz: 0.9, begruendung_kurz: 'x', vorgangstyp: 'transport', sprache: 'de', verdacht_manipulation: false, ...ergebnis } });

test('Dedupe: ältester gültiger Eintrag gewinnt, fehlgeschlagene zählen nicht', () => {
	assert.deepEqual(e.dedupeEntscheiden([{ id: 5, status: 'in_arbeit' }], 5), { duplikat: false });
	const d = e.dedupeEntscheiden([{ id: 7, status: 'in_arbeit' }, { id: 3, status: 'fertig', vorgangs_id: 'V-2026-0001' }], 7);
	assert.deepEqual(d, { duplikat: true, original_id: 3, original_status: 'fertig', vorgangs_id: 'V-2026-0001' });
	// Parallel: beide tragen ein, beide lesen beide Zeilen -> genau einer gewinnt
	const zeilen = [{ id: 10, status: 'in_arbeit' }, { id: 11, status: 'in_arbeit' }];
	assert.equal(e.dedupeEntscheiden(zeilen, 10).duplikat, false);
	assert.equal(e.dedupeEntscheiden(zeilen, 11).duplikat, true);
	// Früherer Lauf ist fehlgeschlagen (EPA-05 markiert "fehler") -> erneute Verarbeitung erlaubt
	assert.equal(e.dedupeEntscheiden([{ id: 3, status: 'fehler' }, { id: 9, status: 'in_arbeit' }], 9).duplikat, false);
	assert.equal(e.dedupeEntscheiden([], 1).duplikat, false);
});

test('Klassifizierung: Anfrage, Newsletter, unklar, Schwelle, Allowlist, Typ, LLM-Fehler', () => {
	assert.deepEqual(
		(({ weg, status, ausloeser, vorgangstyp }) => ({ weg, status, ausloeser, vorgangstyp }))(e.klasseAuswerten(llm({}), CONFIG, MAIL)),
		{ weg: 'pruefen', status: 'In Prüfung', ausloeser: 'KI', vorgangstyp: 'transport' },
	);
	assert.equal(e.klasseAuswerten(llm({ klasse: 'keine_anfrage', vorgangstyp: null }), CONFIG, MAIL).status, 'Ignoriert');
	assert.equal(e.klasseAuswerten(llm({ klasse: 'unklar' }), CONFIG, MAIL).status, 'Klassifizierung unklar');
	assert.match(e.klasseAuswerten(llm({ konfidenz: 0.6 }), CONFIG, MAIL).grund, /unter Schwelle/);
	assert.equal(e.klasseAuswerten(llm({ klasse: 'keine_anfrage', konfidenz: 0.99 }), CONFIG, { ...MAIL, vertrauenswuerdig: true }).status, 'Klassifizierung unklar');
	// Nur ein Vorgangstyp konfiguriert: wird auch ohne KI-Angabe gesetzt
	assert.equal(e.klasseAuswerten(llm({ vorgangstyp: null }), CONFIG, MAIL).vorgangstyp, 'transport');
	const zwei = { ...CONFIG, vorgangstypen: { transport: [], lager: [] } };
	assert.equal(e.klasseAuswerten(llm({ vorgangstyp: null }), zwei, MAIL).status, 'Klassifizierung unklar');
	assert.equal(e.klasseAuswerten(llm({ vorgangstyp: 'lager' }), zwei, MAIL).vorgangstyp, 'lager');
	const f = e.klasseAuswerten({ ok: false, code: 'EXTRAKTION_UNGUELTIG' }, CONFIG, MAIL);
	assert.deepEqual([f.status, f.ausloeser, f.details.fehlercode], ['Klassifizierung unklar', 'System', 'EXTRAKTION_UNGUELTIG']);
	assert.equal(e.klasseAuswerten(llm({ verdacht_manipulation: true }), CONFIG, MAIL).details.verdacht_manipulation, true);
});

test('Alle Statuswechsel aus der Klassifizierung sind laut Matrix erlaubt', () => {
	for (const r of [llm({}), llm({ klasse: 'keine_anfrage' }), llm({ klasse: 'unklar' }), { ok: false }]) {
		const a = e.klasseAuswerten(r, CONFIG, MAIL);
		assert.equal(pruefeUebergang('Neu', a.status, a.ausloeser).erlaubt, true, `${a.status}/${a.ausloeser}`);
	}
	for (const s of ['Bereit zur Bearbeitung', 'Lücken erkannt', 'Eskaliert / Manuell']) assert.equal(pruefeUebergang('In Prüfung', s, 'System').erlaubt, true, s);
	assert.equal(pruefeUebergang('Neu', 'Zuordnung unklar', 'System').erlaubt, true);
});

test('Hinweise für die KI enthalten nur technische Indizien', () => {
	const h = e.klassifizierungsHinweise({ newsletter_hinweise: ['List-Unsubscribe'], ist_weiterleitung: true, text_leer: true });
	assert.deepEqual(h, ['Header-Indiz Newsletter/Massenmail: List-Unsubscribe', 'Betreff kennzeichnet eine Weiterleitung', 'Mailtext ist leer']);
	assert.deepEqual(e.extraktionsHinweise({ anhaenge: [{ name: 'a.pdf', status: 'ohne_textebene', hinweis: 'PDF ohne Textebene' }] }), ['Anhang "a.pdf" nicht auswertbar (PDF ohne Textebene)']);
});

test('Meldungen: HTML wird escaped, Inhalte vollständig', () => {
	const m = e.meldungZuordnungUnklar('V-2026-0003', { ...MAIL, betreff: '<script>alert(1)</script>' }, {
		grund: 'mehrere Kandidaten', bewertung: [{ vorgangs_id: 'V-2026-0001', status: 'Warten auf Kunde', summe: 40, punkte: [{ signal: 'gleicher Absender', punkte: 25 }, { signal: 'gleicher Betreff', punkte: 15 }] }],
	});
	assert.doesNotMatch(m, /<script>/);
	assert.match(m, /&lt;script&gt;/);
	assert.match(m, /Max &lt;Admin&gt; &lt;max@kunde.de&gt;/);
	assert.match(m, /V-2026-0001 \(Warten auf Kunde\): 40 Punkte – gleicher Absender \+25, gleicher Betreff \+15/);

	const felder = [{ feldname: 'A', anzeigename: 'Feld A', pflicht: true }, { feldname: 'B', anzeigename: 'Feld B', pflicht: false }];
	const g = e.meldungGeprueft('V-2026-0004', { ...MAIL, spoofing: { auffaellig: true, hinweise: ['SPF fail'] }, anhaenge: [{ name: 'f.jpg', status: 'nicht_ausgewertet', hinweis: 'Bild nicht automatisch ausgewertet' }] }, felder, {
		vollstaendig: false, daten: { A: { wert: null }, B: { wert: 5 } }, fehlende: [{ anzeigename: 'Feld A', grund: 'fehlt' }], hinweise: [], unsicher: [{ anzeigename: 'Feld B', konfidenz: 0.3 }],
	}, { verdacht_manipulation: true });
	assert.match(g, /Anfrage mit Lücken erkannt/);
	assert.match(g, /<tr><td>Feld A \*<\/td><td>—<\/td><\/tr><tr><td>Feld B<\/td><td>5<\/td><\/tr>/);
	assert.match(g, /<li>Feld A: fehlt<\/li>/);
	assert.match(g, /SPF fail/);
	assert.match(g, /Bild nicht automatisch ausgewertet/);
	assert.match(g, /Konfidenz 0.3/);
	assert.match(g, /Manipulationsversuch/);
	assert.match(e.meldungKlassifizierung('V-1', MAIL, { grund: 'x', details: {} }), /nicht gelöscht/);
	assert.match(e.meldungExtraktionFehlgeschlagen('V-1', MAIL, 'EXTRAKTION_UNGUELTIG'), /Eskaliert \/ Manuell/);
	assert.match(e.meldungZugeordnet('V-1', MAIL, 'Warten auf Kunde'), /M4/);
});

test('Archivieren nur bei aussortierten Mails, nie bei unklaren', () => {
	for (const c of ['ignoriert', 'ignoriert_auto_antwort', 'ignoriert_gesperrt']) assert.equal(e.archivieren(c), true, c);
	for (const c of ['klassifizierung_unklar', 'zuordnung_unklar', 'duplikat', 'ignoriert_eigene_mail', 'bereit', 'luecken', 'zugeordnet']) assert.equal(e.archivieren(c), false, c);
});

test('Eine Nachricht je Rückfrage: Eingangsmeldung entfällt nur, wenn die Freigabe angekommen ist', () => {
	const e = require('../src/eingang');
	assert.equal(e.meldungInFreigabe({ ergebnis: 'freigabe_angefordert', zugestellt: 1 }), true);
	assert.equal(e.meldungInFreigabe({ ergebnis: 'freigabe_angefordert', zugestellt: 0 }), false, 'nicht zugestellt: Eingangsmeldung bleibt');
	assert.equal(e.meldungInFreigabe({ ergebnis: 'eskaliert_max_runden' }), false);
	assert.equal(e.meldungInFreigabe(null), false, 'EPA-02 fehlgeschlagen: Eingangsmeldung bleibt');
});
