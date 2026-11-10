'use strict';
// Erweiterte Fallsammlung für Feiertage und Fristen (src/fristen.js). Ostersonntage nach dem gregorianischen
// Kalender; Feiertage nach Landesrecht (Stand der Regeln im Modul).
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../src/fristen');

// ---------------------------------------------------------------- Ostersonntag
const OSTERN = { 2020: '04-12', 2021: '04-04', 2022: '04-17', 2023: '04-09', 2024: '03-31', 2025: '04-20', 2026: '04-05', 2027: '03-28', 2028: '04-16', 2029: '04-01', 2030: '04-21', 2031: '04-13', 2032: '03-28', 2033: '04-17', 2034: '04-09', 2035: '03-25' };
for (const [jahr, md] of Object.entries(OSTERN)) {
	test(`Ostersonntag ${jahr} ist am ${md}`, () => {
		const o = f.ostersonntag(Number(jahr));
		assert.equal(`${String(o.monat).padStart(2, '0')}-${String(o.tag).padStart(2, '0')}`, md);
	});
}

// ---------------------------------------------------------------- bundesweite und regionale Feiertage 2026
const FT = (region) => f.feiertage(2026, region);
const ja = (region, datum, name) => test(`2026 ${region || 'bundesweit'}: ${datum} ist ${name}`, () => assert.equal(FT(region)[datum], name));
const nein = (region, datum, name) => test(`2026 ${region}: ${datum} ist kein Feiertag (${name})`, () => assert.equal(FT(region)[datum], undefined));
ja('', '2026-01-01', 'Neujahr');
ja('', '2026-04-03', 'Karfreitag');
ja('', '2026-04-06', 'Ostermontag');
ja('', '2026-05-01', 'Tag der Arbeit');
ja('', '2026-05-14', 'Christi Himmelfahrt');
ja('', '2026-05-25', 'Pfingstmontag');
ja('', '2026-10-03', 'Tag der Deutschen Einheit');
ja('', '2026-12-25', '1. Weihnachtstag');
ja('', '2026-12-26', '2. Weihnachtstag');
ja('NW', '2026-06-04', 'Fronleichnam');
ja('NW', '2026-11-01', 'Allerheiligen');
nein('NW', '2026-10-31', 'Reformationstag');
nein('NW', '2026-01-06', 'Heilige Drei Könige');
ja('BY', '2026-01-06', 'Heilige Drei Könige');
ja('BW', '2026-01-06', 'Heilige Drei Könige');
ja('ST', '2026-01-06', 'Heilige Drei Könige');
ja('BE', '2026-03-08', 'Internationaler Frauentag');
ja('MV', '2026-03-08', 'Internationaler Frauentag');
nein('HH', '2026-03-08', 'Internationaler Frauentag');
ja('SL', '2026-08-15', 'Mariä Himmelfahrt');
nein('BY', '2026-08-15', 'Mariä Himmelfahrt nur in Teilen Bayerns');
ja('TH', '2026-09-20', 'Weltkindertag');
ja('NI', '2026-10-31', 'Reformationstag');
ja('SN', '2026-10-31', 'Reformationstag');
ja('HH', '2026-10-31', 'Reformationstag');
ja('SN', '2026-11-18', 'Buß- und Bettag');
nein('BY', '2026-11-18', 'Buß- und Bettag');
nein('BE', '2026-06-04', 'Fronleichnam');
test('Buß- und Bettag 2025 (SN) ist am 19.11.', () => assert.equal(f.feiertage(2025, 'SN')['2025-11-19'], 'Buß- und Bettag'));
test('Buß- und Bettag 2027 (SN) ist am 17.11.', () => assert.equal(f.feiertage(2027, 'SN')['2027-11-17'], 'Buß- und Bettag'));
test('Reformationstag in NI erst ab 2018', () => {
	assert.equal(f.feiertage(2017, 'NI')['2017-10-31'], undefined);
	assert.equal(f.feiertage(2018, 'NI')['2018-10-31'], 'Reformationstag');
});
test('Frauentag in MV erst ab 2023', () => {
	assert.equal(f.feiertage(2022, 'MV')['2022-03-08'], undefined);
	assert.equal(f.feiertage(2023, 'MV')['2023-03-08'], 'Internationaler Frauentag');
});
test('zusätzliche Feiertage aus der Config (Text und Objekt)', () => {
	const l = f.feiertage(2026, 'NW', ['2026-12-24', { datum: '2026-12-31', name: 'Silvester (Betriebsruhe)' }, '2027-01-02']);
	assert.equal(l['2026-12-24'], 'Zusätzlicher Feiertag (Config)');
	assert.equal(l['2026-12-31'], 'Silvester (Betriebsruhe)');
	assert.equal(l['2027-01-02'], undefined);
});
test('unbekannte Feiertagsregion wird abgelehnt', () => assert.throws(() => f.feiertage(2026, 'XX'), /Unbekannte Feiertagsregion/));
test('Region klein geschrieben wird erkannt', () => assert.equal(f.feiertage(2026, 'nw')['2026-06-04'], 'Fronleichnam'));

