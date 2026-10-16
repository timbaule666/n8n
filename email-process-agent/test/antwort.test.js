'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const a = require('../src/antwort');
const pf = require('../src/pflichtfelder');
const { validiereConfig } = require('../src/configValidator');
const { pruefeUebergang } = require('../src/statusMatrix');

const beispiel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'datatables', 'beispiel-transport.json'), 'utf8'));
const FELDER = validiereConfig({ ...beispiel.epa_config_allgemein[0], postfach: 'a@b.de', freigeber: '["c@b.de"]' }, beispiel.epa_config_pflichtfelder).config.vorgangstypen.transport;
const HEUTE = '2026-10-14';
const ex = (werte) => Object.fromEntries(Object.entries(werte).map(([k, v]) => [k, { wert: v, quelle: 'Mailtext', konfidenz: 0.9 }]));
const pruefe = (werte) => pf.pruefen(ex(werte), FELDER, { heute: HEUTE });
const BEKANNT = pruefe({ Start_PLZ: '50667', Start_Ort: 'Köln', Ziel_PLZ: '04109', Ziel_Ort: 'Leipzig', Abholdatum: '2026-10-30', Gewicht_kg: '1200', Ansprechpartner: 'Max Muster' }).daten;
const OPT = { istPlatzhalter: pf.istPlatzhalter, message_id: '<r2@x>', runde: 1 };
const merge = (neu, alt = BEKANNT, extra = {}) => a.zusammenfuehren(alt, pruefe(neu), FELDER, { ...OPT, ...extra });

test('Weg je Status', () => {
	for (const s of ['Warten auf Kunde', 'Freigabe ausstehend', 'Bereit zur Bearbeitung']) assert.equal(a.wegBestimmen(s), 'verarbeiten', s);
	for (const s of ['In Prüfung', 'Lücken erkannt', 'Eskaliert / Manuell', 'Zuordnung unklar', 'Klassifizierung unklar']) assert.equal(a.wegBestimmen(s), 'nur_melden', s);
	// alle automatischen Wege sind in der Matrix für "System" erlaubt
	for (const s of a.AUTOMATISCH) assert.equal(pruefeUebergang(s, 'In Prüfung', 'System').erlaubt, true, s);
});

test('Merge: leer + gültig -> übernehmen; vorhandenes bleibt; vollständig', () => {
	const m = merge({ Telefon: '0221 987654' });
	assert.deepEqual(m.uebernommen.map((u) => [u.feldname, u.neu]), [['Telefon', '0221987654']]);
	assert.equal(m.daten.Telefon.wert, '0221987654');
	assert.equal(m.daten.Start_PLZ.wert, '50667');
	assert.equal(m.vollstaendig, true);
	assert.equal(m.keine_daten, false);
	assert.deepEqual(m.konflikte, []);
});

test('Merge: gültig + abweichend gültig -> Konflikt, alter Wert bleibt', () => {
	const m = merge({ Telefon: '0221 987654', Start_PLZ: '50668' });
	assert.equal(m.daten.Start_PLZ.wert, '50667');
	assert.deepEqual(m.konflikte_neu.map((k) => [k.feldname, k.alt, k.neu, k.message_id]), [['Start_PLZ', '50667', '50668', '<r2@x>']]);
	assert.equal(m.vollstaendig, true);
});

test('Merge: gleiche Angabe (normalisiert) ist Bestätigung, kein Konflikt', () => {
	const m = merge({ Start_Ort: 'köln ', Gewicht_kg: '1.200', Telefon: '0221 1' + '23456' });
	assert.deepEqual(m.bestaetigt.sort(), ['Gewicht_kg', 'Start_Ort']);
	assert.deepEqual(m.konflikte, []);
});

test('Merge: gültig + ungültig -> bleibt, Hinweis; leer + ungültig -> Lücke mit neuem Grund', () => {
	const m = merge({ Start_PLZ: '123', Telefon: 'abc' });
	assert.equal(m.daten.Start_PLZ.wert, '50667');
	assert.match(m.hinweise[0].grund, /bisheriger Wert bleibt/);
	assert.deepEqual(m.fehlende, [{ feldname: 'Telefon', anzeigename: 'Telefonnummer', grund: 'ungültig: keine gültige Telefonnummer' }]);
	assert.equal(m.vollstaendig, false);
	assert.equal(m.keine_daten, false);
});

test('Merge: keine verwertbaren Angaben (nur null oder Platzhalter) -> keine_daten', () => {
	assert.equal(merge({}).keine_daten, true);
	assert.equal(merge({ Telefon: 'k.A.' }).keine_daten, true);
	const m = merge({});
	assert.deepEqual(m.fehlende.map((f) => f.feldname), ['Telefon']);
	assert.deepEqual(a.entscheiden(m, { status: 'Warten auf Kunde' }), { weg: 'keine_daten', zielstatus: null, freigabe_ersetzen: false });
});

