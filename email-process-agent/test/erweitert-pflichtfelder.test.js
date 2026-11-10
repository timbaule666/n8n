'use strict';
// Erweiterte Fallsammlung für die Pflichtfeld-Prüfung: je Fall ein eigener Test, damit ein Fehler genau zeigt,
// welche Schreibweise nicht (mehr) erkannt wird. Erwartungen folgen den Regeln in src/pflichtfelder.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/pflichtfelder');

const HEUTE = '2026-11-10';
const feld = (typ, validierungsregel) => ({ feldname: 'f', anzeigename: 'F', typ, validierungsregel: validierungsregel || {} });
const gut = (typ, roh, wert, regel) => test(`${typ}: "${roh}" ist gültig → ${JSON.stringify(wert)}`, () => {
	const r = p.feldPruefen(feld(typ, regel), roh, { heute: HEUTE });
	assert.equal(r.ok, true, r.grund);
	assert.deepEqual(r.wert, wert);
});
const schlecht = (typ, roh, grundMuster, regel) => test(`${typ}: "${roh}" ist ungültig`, () => {
	const r = p.feldPruefen(feld(typ, regel), roh, { heute: HEUTE });
	assert.equal(r.ok, false, 'unerwartet gültig: ' + JSON.stringify(r.wert));
	if (grundMuster) assert.match(r.grund, grundMuster);
});

// ---------------------------------------------------------------- Telefon (6–20 Ziffern)
gut('telefon', '0231 5557731', '02315557731');
gut('telefon', '0231/5557731', '02315557731');
gut('telefon', '0231-555 77 31', '02315557731');
gut('telefon', '(0231) 5557731', '02315557731');
gut('telefon', '+49 231 5557731', '+492315557731');
gut('telefon', '+49 (0) 231 5557731', '+492315557731');
gut('telefon', '+49(0)231-5557731', '+492315557731');
gut('telefon', '+43 732 5557403', '+437325557403');
gut('telefon', '+44 20 7946 0811', '+442079460811');
gut('telefon', '0171 1234567', '01711234567');
gut('telefon', '0171.1234567', '01711234567');
gut('telefon', '030 – 1234567', '0301234567');
gut('telefon', '123456', '123456');
gut('telefon', '12345678901234567890', '12345678901234567890');
schlecht('telefon', '12', /Anzahl Ziffern/);
schlecht('telefon', '12345', /Anzahl Ziffern/);
schlecht('telefon', '123456789012345678901', /Anzahl Ziffern/);
schlecht('telefon', 'Tel. 0231 5557731', /Telefonnummer/);
schlecht('telefon', 'folgt', /Telefonnummer/);
schlecht('telefon', 'ruf an: 0231', /Telefonnummer/);
schlecht('telefon', '0231 5557731 oder 0172 9999999 abends', /Telefonnummer/);
schlecht('telefon', 'abc', /Telefonnummer/);
schlecht('telefon', '+', /Anzahl Ziffern/);
schlecht('telefon', '0231 555', /Anzahl Ziffern/, { min_ziffern: 8, max_ziffern: 15 });
gut('telefon', '0231 55577', '023155577', { min_ziffern: 8, max_ziffern: 15 });

// ---------------------------------------------------------------- PLZ mit fester Regel (nur Deutschland, 5 Ziffern)
const DE = { regex: '^\\d{5}$' };
gut('plz', '44135', '44135', DE);
gut('plz', ' 44135 ', '44135', DE);
gut('plz', 'D-44135', '44135', DE);
gut('plz', 'DE 44135', '44135', DE);
gut('plz', 'de-44135', '44135', DE);
gut('plz', '01067', '01067', DE);
schlecht('plz', '4413', /Postleitzahl/, DE);
schlecht('plz', '441355', /Postleitzahl/, DE);
schlecht('plz', 'A-4020', /Postleitzahl/, DE);
schlecht('plz', '44l35', /Postleitzahl/, DE);
schlecht('plz', 'Dortmund', /Postleitzahl/, DE);

