'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const n = require('../src/nachfassen');
const fristen = require('../src/fristen');
const entwurf = require('../src/entwurf');
const freigabe = require('../src/freigabe');
const { validiereConfig } = require('../src/configValidator');
const { pruefeUebergang } = require('../src/statusMatrix');

const beispiel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'datatables', 'beispiel-transport.json'), 'utf8'));
const CONFIG = validiereConfig({ ...beispiel.epa_config_allgemein[0], postfach: 'a@b.de', freigeber: '["c@b.de"]' }, beispiel.epa_config_pflichtfelder).config;
const FELDER = CONFIG.vorgangstypen.transport;
// Mittwoch 14.10.2026, 10:00 Berlin (Geschäftszeit, kein Feiertag in NRW)
const JETZT = '2026-10-14T08:00:00.000Z';
const NACHTS = '2026-10-14T21:00:00.000Z';
const configs = { k1: CONFIG };
const vg = (x) => ({ kunde_id: 'k1', vorgangs_id: 'V-1', status: 'Warten auf Kunde', antwort_frist: '2026-10-14T07:00:00.000Z', erinnerungen_gesendet: 0, version: 4, ...x });
const fg = (x) => ({ kunde_id: 'k1', vorgangs_id: 'V-9', freigabe_id: 'F-1', status: 'offen', ablauf: '2026-10-16T08:00:00.000Z', createdAt: '2026-10-14T07:30:00.000Z', erinnert_am: null, ...x });
const plan = (p) => n.planen({ vorgaenge: [], freigaben: [], configs, jetzt: JETZT, fristen, ...p });

test('Überfällig, Erinnerungen übrig -> Erinnerung (Fall 1)', () => {
	const r = plan({ vorgaenge: [vg({ erinnerungen_gesendet: 1 })] });
	assert.deepEqual(r.aufgaben.map((a) => [a.aktion, a.vorgangs_id, a.version, a.erinnerungen_gesendet]), [['erinnerung', 'V-1', 4, 1]]);
});

test('Überfällig, alle Erinnerungen gesendet -> Eskalation (Fall 2)', () => {
	const r = plan({ vorgaenge: [vg({ erinnerungen_gesendet: CONFIG.anzahl_erinnerungen })] });
	assert.equal(r.aufgaben[0].aktion, 'eskalation');
	// Die Matrix erlaubt beide Wege für den Cronjob
	assert.equal(pruefeUebergang('Warten auf Kunde', 'Freigabe ausstehend', 'Cronjob').erlaubt, true);
	assert.equal(pruefeUebergang('Warten auf Kunde', 'Eskaliert / Manuell', 'Cronjob').erlaubt, true);
});

test('Nicht überfällig, anderer Status oder ohne Frist -> nichts', () => {
	const r = plan({ vorgaenge: [vg({ antwort_frist: '2026-10-14T09:00:00.000Z' }), vg({ status: 'Freigabe ausstehend' }), vg({ antwort_frist: null }), vg({ antwort_frist: JETZT })] });
	assert.equal(r.aufgaben.length, 0);
	assert.equal(r.uebersprungen.length, 0);
});

test('Außerhalb der Geschäftszeit und ohne gültige Config -> übersprungen, nicht verloren', () => {
	const nachts = plan({ jetzt: NACHTS, vorgaenge: [vg()] });
	assert.equal(nachts.aufgaben.length, 0);
	assert.deepEqual(nachts.uebersprungen.map((u) => u.grund), ['ausserhalb_geschaeftszeit']);
	const ohne = plan({ vorgaenge: [vg({ kunde_id: 'unbekannt' })] });
	assert.deepEqual(ohne.uebersprungen.map((u) => u.grund), ['keine_gueltige_config']);
	assert.deepEqual(plan({ configs: { k1: null }, vorgaenge: [vg()] }).uebersprungen.map((u) => u.grund), ['kunde_inaktiv']);
	// Feiertag: Tag der Deutschen Einheit 2025 (Freitag)
	assert.equal(plan({ jetzt: '2025-10-03T08:00:00.000Z', vorgaenge: [vg({ antwort_frist: '2025-10-02T08:00:00.000Z' })] }).aufgaben.length, 0);
});

