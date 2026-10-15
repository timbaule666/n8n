'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validiereConfig } = require('../src/configValidator');

function allgemein(overrides = {}) {
	return {
		kunde_id: 'beispiel-transport',
		aktiv: true,
		postfach: 'Anfragen@Beispiel.de',
		anrede_stil: 'Sie',
		sprache: 'de',
		signatur: 'Mit freundlichen Grüßen',
		ki_hinweistext: 'KI-gestützt erstellt und geprüft.',
		frist_stunden: '48',
		frist_nur_geschaeftszeit: true,
		max_runden: 3,
		erinnerung_intervall_stunden: '24',
		anzahl_erinnerungen: 2,
		zeitzone: 'Europe/Berlin',
		geschaeftszeiten: { tage: [1, 2, 3, 4, 5], von: '08:00', bis: '17:00' },
		feiertage_region: 'NW',
		zusaetzliche_feiertage: [],
		benachrichtigung: { kanal: 'teams', team_id: 't', channel_id: 'c' },
		freigeber: ['Dispo@Beispiel.de'],
		vertreter: [],
		zustaendigkeit: {},
		absender_allowlist: [],
		absender_blocklist: [],
		konfidenz_schwelle: '0.75',
		zuordnung_schwellen: { eindeutig: 80, abstand: 50, neu: 40 },
		llm_profil: {
			klassifizierung: { modell: 'gpt-4o-mini', temperatur: 0, timeout_ms: 30000, max_tokens: 300 },
			extraktion: { modell: 'gpt-4o-mini', temperatur: 0, timeout_ms: 60000, max_tokens: 2000 },
			entwurf: { modell: 'gpt-4o-mini', temperatur: 0.2, timeout_ms: 45000, max_tokens: 800 },
		},
		prompt_versionen: { klassifizierung: 'v1' },
		archivordner: 'EPA-Archiv',
		aufbewahrung_tage: 365,
		anhang_limits: {},
		leerantwort_fristverlaengerung_stunden: '24',
		freigabe_erinnerung_stunden: '4',
		freigabe_ablauf_stunden: '48',
		...overrides,
	};
}

function feld(overrides = {}) {
	return {
		vorgangstyp: 'transport',
		feldname: 'Start_PLZ',
		anzeigename: 'PLZ Abholort',
		typ: 'plz',
		pflicht: true,
		validierungsregel: { regex: '^\\d{5}$' },
		resolution_textbaustein: 'Bitte nennen Sie uns die Postleitzahl des Abholorts.',
		extraktions_hinweis: '',
		platzhalter_muster: [],
		reihenfolge: 10,
		...overrides,
	};
}

const fehlerText = (r) => r.fehler.join('\n');

test('gültige Config wird normalisiert', () => {
	const r = validiereConfig(allgemein(), [
		feld({ feldname: 'Gewicht_kg', typ: 'zahl', validierungsregel: { min: 1, max: 40000 }, reihenfolge: 60 }),
		feld(),
		feld({ feldname: 'Ladungsart', typ: 'enum', pflicht: false, validierungsregel: { werte: ['Palette', 'Paket'] }, reihenfolge: 80 }),
	]);
	assert.equal(r.gueltig, true, fehlerText(r));
	assert.equal(r.config.postfach, 'anfragen@beispiel.de');
	assert.deepEqual(r.config.freigeber, ['dispo@beispiel.de']);
	assert.equal(r.config.frist_stunden, 48);
	assert.equal(r.config.konfidenz_schwelle, 0.75);
	assert.deepEqual(r.config.vorgangstypen.transport.map((f) => f.feldname), ['Start_PLZ', 'Gewicht_kg', 'Ladungsart']);
});

test('JSON-Spalten als Text werden akzeptiert (z. B. aus CSV)', () => {
	const r = validiereConfig(allgemein({ geschaeftszeiten: '{"tage":[1,2,3,4,5],"von":"08:00","bis":"17:00"}', freigeber: '["a@b.de"]' }), [feld({ validierungsregel: '{"regex":"^\\\\d{5}$"}', pflicht: 'ja' })]);
	assert.equal(r.gueltig, true, fehlerText(r));
	assert.equal(r.config.vorgangstypen.transport[0].validierungsregel.regex, '^\\d{5}$');
});

