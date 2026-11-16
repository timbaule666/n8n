'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const s = require('../src/configSheet');
const { validiereConfig } = require('../src/configValidator');

const b = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'datatables', 'beispiel-transport.json'), 'utf8'));
const KAT = { 'Bereit zur Bearbeitung': { name: 'AI Geprüft', farbe: 'preset4' }, 'Freigabe ausstehend': { name: 'AI Rückfragen', farbe: 'preset0' }, 'Warten auf Kunde': { name: 'AI Rückfragen', farbe: 'preset0' } };
const ALLG = { ...b.epa_config_allgemein[0], postfach: 'a@b.de', freigeber: '["c@b.de"]', outlook_kategorien: JSON.stringify(KAT) };
const PF = b.epa_config_pflichtfelder.map((z, i) => ({ ...z, id: i + 1 }));
const validieren = (a, p) => validiereConfig(a, p);

const kopie = (x) => JSON.parse(JSON.stringify(x));
function lauf(aendern = () => {}) {
	const inhalt = kopie(s.sheetInhalt(ALLG, PF));
	aendern(inhalt);
	return s.abgleichen({ allgemein: ALLG, pflichtfelder: PF, reiterAllgemein: inhalt.Allgemein, reiterPflicht: inhalt.Pflichtfelder, validieren });
}
const setze = (inhalt, label, wert) => { const z = inhalt.Allgemein.find((r) => r[0] === label); assert.ok(z, label); z[1] = wert; };
const feld = (inhalt, name) => inhalt.Pflichtfelder.find((r) => r[1] === name);
const spalte = (name) => s.PFLICHT_SPALTEN.findIndex(([, k]) => k === name);

test('Unverändertes Sheet: keine Änderung, keine Fehler', () => {
	const r = lauf();
	assert.deepEqual(r.fehler, []);
	assert.deepEqual(r.allgemein_update, {});
	assert.deepEqual(r.pflicht_ops, []);
});

test('Sheet enthält nur fachliche Einstellungen, keine Technik', () => {
	const labels = s.sheetInhalt(ALLG, PF).Allgemein.map((z) => z[0]).join('|');
	for (const tabu of ['postfach', 'benachrichtigung', 'llm', 'prompt', 'kunde_id', 'konfidenz']) assert.ok(!labels.toLowerCase().includes(tabu), tabu);
	assert.ok(!s.sheetInhalt(ALLG, PF).Allgemein.some((z) => /^(Freigeber|Vertreter)$/i.test(z[0])), 'Freigeber nur durch den Betreiber');
	const w = Object.fromEntries(s.sheetInhalt(ALLG, PF).Allgemein.slice(1).map((z) => [z[0], z[1]]));
	assert.equal(w.Arbeitstage, 'Mo, Di, Mi, Do, Fr');
	assert.equal(w['Outlook-Markierung "bereit"'], 'AI Geprüft');
	assert.equal(w['Frist nur in Geschäftszeiten'], 'ja');
});

test('Einstellungen ändern: Zahl, Text, ja/nein, Liste, Daten, Geschäftszeiten, Markierung', () => {
	const r = lauf((i) => {
		setze(i, 'Antwortfrist Kunde (Stunden)', '72');
		setze(i, 'Signatur', 'Viele Grüße\nTeam Test');
		setze(i, 'Frist nur in Geschäftszeiten', 'nein');
		setze(i, 'Absender ignorieren', 'spam@x.de; @werbung.de');
		setze(i, 'Zusätzliche freie Tage', '24.12.2026, 31.12.2026');
		setze(i, 'Arbeitstage', 'Montag - Samstag');
		setze(i, 'Geschäftszeit bis', '18:30');
		setze(i, 'Outlook-Markierung "bereit"', 'Fertig');
	});
	assert.deepEqual(r.fehler, []);
	const u = r.allgemein_update;
	assert.equal(u.frist_stunden, 72);
	assert.equal(u.signatur, 'Viele Grüße\nTeam Test');
	assert.equal(u.frist_nur_geschaeftszeit, false);
	assert.equal(u.absender_blocklist, '["spam@x.de","@werbung.de"]');
	assert.equal(u.zusaetzliche_feiertage, '["2026-12-24","2026-12-31"]');
	assert.deepEqual(JSON.parse(u.geschaeftszeiten).tage, [1, 2, 3, 4, 5, 6]);
	assert.equal(JSON.parse(u.geschaeftszeiten).bis, '18:30');
	assert.equal(JSON.parse(u.outlook_kategorien)['Bereit zur Bearbeitung'].name, 'Fertig');
	assert.equal(JSON.parse(u.outlook_kategorien)['Warten auf Kunde'].name, 'AI Rückfragen');
	assert.ok(r.aenderungen.includes('Antwortfrist Kunde (Stunden) geändert'));
	assert.ok(!('postfach' in u) && !('freigeber' in u));
});