test('Freigabe: abgelaufen -> erneuern; Erinnerung nach freigabe_erinnerung_stunden (Geschäftszeit)', () => {
	assert.deepEqual(plan({ freigaben: [fg({ ablauf: '2026-10-14T07:59:00.000Z' })] }).aufgaben.map((a) => a.aktion), ['freigabe_erneuern']);
	// erstellt 09:30 Berlin, 4 h Erinnerung -> 13:30 fällig; um 10:00 noch nicht
	assert.equal(plan({ freigaben: [fg()] }).aufgaben.length, 0);
	assert.deepEqual(plan({ jetzt: '2026-10-14T11:31:00.000Z', freigaben: [fg()] }).aufgaben.map((a) => a.aktion), ['freigabe_erinnerung']);
	// erstellt Dienstag 16:00 Berlin -> 1 h am Dienstag + 3 h am Mittwoch -> fällig Mittwoch 11:00
	const spaet = fg({ createdAt: '2026-10-13T14:00:00.000Z' });
	assert.equal(plan({ freigaben: [spaet] }).aufgaben.length, 0);
	assert.equal(plan({ jetzt: '2026-10-14T09:00:00.000Z', freigaben: [spaet] }).aufgaben.length, 1);
	// schon erinnert -> erst nach Erneuerung wieder
	assert.equal(plan({ jetzt: '2026-10-15T12:00:00.000Z', freigaben: [fg({ erinnert_am: '2026-10-14T12:00:00.000Z' })] }).aufgaben.length, 0);
	// nach Erneuerung zählt erneuert_am
	const erneuert = fg({ createdAt: '2026-10-01T07:00:00.000Z', erneuert_am: '2026-10-14T07:30:00.000Z' });
	assert.equal(plan({ freigaben: [erneuert] }).aufgaben.length, 0);
	// nicht offen -> nichts
	assert.equal(plan({ freigaben: [fg({ status: 'gesendet', ablauf: '2026-10-01T00:00:00.000Z' })] }).aufgaben.length, 0);
});

test('Priorität und Begrenzung je Lauf', () => {
	const vorgaenge = Array.from({ length: 4 }, (_, i) => vg({ vorgangs_id: `V-${i}`, erinnerungen_gesendet: i % 2 ? 5 : 0 }));
	const freigaben = [fg({ ablauf: '2026-10-14T07:00:00.000Z' })];
	const r = plan({ vorgaenge, freigaben, max: 3 });
	assert.deepEqual(r.aufgaben.map((a) => a.aktion), ['eskalation', 'eskalation', 'erinnerung']);
	assert.equal(r.verschoben, 2);
});

test('Lauf-Lock: Holen, Freigeben (Epoche), Zusammenfassung ohne Personendaten', () => {
	const h = n.lockHolen('123', JETZT);
	assert.equal(h.lock_durch, '123');
	assert.equal(new Date(h.lock_bis).getTime() - new Date(JETZT).getTime(), n.LOCK_MINUTEN * 60000);
	const plan1 = { aufgaben: [{ aktion: 'erinnerung', vorgangs_id: 'V-1' }, { aktion: 'eskalation', vorgangs_id: 'V-2' }], uebersprungen: [{}], verschoben: 0 };
	const s = n.laufAuswerten(plan1, [{ ergebnis: 'freigabe_angefordert' }, { error: 'x' }]);
	assert.deepEqual(s.ergebnisse, { 'erinnerung:freigabe_angefordert': 1, 'eskalation:fehler': 1 });
	assert.deepEqual(s.fehler, [{ aktion: 'eskalation', vorgangs_id: 'V-2', freigabe_id: null }]);
	const f = n.lockFreigeben(JETZT, s);
	assert.equal(f.lock_bis, n.EPOCHE);
	assert.equal(f.lock_durch, '');
	assert.deepEqual(JSON.parse(f.letztes_ergebnis), s);
	assert.ok(new Date(n.EPOCHE).getTime() < new Date(JETZT).getTime());
});

test('Tage ohne Reaktion: erste Rückfrage der aktuellen Runde', () => {
	const gesendet = [
		{ status: 'gesendet', art: 'rueckfrage', runde: 1, gesendet_am: '2026-10-01T08:00:00Z' },
		{ status: 'gesendet', art: 'rueckfrage', runde: 2, gesendet_am: '2026-10-07T08:00:00Z' },
		{ status: 'gesendet', art: 'erinnerung', runde: 2, gesendet_am: '2026-10-09T08:00:00Z' },
		{ status: 'abgelehnt', art: 'rueckfrage', runde: 2, gesendet_am: null },
	];
	assert.equal(n.tageOhneReaktion({ rundenzaehler: 2 }, gesendet, JETZT), 7);
	assert.equal(n.tageOhneReaktion({ rundenzaehler: 3 }, gesendet, JETZT), 5); // Fallback: jüngste
	assert.equal(n.tageOhneReaktion({ rundenzaehler: 1 }, [], JETZT), null);
});

test('Meldung Fall 2: Kontaktdaten, escaped, Text laut Masterprompt', () => {
	const html = n.meldungKeineReaktion({
		vorgang: { vorgangs_id: 'V-1', absender_name: 'Erika <b>M</b>', absender_adresse: 'e@k.example', betreff: 'Anfrage' },
		tage: 7, erinnerungen: 2, fehlende: [{ feldname: 'Gewicht_kg', anzeigename: 'Gewicht' }], daten: { Telefon: { wert: '0221 123' } },
	});
	assert.match(html, /reagiert seit 7 Tagen nicht auf Nachfragen/);
	assert.match(html, /telefonisch kontaktieren/);
	assert.match(html, /Telefon: 0221 123/);
	assert.match(html, /Noch offen: Gewicht/);
	assert.ok(!html.includes('<b>M</b>'));
	assert.match(n.meldungKeineReaktion({ vorgang: { vorgangs_id: 'V' }, tage: null, erinnerungen: 0 }), /seit längerer Zeit/);
});