test('Merge: Vertröstung, die nur Bekanntes wiederholt (Name aus der Signatur) -> keine_daten', () => {
	// "Ich melde mich morgen mit der Nummer. Gruß Max Muster": KI liest den Namen erneut aus
	const m = merge({ Ansprechpartner: 'Max Muster' });
	assert.deepEqual(m.bestaetigt, ['Ansprechpartner']);
	assert.equal(m.keine_daten, true);
	assert.equal(a.entscheiden(m, { status: 'Warten auf Kunde' }).weg, 'keine_daten');
});

test('Merge: Konflikte sammeln sich über Runden, gleiche nicht doppelt', () => {
	const m1 = merge({ Start_PLZ: '50668' });
	const m2 = merge({ Start_PLZ: '50668', Ziel_Ort: 'Halle' }, BEKANNT, { konflikteBisher: m1.konflikte, runde: 2 });
	assert.deepEqual(m2.konflikte.map((k) => k.feldname), ['Start_PLZ', 'Ziel_Ort']);
	assert.deepEqual(m2.konflikte_neu.map((k) => k.feldname), ['Ziel_Ort']);
	// nur ein bereits bekannter Konflikt erneut: zählt nicht als keine_daten, aber auch kein neuer Konflikt
	const m3 = merge({ Start_PLZ: '50668' }, BEKANNT, { konflikteBisher: m1.konflikte });
	assert.equal(m3.konflikte_neu.length, 0);
	assert.equal(m3.keine_daten, false);
});

test('Entscheiden: vollständig, Lücken, Freigabe ersetzen; Zielstatus in der Matrix erlaubt', () => {
	const voll = merge({ Telefon: '0221 987654' });
	assert.deepEqual(a.entscheiden(voll, { status: 'Warten auf Kunde' }), { weg: 'bereit', zielstatus: 'Bereit zur Bearbeitung', freigabe_ersetzen: false });
	const teil = merge({ Packstuecke: '4' });
	assert.equal(teil.vollstaendig, false);
	assert.deepEqual(a.entscheiden(teil, { status: 'Freigabe ausstehend', freigabe_id_aktuell: 'F-1' }), { weg: 'luecken', zielstatus: 'Lücken erkannt', freigabe_ersetzen: true });
	for (const z of ['Bereit zur Bearbeitung', 'Lücken erkannt']) assert.equal(pruefeUebergang('In Prüfung', z, 'System').erlaubt, true);
	// Neuer Konflikt ohne neue Felder ist keine "keine_daten"-Antwort
	const k = merge({ Ziel_Ort: 'Halle' });
	assert.equal(a.entscheiden(k, { status: 'Warten auf Kunde' }).weg, 'luecken');
});

test('Frist nie verkürzen', () => {
	assert.equal(a.fristVerlaengern('2026-10-20T10:00:00Z', '2026-10-21T10:00:00Z'), '2026-10-21T10:00:00Z');
	assert.equal(a.fristVerlaengern('2026-10-22T10:00:00Z', '2026-10-21T10:00:00Z'), '2026-10-22T10:00:00Z');
	assert.equal(a.fristVerlaengern(null, '2026-10-21T10:00:00Z'), '2026-10-21T10:00:00Z');
	assert.equal(a.fristVerlaengern('2026-10-20T10:00:00Z', null), '2026-10-20T10:00:00Z');
});

test('Extraktionshinweise ohne Werte (Datenminimierung)', () => {
	const h = a.extraktionsHinweise({ fehlende_felder: [{ feldname: 'Telefon', anzeigename: 'Telefonnummer' }], extrahierte_daten: BEKANNT }, FELDER);
	assert.match(h.join('\n'), /Noch offene Angaben: Telefonnummer/);
	assert.match(h.join('\n'), /Bereits bekannt.*PLZ Abholort/);
	assert.doesNotMatch(h.join('\n'), /50667|Köln/);
});

test('Meldung: escaped, Konflikte, offene Felder, Rückfrage-Status', () => {
	const m = merge({ Start_PLZ: '50668', Packstuecke: '<b>4</b>' });
	const html = a.meldungAntwort({ vorgangs_id: 'V-1', mail: { absender_adresse: 'x@y.de', betreff: '<i>AW</i>' }, merge: m, entscheidung: a.entscheiden(m, { status: 'Freigabe ausstehend', freigabe_id_aktuell: 'F' }), rueckfrage: { ergebnis: 'freigabe_angefordert', zugestellt: 2 } });
	assert.doesNotMatch(html, /<i>AW/);
	assert.match(html, /bisher "50667", jetzt "50668"/);
	assert.match(html, /Telefonnummer: fehlt/);
	assert.match(html, /Link an 2 Freigeber/);
	assert.match(html, /überholt/);
	assert.match(a.meldungAntwort({ vorgangs_id: 'V-1', mail: {}, merge: merge({}), entscheidung: { weg: 'keine_daten' }, fristNeu: '21.10.2026, 10:00' }), /verlängert bis 21\.10\.2026/);
	assert.match(a.meldungAntwort({ vorgangs_id: 'V-1', mail: {}, entscheidung: { weg: 'nur_melden' }, alterStatus: 'Eskaliert / Manuell' }), /nicht automatisch ausgewertet/);
});