test('Fehler im Sheet: nichts wird übernommen, Meldung in Sheet-Begriffen', () => {
	let r = lauf((i) => setze(i, 'Antwortfrist Kunde (Stunden)', 'zwei Tage'));
	assert.match(r.fehler.join('|'), /Antwortfrist Kunde \(Stunden\): "zwei Tage" ist keine Zahl/);
	assert.deepEqual(r.allgemein_update, {});
	r = lauf((i) => setze(i, 'Anrede', 'Hallo'));
	assert.match(r.fehler.join('|'), /anrede_stil|Anrede/);
	assert.deepEqual(r.pflicht_ops, []);
	r = lauf((i) => setze(i, 'Geschäftszeit von', '8 Uhr'));
	assert.match(r.fehler.join('|'), /"Geschäftszeit von": Format HH:MM/);
	r = lauf((i) => setze(i, 'Arbeitstage', 'Mo, Feiertag'));
	assert.match(r.fehler.join('|'), /Arbeitstage: "Feiertag" ist kein Wochentag/);
	r = lauf((i) => { i.Allgemein = i.Allgemein.filter((z) => z[0] !== 'Signatur'); });
	assert.match(r.fehler.join('|'), /Zeile "Signatur" fehlt/);
});

test('Unbekannte Zeile ist nur ein Hinweis', () => {
	const r = lauf((i) => i.Allgemein.push(['Lieblingsfarbe', 'blau', '']));
	assert.deepEqual(r.fehler, []);
	assert.match(r.hinweise[0], /Lieblingsfarbe/);
});