// ---------------------------------------------------------------- Fristen
const GZ = { frist_nur_geschaeftszeit: true, feiertage_region: 'NW', zeitzone: 'Europe/Berlin', geschaeftszeiten: { tage: [1, 2, 3, 4, 5], von: '08:00', bis: '17:00' } };
const frist = (start, h, cfg) => f.berechneFrist(start, h, cfg).slice(0, 16);
test('ohne Geschäftszeit: 48 h ab Dienstag 10:00 = Donnerstag 10:00', () => assert.equal(frist('2026-11-10T10:00:00+01:00', 48, { frist_nur_geschaeftszeit: false }), '2026-11-12T10:00'));
test('Geschäftszeit: 9 h ab Dienstag 08:00 = Dienstag 17:00', () => assert.equal(frist('2026-11-10T08:00:00+01:00', 9, GZ), '2026-11-10T17:00'));
test('Geschäftszeit: 2 h ab Dienstag 16:00 = Mittwoch 09:00', () => assert.equal(frist('2026-11-10T16:00:00+01:00', 2, GZ), '2026-11-11T09:00'));
test('Geschäftszeit: Start am Abend zählt ab nächstem Morgen', () => assert.equal(frist('2026-11-10T20:00:00+01:00', 1, GZ), '2026-11-11T09:00'));
test('Geschäftszeit: Start vor 8 Uhr zählt ab 8 Uhr', () => assert.equal(frist('2026-11-10T06:00:00+01:00', 1, GZ), '2026-11-10T09:00'));
test('Geschäftszeit: Freitag 16:00 + 2 h = Montag 09:00', () => assert.equal(frist('2026-11-13T16:00:00+01:00', 2, GZ), '2026-11-16T09:00'));
test('Geschäftszeit: Samstag zählt nicht', () => assert.equal(frist('2026-11-14T10:00:00+01:00', 1, GZ), '2026-11-16T09:00'));
test('Geschäftszeit: Weihnachten (NW) wird übersprungen', () => assert.equal(frist('2026-12-24T16:00:00+01:00', 2, GZ), '2026-12-28T09:00'));
test('Geschäftszeit: Allerheiligen 2027 (Montag, NW) wird übersprungen', () => assert.equal(frist('2027-10-29T16:00:00+02:00', 2, GZ), '2027-11-02T09:00'));
test('Geschäftszeit: 48 h = 5 Arbeitstage + 3 h', () => assert.equal(frist('2026-11-09T08:00:00+01:00', 48, GZ), '2026-11-16T11:00'));
test('Frist über Zeitumstellung (Sommerzeit Ende) bleibt in Ortszeit', () => assert.equal(frist('2026-10-23T16:00:00+02:00', 2, GZ), '2026-10-26T09:00'));
test('Frist 0 Stunden = Start (ohne Geschäftszeit)', () => assert.equal(frist('2026-11-10T10:00:00+01:00', 0, { frist_nur_geschaeftszeit: false }), '2026-11-10T10:00'));
test('negative Frist wird abgelehnt', () => assert.throws(() => f.berechneFrist('2026-11-10T10:00:00+01:00', -1, GZ), /Ungültige Fristdauer/));
test('ungültige Geschäftszeit (bis vor von) wird abgelehnt', () => assert.throws(() => f.zeitConfig({ geschaeftszeiten: { von: '17:00', bis: '08:00' } }), /bis muss nach/));
test('ungültiger Wochentag in Geschäftszeiten wird abgelehnt', () => assert.throws(() => f.zeitConfig({ geschaeftszeiten: { tage: [0, 1] } }), /tage/));
test('ungültige Uhrzeit wird abgelehnt', () => assert.throws(() => f.zeitConfig({ geschaeftszeiten: { von: '8 Uhr' } }), /Ungültige Uhrzeit/));
test('Samstag als Arbeitstag (tage 1–6) zählt mit', () => assert.equal(frist('2026-11-14T10:00:00+01:00', 1, { ...GZ, geschaeftszeiten: { tage: [1, 2, 3, 4, 5, 6], von: '08:00', bis: '17:00' } }), '2026-11-14T11:00'));

// ---------------------------------------------------------------- Geschäftszeit und Überfälligkeit
test('Dienstag 10:00 ist Geschäftszeit', () => assert.equal(f.istGeschaeftszeit('2026-11-10T10:00:00+01:00', GZ), true));
test('Dienstag 17:00 ist keine Geschäftszeit mehr', () => assert.equal(f.istGeschaeftszeit('2026-11-10T17:00:00+01:00', GZ), false));
test('Sonntag ist keine Geschäftszeit', () => assert.equal(f.istGeschaeftszeit('2026-11-15T10:00:00+01:00', GZ), false));
test('Tag der Deutschen Einheit ist keine Geschäftszeit', () => assert.equal(f.istGeschaeftszeit('2027-10-04T10:00:00+02:00', { ...GZ, zusaetzliche_feiertage: ['2027-10-04'] }), false));
test('UTC-Zeitpunkt wird in Ortszeit gewertet (07:30 UTC = 08:30 Berlin)', () => assert.equal(f.istGeschaeftszeit('2026-11-10T07:30:00Z', GZ), true));
test('Frist in der Vergangenheit ist überfällig', () => assert.equal(f.istUeberfaellig('2026-11-10T10:00:00Z', '2026-11-10T10:00:01Z'), true));
test('Frist in der Zukunft ist nicht überfällig', () => assert.equal(f.istUeberfaellig('2026-11-10T10:00:00Z', '2026-11-10T09:59:59Z'), false));
test('ohne Frist nie überfällig', () => assert.equal(f.istUeberfaellig(null, '2026-11-10T10:00:00Z'), false));
test('Fristvergleich über Zeitzonen hinweg', () => assert.equal(f.istUeberfaellig('2026-11-10T11:00:00+01:00', '2026-11-10T10:30:00Z'), true));