// ---------------------------------------------------------------- PLZ ohne feste Regel (Länderliste)
gut('plz', '4020', '4020');
gut('plz', 'A-4020', '4020');
gut('plz', 'AT 4020', '4020');
gut('plz', 'CH-8001', '8001');
gut('plz', 'NL-1012 AB', '1012AB');
gut('plz', '1012 AB', '1012AB');
gut('plz', 'F-75001', '75001');
gut('plz', 'PL 00-001', '00001');
gut('plz', 'DK-1050', '1050');
schlecht('plz', 'US-10001', /Postleitzahl/);
schlecht('plz', 'GB-SW1A', /Postleitzahl/);
schlecht('plz', '123', /Postleitzahl/);
schlecht('plz', 'A-44135', /Postleitzahl/);
schlecht('plz', 'CH-80011', /Postleitzahl/);
gut('plz', 'A-4020', '4020', { laender: ['AT'] });
schlecht('plz', '44135', /Postleitzahl/, { laender: ['AT'] });
schlecht('plz', 'D-44135', /Postleitzahl/, { laender: ['AT', 'CH'] });

// ---------------------------------------------------------------- Datum (heute = 10.11.2026)
gut('datum', '2026-12-19', '2026-12-19');
gut('datum', '19.12.2026', '2026-12-19');
gut('datum', '19.12.26', '2026-12-19');
gut('datum', '19/12/2026', '2026-12-19');
gut('datum', '9.1.2027', '2027-01-09');
gut('datum', '2026-12-19T10:00:00Z', '2026-12-19');
gut('datum', '19.12.', '2026-12-19');
gut('datum', '15.1.', '2027-01-15');
gut('datum', '10.11.', '2026-11-10');
gut('datum', '9.11.', '2027-11-09');
gut('datum', '29.02.2028', '2028-02-29');
schlecht('datum', '29.02.2027', /Datum/);
schlecht('datum', '31.04.2027', /Datum/);
schlecht('datum', '32.12.2026', /Datum/);
schlecht('datum', 'nächste Woche', /Datum/);
schlecht('datum', 'Mitte Dezember', /Datum/);
schlecht('datum', '19.12.2026 oder 20.12.2026', /Datum/);
schlecht('datum', '2026-11-09', /zu früh/, { min_tage_ab_heute: 0 });
gut('datum', '2026-11-10', '2026-11-10', { min_tage_ab_heute: 0 });
schlecht('datum', '2027-12-01', /zu weit/, { max_tage_ab_heute: 365 });
gut('datum', '2027-11-10', '2027-11-10', { max_tage_ab_heute: 365 });
schlecht('datum', '2026-12-01', /zu weit/, { min_tage_ab_heute: -365, max_tage_ab_heute: 0 });
gut('datum', '2026-11-04', '2026-11-04', { min_tage_ab_heute: -365, max_tage_ab_heute: 0 });

// ---------------------------------------------------------------- Zahlen (Gewicht, Menge)
gut('zahl', '1200', 1200);
gut('zahl', '1.200', 1200);
gut('zahl', '1.200,5', 1200.5);
gut('zahl', '1,200.5', 1200.5);
gut('zahl', '1,200', 1200);
gut('zahl', '1,5', 1.5);
gut('zahl', '0,75', 0.75);
gut('zahl', '1200 kg', 1200);
gut('zahl', '1200kg', 1200);
gut('zahl', 'ca. 800', 800);
gut('zahl', 'circa 800 kg', 800);
gut('zahl', '~ 950', 950);
gut('zahl', '3 Paletten', 3);
gut('zahl', '12 Stück', 12);
gut('zahl', '2 t', 2);
gut('zahl', "1'200", 1200);
gut('zahl', '1 200', 1200);
gut('zahl', 1500, 1500);
schlecht('zahl', 'viel', /keine Zahl/);
schlecht('zahl', '12-15', /keine Zahl/);
schlecht('zahl', '1200 Kartons à 5 kg', /keine Zahl/);
schlecht('zahl', '2,5', /ganze Zahl/, { ganzzahl: true });
gut('zahl', '3', 3, { ganzzahl: true });
schlecht('zahl', '0', /kleiner als 1/, { min: 1 });
schlecht('zahl', '30000', /größer als 24000/, { max: 24000 });
gut('zahl', '24.000', 24000, { max: 24000 });

