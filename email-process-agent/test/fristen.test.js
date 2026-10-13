'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { ostersonntag, feiertage, berechneFrist, istGeschaeftszeit, istUeberfaellig, zeitConfig } = require('../src/fristen');

const NRW = {
	zeitzone: 'Europe/Berlin',
	frist_nur_geschaeftszeit: true,
	geschaeftszeiten: { tage: [1, 2, 3, 4, 5], von: '08:00', bis: '17:00' },
	feiertage_region: 'NW',
};
const lokal = (iso) => DateTime.fromISO(iso, { setZone: true }).setZone('Europe/Berlin').toFormat("yyyy-MM-dd'T'HH:mm");

test('Ostersonntag', () => {
	assert.deepEqual(ostersonntag(2024), { monat: 3, tag: 31 });
	assert.deepEqual(ostersonntag(2026), { monat: 4, tag: 5 });
	assert.deepEqual(ostersonntag(2027), { monat: 3, tag: 28 });
	assert.deepEqual(ostersonntag(2038), { monat: 4, tag: 25 });
});

test('Feiertage NRW 2026', () => {
	const f = feiertage(2026, 'NW');
	for (const d of ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25', '2026-06-04', '2026-10-03', '2026-11-01', '2026-12-25', '2026-12-26']) {
		assert.ok(f[d], `${d} fehlt`);
	}
	assert.equal(f['2026-10-31'], undefined, 'Reformationstag ist in NRW kein Feiertag');
	assert.equal(f['2026-01-06'], undefined);
});

test('regionale Feiertage', () => {
	assert.ok(feiertage(2026, 'BY')['2026-01-06']);
	assert.ok(feiertage(2026, 'NI')['2026-10-31']);
	assert.ok(feiertage(2026, 'BE')['2026-03-08']);
	assert.ok(feiertage(2026, 'TH')['2026-09-20']);
	assert.ok(feiertage(2026, 'SL')['2026-08-15']);
	assert.equal(feiertage(2026, 'SN')['2026-11-18'], 'Buß- und Bettag');
	assert.equal(feiertage(2027, 'SN')['2027-11-17'], 'Buß- und Bettag');
	assert.ok(feiertage(2026, 'NW', ['2026-12-24'])['2026-12-24']);
	assert.throws(() => feiertage(2026, 'XX'), /Unbekannte Feiertagsregion/);
});

test('ohne Geschäftszeit-Modus: absolute Stunden', () => {
	const r = berechneFrist('2026-10-16T16:00:00+02:00', 48, { ...NRW, frist_nur_geschaeftszeit: false });
	assert.equal(lokal(r), '2026-10-18T16:00');
});

test('absolute Stunden über Zeitumstellung (Ende Sommerzeit 25.10.2026)', () => {
	const r = berechneFrist('2026-10-24T12:00:00+02:00', 24, { ...NRW, frist_nur_geschaeftszeit: false });
	// 24 echte Stunden: Uhr wird um 1 h zurückgestellt
	assert.equal(lokal(r), '2026-10-25T11:00');
});

test('Geschäftszeit: Freitag 16:00 + 2 h -> Montag 09:00', () => {
	assert.equal(lokal(berechneFrist('2026-10-16T16:00:00+02:00', 2, NRW)), '2026-10-19T09:00');
});

test('Geschäftszeit: 48 h = gut 5 Arbeitstage', () => {
	// Mo 12.10. 10:00 + 48 Geschäftsstunden (9 h/Tag): Rest Mo 7 h, Di-Fr 36 h = 43 h, Mo 19.10. 5 h -> 13:00
	assert.equal(lokal(berechneFrist('2026-10-12T10:00:00+02:00', 48, NRW)), '2026-10-19T13:00');
});

test('Geschäftszeit: Start außerhalb (Samstag, nachts, vor Beginn)', () => {
	assert.equal(lokal(berechneFrist('2026-10-17T11:00:00+02:00', 1, NRW)), '2026-10-19T09:00');
	assert.equal(lokal(berechneFrist('2026-10-14T22:30:00+02:00', 1, NRW)), '2026-10-15T09:00');
	assert.equal(lokal(berechneFrist('2026-10-14T06:00:00+02:00', 1, NRW)), '2026-10-14T09:00');
});

