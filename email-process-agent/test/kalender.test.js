'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const k = require('../src/kalender');
const freigabe = require('../src/freigabe');

const CONFIG = {
	zeitzone: 'Europe/Berlin',
	geschaeftszeiten: { tage: [1, 2, 3, 4, 5], von: '08:00', bis: '17:00' },
	kalender: { aktiv: true, vorgangstyp: 'termin', datum_feld: 'Wunschtermin', uhrzeit_feld: 'Uhrzeit', titel_feld: 'Terminanlass', ort_feld: 'Terminort', dauer_minuten: 60, gueltig_stunden: 72 },
};
const vorgang = (werte, typ = 'termin') => ({
	vorgangs_id: 'V-2026-0400',
	vorgangstyp: typ,
	extrahierte_daten: Object.fromEntries(Object.entries(werte).map(([f, w]) => [f, { wert: w }])),
});
const JETZT = '2026-11-01T12:00:00Z';
const ev = (von, bis, extra = {}) => ({ start: { dateTime: von, timeZone: 'UTC' }, end: { dateTime: bis, timeZone: 'UTC' }, showAs: 'busy', ...extra });

test('uhrzeitLesen: genaue Zeiten', () => {
	assert.deepEqual(k.uhrzeitLesen('10 Uhr'), { art: 'exakt', von: '10:00' });
	assert.deepEqual(k.uhrzeitLesen('um 9'), { art: 'exakt', von: '09:00' });
	assert.deepEqual(k.uhrzeitLesen('14.30'), { art: 'exakt', von: '14:30' });
	assert.deepEqual(k.uhrzeitLesen('10:15 Uhr'), { art: 'exakt', von: '10:15' });
	assert.deepEqual(k.uhrzeitLesen('2 pm'), { art: 'exakt', von: '14:00' });
	assert.deepEqual(k.uhrzeitLesen('2:30 p.m.'), { art: 'exakt', von: '14:30' });
	assert.deepEqual(k.uhrzeitLesen('ab 9 Uhr'), { art: 'exakt', von: '09:00' });
});

test('uhrzeitLesen: Zeiträume und Tageszeiten', () => {
	assert.deepEqual(k.uhrzeitLesen('zwischen 9 und 11 Uhr'), { art: 'zeitraum', von: '09:00', bis: '11:00' });
	assert.deepEqual(k.uhrzeitLesen('9-11 Uhr'), { art: 'zeitraum', von: '09:00', bis: '11:00' });
	assert.deepEqual(k.uhrzeitLesen('13:30 – 15:00'), { art: 'zeitraum', von: '13:30', bis: '15:00' });
	assert.equal(k.uhrzeitLesen('vormittags').von, '08:00');
	assert.equal(k.uhrzeitLesen('nachmittags').bis, '17:00');
	assert.equal(k.uhrzeitLesen('in the afternoon').von, '13:00');
	assert.equal(k.uhrzeitLesen('am Dienstag'), null, '"am" ist im Deutschen keine Tageszeit');
	assert.equal(k.uhrzeitLesen(''), null);
	assert.equal(k.uhrzeitLesen('25 Uhr'), null);
});

test('zuIso: Winter- und Sommerzeit', () => {
	assert.equal(k.zuIso('2026-12-03', '10:00', 'Europe/Berlin'), '2026-12-03T10:00:00+01:00');
	assert.equal(k.zuIso('2026-07-03', '10:00', 'Europe/Berlin'), '2026-07-03T10:00:00+02:00');
	assert.equal(k.zuIso('2026-12-03', '10:00', 'Europe/London'), '2026-12-03T10:00:00+00:00');
});

test('plan: nur für die eingestellte Vorgangsart, mit Datum und aktivem Kalender', () => {
	assert.equal(k.plan({ ...CONFIG, kalender: null }, vorgang({ Wunschtermin: '2026-12-03' }), JETZT).relevant, false);
	assert.equal(k.plan({ ...CONFIG, kalender: { ...CONFIG.kalender, aktiv: false } }, vorgang({ Wunschtermin: '2026-12-03' }), JETZT).relevant, false);
	assert.equal(k.plan(CONFIG, vorgang({ Wunschtermin: '2026-12-03' }, 'bestellung'), JETZT).relevant, false);
	assert.equal(k.plan(CONFIG, vorgang({ Terminanlass: 'Besichtigung' }), JETZT).grund, 'kein Datum');
});