test('Antwort ergänzt den Ansprechpartner um den Nachnamen: Übernahme statt Widerspruch', () => {
	const felder = [{ feldname: 'Ansprechpartner', anzeigename: 'Ansprechpartner', typ: 'text', pflicht: true, validierungsregel: { person: true } }];
	const alt = { Ansprechpartner: { wert: 'Max', roh: 'Max', quelle: 'Mailtext', konfidenz: 0.9 } };
	const neu = (wert) => ({ daten: { Ansprechpartner: { wert, roh: wert, quelle: 'Mailtext', konfidenz: 0.9 } }, fehlende: [], hinweise: [] });
	const m = a.zusammenfuehren(alt, neu('Max Müller'), felder, {});
	assert.equal(m.daten.Ansprechpartner.wert, 'Max Müller');
	assert.equal(m.konflikte_neu.length, 0);
	assert.deepEqual(m.uebernommen.map((u) => [u.alt, u.neu]), [['Max', 'Max Müller']]);
	assert.equal(a.zusammenfuehren(alt, neu('Tim Baule'), felder, {}).konflikte_neu.length, 1, 'anderer Name bleibt Widerspruch');
	assert.equal(a.nameErgaenzt('Max Müller', 'Max'), false);
});

test('Abschluss-Meldung: Verlauf mit erster Mail, bisherigen und nachgeforderten Informationen', () => {
	const m = merge({ Telefon: '0221 987654' });
	assert.equal(m.daten.Telefon.nachgefordert, true, 'aus der Antwort markiert');
	assert.ok(!m.daten.Start_PLZ.nachgefordert, 'aus der ersten Mail nicht markiert');
	const vorgang = { vorgangs_id: 'V-2026-0001', absender_name: 'Max Muster', absender_adresse: 'max@kunde.example', betreff: 'Transport Köln', rundenzaehler: 1,
		erste_mail_am: '2026-10-15T07:30:00Z', erste_mail_link: 'https://outlook.example/erste' };
	const mail = { absender_adresse: 'max@kunde.example', betreff: 'AW: Transport Köln', empfangen_am: '2026-10-15T10:05:00Z', web_link: 'https://outlook.example/antwort' };
	const html = a.meldungAntwort({ vorgangs_id: 'V-2026-0001', mail, merge: m, entscheidung: { weg: 'bereit' }, uebersicht: { vorgang, felder: FELDER, zeitzone: 'Europe/Berlin' } });
	assert.match(html, /Anfrage vollständig/);
	assert.match(html, /Erste Anfrage: 15\.10\.2026, 09:30 · <a href="https:\/\/outlook\.example\/erste">Erste Mail öffnen<\/a>/);
	assert.match(html, /Antwort mit den fehlenden Angaben: 15\.10\.2026, 12:05 · <a href="https:\/\/outlook\.example\/antwort">/);
	const [bisher, nach] = html.split('<b>Nachgeforderte Informationen</b>');
	assert.match(bisher, /<b>Bisherige Informationen<\/b>.*PLZ Abholort.*50667/s);
	assert.ok(!/Telefon/.test(bisher), 'Telefon nicht unter bisher');
	assert.match(nach, /Telefonnummer.*<b>0221987654<\/b> \(aus dieser Antwort\)/);
	assert.match(html, /Kunde: Max Muster \(max@kunde\.example\)/);
	// Ältere Vorgänge ohne gespeicherten Link: Datum aus createdAt, kein Link
	const alt = a.meldungAntwort({ vorgangs_id: 'V-1', mail, merge: m, entscheidung: { weg: 'bereit' }, uebersicht: { vorgang: { createdAt: '2026-10-15T07:30:00Z' }, felder: FELDER } });
	assert.match(alt, /Erste Anfrage: 15\.10\.2026, 09:30<br>/);
	// Ohne Übersicht bleibt die kurze Meldung
	assert.match(a.meldungAntwort({ vorgangs_id: 'V-1', mail, merge: m, entscheidung: { weg: 'bereit' } }), /Antwort eingegangen – Anfrage jetzt vollständig/);
});