test('Geschäftszeit: Feiertage werden übersprungen (Allerheiligen-Wochenende, Weihnachten)', () => {
	// Fr 30.10.2026 16:00 + 2 h -> Mo 02.11. 09:00 (01.11. ist Sonntag)
	assert.equal(lokal(berechneFrist('2026-10-30T16:00:00+01:00', 2, NRW)), '2026-11-02T09:00');
	// Do 24.12.2026 16:00 + 2 h -> 25./26. Feiertag, 27. So -> Mo 28.12. 09:00
	assert.equal(lokal(berechneFrist('2026-12-24T16:00:00+01:00', 2, NRW)), '2026-12-28T09:00');
	// Mi 03.06.2026 16:00 + 2 h -> Do 04.06. Fronleichnam (NRW) -> Fr 05.06. 09:00
	assert.equal(lokal(berechneFrist('2026-06-03T16:00:00+02:00', 2, NRW)), '2026-06-05T09:00');
	// in Niedersachsen ist Fronleichnam kein Feiertag
	assert.equal(lokal(berechneFrist('2026-06-03T16:00:00+02:00', 2, { ...NRW, feiertage_region: 'NI' })), '2026-06-04T09:00');
});

test('Geschäftszeit über Zeitumstellung bleibt bei Wanduhrzeit', () => {
	// Fr 23.10. 16:00 (MESZ) + 2 h -> Mo 26.10. 09:00 (MEZ)
	const r = berechneFrist('2026-10-23T16:00:00+02:00', 2, NRW);
	assert.equal(lokal(r), '2026-10-26T09:00');
	assert.match(r, /\+01:00$/);
	// Frühjahr: Fr 27.03.2026 16:00 (MEZ) + 2 h -> Mo 30.03. 09:00 (MESZ)
	assert.match(berechneFrist('2026-03-27T16:00:00+01:00', 2, NRW), /^2026-03-30T09:00:00\.000\+02:00$/);
});

test('Start in UTC wird in Zielzeitzone gerechnet', () => {
	assert.equal(lokal(berechneFrist('2026-10-14T14:30:00Z', 1, NRW)), '2026-10-15T08:30');
});

test('Bruchteile von Stunden und Frist 0', () => {
	assert.equal(lokal(berechneFrist('2026-10-14T10:00:00+02:00', 1.5, NRW)), '2026-10-14T11:30');
	assert.equal(lokal(berechneFrist('2026-10-14T10:00:00+02:00', 0, NRW)), '2026-10-14T10:00');
});

test('istGeschaeftszeit', () => {
	assert.equal(istGeschaeftszeit('2026-10-14T10:00:00+02:00', NRW), true);
	assert.equal(istGeschaeftszeit('2026-10-14T17:00:00+02:00', NRW), false);
	assert.equal(istGeschaeftszeit('2026-10-17T10:00:00+02:00', NRW), false);
	assert.equal(istGeschaeftszeit('2026-10-03T10:00:00+02:00', NRW), false);
});

test('istUeberfaellig', () => {
	assert.equal(istUeberfaellig('2026-10-14T10:00:00+02:00', '2026-10-14T08:00:01Z'), true);
	assert.equal(istUeberfaellig('2026-10-14T10:00:00+02:00', '2026-10-14T07:59:59Z'), false);
	assert.equal(istUeberfaellig(null), false);
});

test('ungültige Eingaben werden abgelehnt', () => {
	assert.throws(() => berechneFrist('kein Datum', 1, NRW), /Ungültiger Zeitpunkt/);
	assert.throws(() => berechneFrist('2026-10-14T10:00:00Z', -1, NRW), /Ungültige Fristdauer/);
	assert.throws(() => berechneFrist('2026-10-14T10:00:00Z', 1, { ...NRW, zeitzone: 'Mars/Olympus' }), /Ungültige Zeitzone/);
	assert.throws(() => zeitConfig({ geschaeftszeiten: { von: '17:00', bis: '08:00' } }), /bis muss nach/);
	assert.throws(() => zeitConfig({ geschaeftszeiten: { tage: [0] } }), /tage/);
});

test('beliebige Arbeitstage (nur Samstag 08-09 Uhr)', () => {
	const cfg = { ...NRW, geschaeftszeiten: { tage: [6], von: '08:00', bis: '09:00' } };
	assert.equal(lokal(berechneFrist('2026-10-14T10:00:00+02:00', 1.5, cfg)), '2026-10-24T08:30');
});