test('Freigabe auffrischen: Erneuern sperrt alte Links, Erinnerung nicht; nur wenn noch offen', () => {
	const ab = n.freigabeAuffrischen({ aktion: 'freigabe_erneuern', freigabe: fg({ ablauf: '2026-10-14T07:00:00Z' }), config: CONFIG, jetzt: JETZT });
	assert.equal(ab.ok, true);
	assert.equal(ab.alteLinksSperren, true);
	assert.equal(new Date(ab.ablauf).getTime() - new Date(JETZT).getTime(), CONFIG.freigabe_ablauf_stunden * 3600000);
	assert.equal(ab.daten.erinnert_am, null);
	const er = n.freigabeAuffrischen({ aktion: 'freigabe_erinnerung', freigabe: fg(), config: CONFIG, jetzt: JETZT });
	assert.equal(er.ok, true);
	assert.equal(er.alteLinksSperren, false);
	assert.equal(er.ablauf, '2026-10-16T08:00:00.000Z');
	assert.equal(n.freigabeAuffrischen({ aktion: 'freigabe_erinnerung', freigabe: fg({ status: 'gesendet' }), config: CONFIG, jetzt: JETZT }).grund, 'nicht_mehr_offen');
	assert.equal(n.freigabeAuffrischen({ aktion: 'freigabe_erneuern', freigabe: fg(), config: CONFIG, jetzt: JETZT }).grund, 'nicht_abgelaufen');
	assert.equal(n.freigabeAuffrischen({ aktion: 'freigabe_erinnerung', freigabe: fg({ erinnert_am: JETZT }), config: CONFIG, jetzt: JETZT }).grund, 'schon_erinnert');
});

test('Token mit eigener Ablaufzeit: abgelaufen -> 410, sonst gültig', () => {
	const f = { id: 1, status: 'offen', ablauf: '2026-10-16T08:00:00Z' };
	const p = (token) => freigabe.freigabePruefen({ token: { id: 1, ...token }, freigabe: f, freigeberErlaubt: true, jetzt: JETZT });
	assert.equal(p({ ablauf: '2026-10-14T07:00:00Z' }).status, 410);
	assert.match(p({ ablauf: '2026-10-14T07:00:00Z' }).meldung, /neuen Link erhalten/);
	assert.equal(p({ ablauf: '2026-10-16T08:00:00Z' }).ok, true);
	assert.equal(p({ ablauf: null }).ok, true); // Links aus M3 ohne eigene Ablaufzeit
	assert.match(freigabe.freigabePruefen({ token: { id: 1 }, freigabe: { ...f, status: 'gesendet', art: 'erinnerung' }, freigeberErlaubt: true, jetzt: JETZT }).meldung, /^Diese Erinnerung/);
});

test('Erinnerungs-Entwurf: Template, Bausteine wortgleich, Sie/Du/en, Hülle besteht die Prüfung', () => {
	const fehlende = [{ feldname: 'Gewicht_kg' }, { feldname: 'Start_PLZ' }];
	const e = entwurf.erinnerungBauen({ config: CONFIG, felder: FELDER, fehlende, name: 'Erika Mustermann' });
	assert.equal(e.fallback, false);
	assert.match(e.text, /^Guten Tag Erika Mustermann,/);
	assert.match(e.text, /freundlich an unsere letzte Nachricht erinnern/);
	for (const b of e.bausteine) assert.ok(e.text.includes(b.text));
	assert.ok(e.html.includes(entwurf.esc(CONFIG.ki_hinweistext)));
	for (const [stil, sprache] of [['Sie', 'de'], ['Du', 'de'], ['Sie', 'en']]) {
		assert.deepEqual(entwurf.huellePruefen(entwurf.vorlageErinnerung({ anrede_stil: stil, sprache }, 'Max'), { anrede_stil: stil }), [], `${stil}/${sprache}`);
	}
	assert.throws(() => entwurf.erinnerungBauen({ config: CONFIG, felder: FELDER, fehlende: [], name: '' }), /keine Erinnerung/);
});

test('Nachricht an Freigeber: Anlass-Hinweis', () => {
	const basis = { vorgang: { vorgangs_id: 'V-1' }, freigabe: { empfaenger: 'a@b', betreff: 'Re: x' }, fehlende: [], link: 'https://x/webhook/epa-freigabe?t=a', ablaufText: '16.10.2026', art: 'erinnerung' };
	assert.match(freigabe.nachrichtFreigeber({ ...basis, anlass: 'freigabe_erneuern' }), /bisherige Link ist abgelaufen/);
	assert.match(freigabe.nachrichtFreigeber({ ...basis, anlass: 'freigabe_erinnerung' }), /noch offen/);
	assert.match(freigabe.nachrichtFreigeber(basis), /^<b>Erinnerung an den Kunden freigeben/);
	assert.match(freigabe.seiteFormular({ token: 't', freigabe: { ...basis.freigabe, art: 'erinnerung', ablauf: JETZT }, vorgang: { vorgangs_id: 'V-1' }, fehlende: [], text: '', abschluss: '' }), /Erinnerung freigeben/);
});