// ---------------------------------------------------------------- E-Mail
gut('email', 'max@firma.de', 'max@firma.de');
gut('email', 'Max.Mustermann@Firma.DE', 'max.mustermann@firma.de');
gut('email', 'mailto:max@firma.de', 'max@firma.de');
gut('email', "o'brien@firma.co.uk", "o'brien@firma.co.uk");
gut('email', 'a+b@sub.firma.de', 'a+b@sub.firma.de');
schlecht('email', 'max@firma', /E-Mail/);
schlecht('email', 'max.firma.de', /E-Mail/);
schlecht('email', 'max@@firma.de', /E-Mail/);
schlecht('email', 'max @firma.de', /E-Mail/);
schlecht('email', 'max@firma.d', /E-Mail/);

// ---------------------------------------------------------------- Ansprechpartner (Person)
const PERSON = { person: true, min_laenge: 2, max_laenge: 80 };
gut('text', 'Jana Wolff', 'Jana Wolff', PERSON);
gut('text', 'Herr Max Müller', 'Max Müller', PERSON);
gut('text', 'Frau Dr. Anna Schmidt', 'Dr. Anna Schmidt', PERSON);
gut('text', 'Hr. Klein', 'Klein', PERSON);
gut('text', 'Mrs. Emma Clarke', 'Emma Clarke', PERSON);
gut('text', '  Jana   Wolff  ', 'Jana Wolff', PERSON);
schlecht('text', 'Dispositionsteam', /Personenname/, PERSON);
schlecht('text', 'Ihr Logistik-Team', /Personenname/, PERSON);
schlecht('text', 'Vertrieb', /Personenname/, PERSON);
schlecht('text', 'Müller GmbH', /Personenname/, PERSON);
schlecht('text', 'Kundenservice', /Personenname/, PERSON);
schlecht('text', 'Team Nord', /Personenname/, PERSON);
schlecht('text', 'Spedition Meyer KG', /Personenname/, PERSON);
schlecht('text', '12345', /Personenname/, PERSON);
schlecht('text', 'J', /zu kurz/, PERSON);

// ---------------------------------------------------------------- Text mit Regeln
gut('text', 'LS-4711', 'LS-4711', { min_laenge: 1, max_laenge: 60 });
schlecht('text', 'x'.repeat(61), /zu lang/, { min_laenge: 1, max_laenge: 60 });
gut('text', 'AB-123', 'AB-123', { regex: '^[A-Z]{2}-\\d{3}$' });
schlecht('text', 'ab123', /Format/, { regex: '^[A-Z]{2}-\\d{3}$' });

// ---------------------------------------------------------------- Auswahlliste
const LADUNG = { werte: ['Palette', 'Paket', 'Gitterbox'] };
gut('enum', 'Palette', 'Palette', LADUNG);
gut('enum', 'palette', 'Palette', LADUNG);
gut('enum', 'Paletten', 'Palette', LADUNG);
gut('enum', 'Pakete', 'Paket', LADUNG);
gut('enum', 'GITTERBOXEN', 'Gitterbox', LADUNG);
schlecht('enum', 'Container', /Werteliste/, LADUNG);
schlecht('enum', 'Pal', /Werteliste/, LADUNG);

// ---------------------------------------------------------------- Platzhalter
for (const w of ['k.A.', 'K. A.', 'keine Angabe', 'folgt', 'wird nachgereicht', 'siehe Anhang', 'n/a', 'TBD', '-', '…', '???'.slice(0, 2), 'XXX', 'unbekannt', 'offen', '0000']) {
	test(`Platzhalter: "${w}" gilt als fehlend`, () => assert.equal(p.istPlatzhalter(w), true));
}
for (const w of ['Dortmund', '44135', 'Palette', '0', 'Max']) {
	test(`kein Platzhalter: "${w}"`, () => assert.equal(p.istPlatzhalter(w), false));
}
test('Platzhalter aus der Config (platzhalter_muster) zählen zusätzlich', () => {
	assert.equal(p.istPlatzhalter('noch offen', ['noch offen']), true);
	assert.equal(p.istPlatzhalter('Noch  Offen', ['noch offen']), true);
});

test('unbekannter Feldtyp ist ein Fehler, keine stille Annahme', () => {
	const r = p.feldPruefen(feld('farbe'), 'rot', { heute: HEUTE });
	assert.equal(r.ok, false);
	assert.match(r.grund, /unbekannt/);
});