test('fehlender Textbaustein ist ein Konfigurationsfehler', () => {
	const r = validiereConfig(allgemein(), [feld({ resolution_textbaustein: '  ' })]);
	assert.equal(r.gueltig, false);
	assert.match(fehlerText(r), /resolution_textbaustein: fehlt/);
	assert.equal(r.config, null);
});

test('keine Pflichtfelder bzw. kein Pflichtfeld je Vorgangstyp', () => {
	assert.match(fehlerText(validiereConfig(allgemein(), [])), /keine aktiven Felder/);
	assert.match(fehlerText(validiereConfig(allgemein(), [feld({ pflicht: false })])), /kein Pflichtfeld definiert/);
});

test('Validierungsregeln je Typ', () => {
	const faelle = [
		[feld({ validierungsregel: { regex: '([' } }), /ungültiger regulärer Ausdruck/],
		[feld({ typ: 'zahl', validierungsregel: { min: 10, max: 1 } }), /min ist größer als max/],
		[feld({ typ: 'zahl', validierungsregel: { minimum: 1 } }), /Schlüssel "minimum" ist für Typ "zahl" nicht erlaubt/],
		[feld({ validierungsregel: { person: 'ja' } }), /person: muss true\/false sein/],
		[feld({ typ: 'zahl', validierungsregel: { person: true } }), /Schlüssel "person" ist für Typ "zahl" nicht erlaubt/],
		[feld({ typ: 'enum', validierungsregel: {} }), /braucht eine Liste erlaubter Werte/],
		[feld({ typ: 'enum', validierungsregel: { werte: ['ok', ''] } }), /braucht eine Liste erlaubter Werte/],
		[feld({ typ: 'farbe' }), /typ: "farbe" ist unbekannt/],
		[feld({ validierungsregel: '{kaputt' }), /kein gültiges JSON/],
		[feld({ feldname: '1abc' }), /feldname: ungültig/],
		[feld({ pflicht: 'vielleicht' }), /pflicht: muss ja\/nein sein/],
	];
	for (const [f, muster] of faelle) assert.match(fehlerText(validiereConfig(allgemein(), [f])), muster);
});

test('doppelte Felder werden erkannt', () => {
	assert.match(fehlerText(validiereConfig(allgemein(), [feld(), feld()])), /doppelt/);
});

test('allgemeine Felder werden geprüft', () => {
	const faelle = [
		[{ anrede_stil: 'Ihr' }, /anrede_stil/],
		[{ ki_hinweistext: '' }, /ki_hinweistext: fehlt/],
		[{ signatur: undefined }, /signatur: fehlt/],
		[{ postfach: 'kein-postfach' }, /postfach/],
		[{ max_runden: 0 }, /max_runden/],
		[{ max_runden: 2.5 }, /max_runden/],
		[{ frist_stunden: 'abc' }, /frist_stunden/],
		[{ freigeber: [] }, /freigeber: mindestens eine Adresse/],
		[{ freigeber: ['keine-mail'] }, /keine gültige E-Mail/],
		[{ geschaeftszeiten: { tage: [1], von: '18:00', bis: '08:00' } }, /"bis" muss nach "von"/],
		[{ geschaeftszeiten: { tage: [8], von: '08:00', bis: '17:00' } }, /geschaeftszeiten.tage/],
		[{ feiertage_region: 'NRW' }, /Bundesland-Kürzel/],
		[{ benachrichtigung: { kanal: 'slack' } }, /"teams" \(Kunden\) oder "telegram_test"/],
		[{ benachrichtigung: { kanal: 'telegram' } }, /"teams" \(Kunden\) oder "telegram_test"/],
		[{ benachrichtigung: { kanal: 'telegram_test', chat_id: '<CHAT_ID>' } }, /chat_id: Telegram-Chat-ID/],
		[{ benachrichtigung: { kanal: 'telegram_test', chat_id: 'abc' } }, /chat_id: Telegram-Chat-ID/],
		[{ benachrichtigung: { kanal: 'telegram_test', chat_id: '12345' } }, /telegram_workflow_id: ID des Workflows/],
		[{ benachrichtigung: { kanal: 'telegram_test', chat_id: '12345', freigeber_chat_ids: { 'x': '1' } } }, /"x" ist keine E-Mail/],
		[{ benachrichtigung: { kanal: 'telegram_test', chat_id: '12345', freigeber_chat_ids: { 'a@b.de': 'nein' } } }, /Chat-ID für "a@b.de" ist ungültig/],
		[{ benachrichtigung: { kanal: 'teams', team_id: 't' } }, /channel_id: fehlt/],
		[{ konfidenz_schwelle: 1.5 }, /konfidenz_schwelle/],
		[{ llm_profil: { klassifizierung: { modell: 'x', temperatur: 2, timeout_ms: 1000, max_tokens: 10 } } }, /temperatur[\s\S]*max_tokens[\s\S]*extraktion: fehlt/],
		[{ freigabe_erinnerung_stunden: 48, freigabe_ablauf_stunden: 24 }, /kleiner als freigabe_ablauf_stunden/],
		[{ zusaetzliche_feiertage: ['24.12.2026'] }, /zusaetzliche_feiertage/],
		[{ aktiv: false }, /deaktiviert/],
		[{ sprache: 'deutsch' }, /sprache/],
	];
	for (const [o, muster] of faelle) assert.match(fehlerText(validiereConfig(allgemein(o), [feld()])), muster, JSON.stringify(o));
});