test('plan: genaue Uhrzeit ergibt ein Fenster mit Termindauer', () => {
	const p = k.plan(CONFIG, vorgang({ Wunschtermin: '2026-12-03', Uhrzeit: '10 Uhr', Terminanlass: 'Besichtigung', Terminort: 'Lager Dortmund' }), JETZT);
	assert.equal(p.relevant, true);
	assert.equal(p.art, 'exakt');
	assert.equal(p.start_iso, '2026-12-03T10:00:00+01:00');
	assert.equal(p.ende_iso, '2026-12-03T11:00:00+01:00');
	assert.equal(p.titel, 'Besichtigung');
	assert.equal(p.ort, 'Lager Dortmund');
	assert.deepEqual(p.hinweise, []);
});

test('plan: ohne Uhrzeit wird die Geschäftszeit geprüft, mit Hinweis', () => {
	const p = k.plan(CONFIG, vorgang({ Wunschtermin: '2026-12-03' }), JETZT);
	assert.equal(p.art, 'zeitraum');
	assert.equal(p.von, '08:00');
	assert.equal(p.bis, '17:00');
	assert.match(p.hinweise[0], /Keine genaue Uhrzeit/);
});

test('plan: Wochenende, Vergangenheit und außerhalb der Geschäftszeit', () => {
	assert.match(k.plan(CONFIG, vorgang({ Wunschtermin: '2026-12-05', Uhrzeit: '10 Uhr' }), JETZT).hinweise.join(), /Geschäftstage/);
	assert.match(k.plan(CONFIG, vorgang({ Wunschtermin: '2026-10-01', Uhrzeit: '10 Uhr' }), JETZT).hinweise.join(), /Vergangenheit/);
	assert.match(k.plan(CONFIG, vorgang({ Wunschtermin: '2026-12-03', Uhrzeit: '19 Uhr' }), JETZT).hinweise.join(), /Geschäftszeit/);
});

test('bewerten: genauer Termin frei bzw. belegt', () => {
	const p = k.plan(CONFIG, vorgang({ Wunschtermin: '2026-12-03', Uhrzeit: '10 Uhr' }), JETZT);
	// 10:00 Berlin = 09:00 UTC
	const frei = k.bewerten(p, [ev('2026-12-03T07:00:00.0000000', '2026-12-03T09:00:00.0000000')]);
	assert.equal(frei.frei, true);
	assert.equal(frei.vorschlaege.length, 1);
	const belegt = k.bewerten(p, [ev('2026-12-03T09:30:00.0000000', '2026-12-03T10:30:00.0000000')]);
	assert.equal(belegt.frei, false);
	assert.deepEqual(belegt.konflikte, [{ von: '10:30', bis: '11:30', ganztags: false }]);
});

test('bewerten: als frei markierte und abgesagte Termine zählen nicht', () => {
	const p = k.plan(CONFIG, vorgang({ Wunschtermin: '2026-12-03', Uhrzeit: '10 Uhr' }), JETZT);
	const r = k.bewerten(p, [
		ev('2026-12-03T09:00:00', '2026-12-03T10:00:00', { showAs: 'free' }),
		ev('2026-12-03T09:00:00', '2026-12-03T10:00:00', { isCancelled: true }),
	]);
	assert.equal(r.frei, true);
});

test('bewerten: Zeitraum liefert bis zu drei freie Zeiten', () => {
	const p = k.plan(CONFIG, vorgang({ Wunschtermin: '2026-12-03', Uhrzeit: 'vormittags' }), JETZT);
	// belegt 08:00–09:30 Berlin
	const r = k.bewerten(p, [ev('2026-12-03T07:00:00', '2026-12-03T08:30:00')]);
	assert.equal(r.frei, true);
	assert.deepEqual(r.vorschlaege.map((v) => v.text), ['Do 03.12.2026, 09:30–10:30 Uhr', 'Do 03.12.2026, 10:00–11:00 Uhr', 'Do 03.12.2026, 10:30–11:30 Uhr']);
});

test('ausweichen: freie Zeiten am selben Tag, wenn der Wunsch belegt ist', () => {
	const p = k.plan(CONFIG, vorgang({ Wunschtermin: '2026-12-03', Uhrzeit: '08:00' }), JETZT);
	const alt = k.ausweichen(p, [ev('2026-12-03T07:00:00', '2026-12-03T09:00:00')], CONFIG.geschaeftszeiten);
	assert.equal(alt[0].text, 'Do 03.12.2026, 10:00–11:00 Uhr');
	assert.equal(alt.length, 3);
});