test('Pflichtfelder: ändern, neu, deaktivieren (nie löschen)', () => {
	const r = lauf((i) => {
		feld(i, 'Telefon')[spalte('Pflicht')] = 'nein';
		feld(i, 'Telefon')[spalte('Rückfrage-Text')] = 'Wie erreichen wir Sie telefonisch?';
		i.Pflichtfelder = i.Pflichtfelder.filter((z) => z[1] !== 'Packstuecke');
		i.Pflichtfelder.push(['transport', 'Referenz', 'Ihre Referenz', 'text', 'nein', 'Bitte nennen Sie Ihre Referenznummer.', 'Bestell- oder Referenznummer', '', '200', 'ja', 'Please tell us your reference number.']);
	});
	assert.deepEqual(r.fehler, []);
	const tel = r.pflicht_ops.find((o) => o.zeile.resolution_textbaustein === 'Wie erreichen wir Sie telefonisch?');
	assert.equal(tel.aktion, 'update');
	assert.deepEqual(Object.keys(tel.zeile).sort(), ['pflicht', 'resolution_textbaustein']);
	const pack = r.pflicht_ops.find((o) => o.id === PF.find((z) => z.feldname === 'Packstuecke').id);
	assert.deepEqual(pack.zeile, { aktiv: false });
	const neu = r.pflicht_ops.find((o) => o.aktion === 'insert');
	assert.equal(neu.zeile.feldname, 'Referenz');
	assert.equal(neu.zeile.kunde_id, ALLG.kunde_id);
	assert.equal(neu.zeile.validierungsregel, '{}');
	assert.ok(r.pflicht_ops.every((o) => o.aktion !== 'delete'));
	assert.ok(r.aenderungen.some((a) => /Packstuecke" deaktiviert/.test(a)));
	// Übersetzungen folgen den aktiven Feldern
	const ue = JSON.parse(r.allgemein_update.uebersetzungen).en.textbausteine;
	assert.equal(ue.Referenz, 'Please tell us your reference number.');
	assert.ok(!('Packstuecke' in ue));
});

test('Übersetzungen: Texte je Sprache im Sheet, fehlender Text wird verständlich gemeldet', () => {
	const inhalt = s.sheetInhalt(ALLG, PF);
	assert.ok(inhalt.Pflichtfelder[0].includes('Rückfrage-Text (en)'));
	assert.ok(inhalt.Allgemein.some((z) => z[0] === 'Signatur (en)'));
	// Gewicht_kg gibt es nur bei Transport (Telefon steht in mehreren Vorgangsarten und hat dort weitere Texte)
	let r = lauf((i) => { feld(i, 'Gewicht_kg')[i.Pflichtfelder[0].indexOf('Rückfrage-Text (en)')] = ''; });
	assert.match(r.fehler.join('|'), /"Rückfrage-Text \(en\)" für Gewicht_kg fehlt/);
	r = lauf((i) => setze(i, 'Signatur (en)', 'Best regards\nTest team'));
	assert.deepEqual(r.fehler, []);
	assert.equal(JSON.parse(r.allgemein_update.uebersetzungen).en.signatur, 'Best regards\nTest team');
});

test('Pflichtfelder: erlaubte Werte, Validierungsregeln bleiben erhalten', () => {
	const r = lauf((i) => { feld(i, 'Ladungsart')[spalte('Erlaubte Werte')] = 'Palette, Paket, Gitterbox'; });
	assert.deepEqual(r.fehler, []);
	assert.deepEqual(JSON.parse(r.pflicht_ops[0].zeile.validierungsregel).werte, ['Palette', 'Paket', 'Gitterbox']);
	const plz = lauf((i) => { feld(i, 'Start_PLZ')[spalte('Anzeigename')] = 'PLZ Abholung'; });
	assert.deepEqual(Object.keys(plz.pflicht_ops[0].zeile), ['anzeigename'], 'Regel unverändert');
});

test('Pflichtfelder: Fehler blockieren alles', () => {
	let r = lauf((i) => { feld(i, 'Telefon')[spalte('Typ')] = 'handy'; });
	assert.match(r.fehler.join('|'), /Pflichtfelder \(transport\.Telefon\)\.typ: "handy" ist unbekannt/);
	r = lauf((i) => { feld(i, 'Telefon')[spalte('Rückfrage-Text')] = ''; });
	assert.match(r.fehler.join('|'), /Rückfrage-Text: fehlt/);
	r = lauf((i) => { i.Pflichtfelder.push(kopie(feld(i, 'Telefon'))); });
	assert.match(r.fehler.join('|'), /steht doppelt/);
	r = lauf((i) => { i.Pflichtfelder[0] = i.Pflichtfelder[0].map((k) => (k === 'Pflicht' ? 'Muss' : k)); });
	assert.match(r.fehler.join('|'), /Spalte "Pflicht" fehlt/);
	r = lauf((i) => { for (const z of i.Pflichtfelder.slice(1)) z[spalte('Pflicht')] = 'nein'; });
	assert.match(r.fehler.join('|'), /kein Pflichtfeld definiert/);
	assert.deepEqual(r.pflicht_ops, []);
});

test('Anlegen: drei Reiter mit Kopfzeile, Status mit fester Länge', () => {
	const body = s.anlegenBody('EPA Regeln test', s.sheetInhalt(ALLG, PF));
	assert.deepEqual(body.sheets.map((x) => x.properties.title), ['Allgemein', 'Pflichtfelder', 'Status']);
	assert.equal(body.sheets[1].data[0].rowData.length, PF.length + 1);
	assert.equal(s.statusZeilen({ ergebnis: 'OK', meldungen: ['a'] }).length, 30);
	assert.equal(s.fingerabdruck('x'), s.fingerabdruck('x'));
	assert.notEqual(s.fingerabdruck('x'), s.fingerabdruck('y'));
});

test('Markierungen: gelb für "wartet", älteres Sheet ohne Zeile bleibt wie bisher', () => {
	let r = lauf((i) => setze(i, 'Outlook-Markierung "wartet"', 'AI Wartet'));
	assert.deepEqual(r.fehler, []);
	const k = JSON.parse(r.allgemein_update.outlook_kategorien);
	assert.deepEqual(k['Warten auf Kunde'], { name: 'AI Wartet', farbe: 'preset3' });
	assert.deepEqual(k['Freigabe ausstehend'], { name: 'AI Rückfragen', farbe: 'preset0' });
	assert.deepEqual(k['Bereit zur Bearbeitung'], { name: 'AI Geprüft', farbe: 'preset4' });
	r = lauf((i) => { i.Allgemein = i.Allgemein.filter((z) => z[0] !== 'Outlook-Markierung "wartet"'); });
	assert.deepEqual(r.fehler, []);
	assert.deepEqual(r.allgemein_update, {}, 'ohne Zeile: rot auch beim Warten, keine Änderung');
	r = lauf((i) => setze(i, 'Outlook-Markierung "wartet"', ''));
	assert.ok(!('Warten auf Kunde' in JSON.parse(r.allgemein_update.outlook_kategorien)), 'leer = keine eigene Markierung');
});

test('Status-Reiter zeigt gebuchte Bereiche nur zur Info', () => {
	const cs = require('../src/configSheet');
	const z = cs.statusZeilen({ zeit: 'x', ergebnis: 'Keine Änderung', meldungen: ['m1'], bereiche: [{ name: 'Angebotsanfragen', aktiv: true }, { name: 'Terminanfragen', aktiv: false }] });
	assert.equal(z.length, 30);
	assert.deepEqual(z[4], ['Angebotsanfragen', 'Ja']);
	assert.deepEqual(z[5], ['Terminanfragen', 'Nein']);
	assert.ok(z.some((r) => r[1] === 'm1'));
});

test('Ältere Sheets ohne Zeile "Vorgangsnummer im Betreff": kein Fehler, bisheriger Wert bleibt', () => {
	const cs = require('../src/configSheet');
	const { validiereConfig } = require('../src/configValidator');
	const bsp = require('../config/datatables/beispiel-transport.json');
	const alt = { ...bsp.epa_config_allgemein[0], vorgangsnummer_im_betreff: true };
	const inhalt = cs.sheetInhalt(alt, bsp.epa_config_pflichtfelder);
	const ohne = inhalt.Allgemein.filter((z) => z[0] !== 'Vorgangsnummer im Betreff');
	const r = cs.abgleichen({ allgemein: alt, pflichtfelder: bsp.epa_config_pflichtfelder, reiterAllgemein: ohne, reiterPflicht: inhalt.Pflichtfelder, validieren: (a, p) => validiereConfig({ ...a, aktiv: true }, p) });
	assert.ok(!r.fehler.some((f) => /Vorgangsnummer/.test(f)), r.fehler.join('\n'));
	assert.equal('vorgangsnummer_im_betreff' in r.allgemein_update, false);
});

// ---------------------------------------------------------------- Regel-Sheet mit einem Reiter je Bereich
{
	const cs = require('../src/configSheet');
	const cv = require('../src/configValidator');
	const bsp = require('../config/datatables/beispiel-transport.json');
	const ALT = { ...bsp.epa_config_allgemein[0], postfach: 'anfragen@beispiel.de', freigeber: '["dispo@beispiel.de"]', benachrichtigung: '{"kanal": "teams", "team_id": "t", "channel_id": "c"}', uebersetzungen: JSON.stringify({ en: { signatur: 'Regards', ki_hinweistext: 'AI', textbausteine: Object.fromEntries(bsp.epa_config_pflichtfelder.map((f) => [f.feldname, 'EN ' + f.feldname])) } }) };
	const PF = bsp.epa_config_pflichtfelder.map((f, i) => ({ ...f, id: i + 1 }));
	const val = (a, p) => cv.validiereConfig({ ...a, aktiv: true }, p);
	const inhalt = () => Object.fromEntries(cs.sheetInhaltBereiche(ALT, PF).map((r) => [r.titel, JSON.parse(JSON.stringify(r.zeilen))]));
	const lauf = (aendern) => { const i = inhalt(); if (aendern) aendern(i); return cs.abgleichen({ allgemein: ALT, pflichtfelder: PF, reiterAllgemein: i.Allgemein, reiterBereiche: i, validieren: val }); };

	test('Bereichs-Sheet: Reiter, Gleichheit mit der Config-Prüfung, alle Einstellungen gegliedert', () => {
		assert.deepEqual(cs.sheetInhaltBereiche(ALT, PF).map((r) => r.titel), ['Anleitung', 'Allgemein', 'Angebotsanfragen', 'Bestellungen', 'Terminanfragen', 'Reklamationen', 'Status']);
		assert.deepEqual(cs.BEREICH_REITER.map(({ schluessel, spalte, name, typen }) => ({ schluessel, spalte, name, typen })), cv.BEREICHE.map(({ schluessel, spalte, name, typen }) => ({ schluessel, spalte, name, typen })));
		assert.deepEqual(cs.FELDTYPEN, cv.FELDTYPEN);
		assert.deepEqual(cs.GRUPPEN.flatMap(([, s]) => s).sort(), cs.EINSTELLUNGEN.map((e) => e[0]).sort());
		const i = inhalt();
		assert.equal(i.Angebotsanfragen.length - 1, PF.filter((f) => f.vorgangstyp === 'transport').length);
		assert.ok(i.Allgemein.some((z) => z[0].startsWith('▸')));
	});

	test('Bereichs-Sheet: frisch angelegt ergibt keine Änderung (Hin und zurück)', () => {
		const r = lauf();
		assert.deepEqual(r.fehler, []);
		assert.deepEqual(r.aenderungen, []);
		assert.ok(!r.hinweise.some((h) => /unbekannt/.test(h)), r.hinweise.join('|'));
	});

	test('Bereichs-Sheet: Text ändern, neues Feld im Reiter, Fehler mit Reiter und Zeile', () => {
		let r = lauf((i) => { i.Bestellungen[1][4] = 'Was möchten Sie bestellen?'; });
		assert.deepEqual(r.fehler, []);
		assert.equal(r.pflicht_ops.length, 1);
		assert.equal(r.pflicht_ops[0].zeile.resolution_textbaustein, 'Was möchten Sie bestellen?');
		r = lauf((i) => { i.Reklamationen.push(['Fotos', 'Fotos vorhanden', 'text', 'nein', 'Bitte senden Sie uns Fotos.', 'Please send photos.', 'Ob Fotos angehängt sind', '', '50', 'ja']); });
		assert.deepEqual(r.fehler, []);
		const neu = r.pflicht_ops.find((o) => o.aktion === 'insert');
		assert.equal(neu.zeile.vorgangstyp, 'reklamation');
		assert.equal(neu.zeile.feldname, 'Fotos');
		r = lauf((i) => { i.Terminanfragen[2][3] = 'vielleicht'; });
		assert.match(r.fehler.join('|'), /Terminanfragen, Zeile 3: Pflicht bitte "ja" oder "nein"/);
		r = lauf((i) => { delete i.Terminanfragen; });
		assert.match(r.fehler.join('|'), /Reiter "Terminanfragen" fehlt/);
	});

	test('Bereichs-Sheet: Formatierung mit Auswahlfeldern und festen Reiter-IDs', () => {
		const { body, format } = cs.anlegenBodyBereiche('EPA Regeln – test', cs.sheetInhaltBereiche(ALT, PF));
		assert.deepEqual(body.sheets.map((s) => s.properties.sheetId), [0, 1, 2, 3, 4, 5, 6]);
		assert.ok(format.requests.some((q) => q.setDataValidation && q.setDataValidation.rule.condition.values.length === cs.FELDTYPEN.length));
		assert.ok(format.requests.length > 20);
	});
}