test('ungültige Zeitzone über Prüffunktion', () => {
	const r = validiereConfig(allgemein({ zeitzone: 'Mars/Olympus' }), [feld()], { zeitzoneGueltig: (z) => z === 'Europe/Berlin' });
	assert.match(fehlerText(r), /zeitzone/);
});

test('fehlende Zeile', () => {
	assert.deepEqual(validiereConfig(null, []), { gueltig: false, fehler: ['config_allgemein: keine Zeile gefunden'], config: null });
});

test('Platzhalter aus der Vorlage gelten nicht als E-Mail-Adresse', () => {
	const r = validiereConfig(allgemein({ postfach: '<anfragen-test@ihre-domain.de>', freigeber: ['<freigeber@ihre-domain.de>'] }), [feld()]);
	assert.match(fehlerText(r), /postfach/);
	assert.match(fehlerText(r), /freigeber/);
});

test('Testkanal telegram_test: Chat-ID und Zuordnung je Freigeber werden normalisiert', () => {
	const r = validiereConfig(allgemein({ benachrichtigung: { kanal: 'telegram_test', chat_id: ' 123456789 ', telegram_workflow_id: 'AbCdEf123456', freigeber_chat_ids: { 'Chef@Firma.de': -100200300 } } }), [feld()]);
	assert.equal(r.gueltig, true, fehlerText(r));
	assert.deepEqual(r.config.benachrichtigung, { kanal: 'telegram_test', chat_id: '123456789', telegram_workflow_id: 'AbCdEf123456', freigeber_chat_ids: { 'chef@firma.de': '-100200300' } });
});

test('uebersetzungen: optional, vollständig je Sprache', () => {
	const b = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'config', 'datatables', 'beispiel-transport.json'), 'utf8'));
	const basis = { ...b.epa_config_allgemein[0], postfach: 'a@b.de', freigeber: '["c@b.de"]' };
	const pf = b.epa_config_pflichtfelder;
	assert.equal(validiereConfig({ ...basis, uebersetzungen: '' }, pf).gueltig, true);
	assert.deepEqual(validiereConfig({ ...basis, uebersetzungen: undefined }, pf).config.uebersetzungen, {});
	const en = JSON.parse(basis.uebersetzungen).en;
	const ohneTel = { ...en, textbausteine: { ...en.textbausteine } };
	delete ohneTel.textbausteine.Telefon;
	const f = (u) => validiereConfig({ ...basis, uebersetzungen: JSON.stringify(u) }, pf).fehler.join('|');
	assert.match(f({ en: ohneTel }), /uebersetzungen\.en\.textbausteine\.Telefon: fehlt/);
	assert.match(f({ en: { ...en, textbausteine: { ...en.textbausteine, Foo: 'x' } } }), /textbausteine\.Foo: Feld ist unbekannt/);
	assert.match(f({ en: { ...en, signatur: '' } }), /uebersetzungen\.en\.signatur/);
	assert.match(f({ de: en }), /bereits die Hauptsprache/);
	assert.match(f({ english: en }), /ISO-Code/);
	assert.match(f([1]), /muss ein Objekt/);
});