test('ereignis: Graph-Body mit lokaler Zeit, Ort und transactionId', () => {
	const e = k.ereignis({
		termin: { termin_id: 'K-1', vorgangs_id: 'V-2026-0400', titel: 'Besichtigung', ort: 'Lager', kontakt: 'Markus Brandt', telefon: '0231 5557022', absender: 'm@example.org' },
		slot: { start_iso: '2026-12-03T09:00:00.000Z', ende_iso: '2026-12-03T10:00:00.000Z' },
		zone: 'Europe/Berlin',
	});
	assert.equal(e.subject, 'Besichtigung – Markus Brandt');
	assert.deepEqual(e.start, { dateTime: '2026-12-03T10:00:00', timeZone: 'Europe/Berlin' });
	assert.deepEqual(e.end, { dateTime: '2026-12-03T11:00:00', timeZone: 'Europe/Berlin' });
	assert.equal(e.location.displayName, 'Lager');
	assert.equal(e.transactionId, 'K-1');
	assert.match(e.body.content, /V-2026-0400/);
});

test('meldung: frei, belegt mit Ausweichzeiten, Lesefehler; Inhalte werden escaped', () => {
	const p = k.plan(CONFIG, vorgang({ Wunschtermin: '2026-12-03', Uhrzeit: '10 Uhr', Terminanlass: '<b>Besichtigung</b>' }), JETZT);
	const frei = k.meldung({ vorgangs_id: 'V-1', plan: p, ergebnis: { frei: true, konflikte: [], vorschlaege: [] }, link: 'https://x/webhook/epa-kalender?t=a', ablaufText: '04.12.2026, 12:00' });
	assert.match(frei, /Der Termin ist frei/);
	assert.match(frei, /Termin in den Kalender eintragen/);
	assert.doesNotMatch(frei, /<b>Besichtigung<\/b>/);
	const belegt = k.meldung({ vorgangs_id: 'V-1', plan: p, ergebnis: { frei: false, konflikte: [{ von: '10:00', bis: '11:00' }], vorschlaege: [], ausweichen: [{ text: 'Do 03.12.2026, 13:00–14:00 Uhr' }] } });
	assert.match(belegt, /belegt/);
	assert.match(belegt, /13:00–14:00/);
	assert.match(k.meldung({ vorgangs_id: 'V-1', plan: p, fehler: 'Zugriff verweigert' }), /nicht gelesen werden/);
});

test('seiteFormular und formularLesen', () => {
	const termin = { vorgangs_id: 'V-1', titel: 'Besichtigung', wunsch_text: 'Do 03.12.2026, 10:00–11:00 Uhr', vorschlaege: [{ start_iso: 'a', text: 'A' }], ausweichen: [{ start_iso: 'a', text: 'A' }, { start_iso: 'b', text: 'B' }] };
	const html = k.seiteFormular(freigabe.seite, { token: 'x'.repeat(43), termin });
	assert.match(html, /In den Kalender eintragen/);
	assert.equal((html.match(/type="radio"/g) || []).length, 2, 'doppelte Zeiten nur einmal');
	assert.deepEqual(k.formularLesen({ aktion: 'eintragen', slot: '1' }, 2), { ok: true, aktion: 'eintragen', slot: 1 });
	assert.equal(k.formularLesen({ aktion: 'eintragen', slot: '5' }, 2).ok, false);
	assert.deepEqual(k.formularLesen({ aktion: 'verwerfen' }, 0), { ok: true, aktion: 'verwerfen' });
	assert.equal(k.formularLesen({ aktion: 'loeschen' }, 2).ok, false);
});

test('terminPruefen: Status und Ablauf', () => {
	const t = { id: 1, status: 'offen', ablauf: '2026-11-05T00:00:00Z' };
	assert.equal(k.terminPruefen(t, JETZT).ok, true);
	assert.equal(k.terminPruefen({ ...t, status: 'eingetragen' }, JETZT).status, 409);
	assert.equal(k.terminPruefen({ ...t, ablauf: '2026-10-01T00:00:00Z' }, JETZT).status, 410);
	assert.equal(k.terminPruefen(null, JETZT).status, 404);
});
