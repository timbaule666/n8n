'use strict';
// Fristberechnung mit Zeitzone, Geschäftszeiten und Feiertagen (Masterprompt 3 und Phase C4/E).
// Nutzt Luxon. In n8n ist Luxon als globales `DateTime` verfügbar, lokal (Tests) über require.

function luxon() {
	// eslint-disable-next-line no-undef
	if (typeof DateTime !== 'undefined' && DateTime && typeof DateTime.fromISO === 'function') return DateTime;
	return require('luxon').DateTime;
}

const BUNDESLAENDER = ['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'];

function ostersonntag(jahr) {
	// Anonymer gregorianischer Algorithmus (Meeus/Jones/Butcher)
	const a = jahr % 19;
	const b = Math.floor(jahr / 100);
	const c = jahr % 100;
	const d = Math.floor(b / 4);
	const e = b % 4;
	const f = Math.floor((b + 8) / 25);
	const g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30;
	const i = Math.floor(c / 4);
	const k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7;
	const m = Math.floor((a + 11 * h + 22 * l) / 451);
	const monat = Math.floor((h + l - 7 * m + 114) / 31);
	const tag = ((h + l - 7 * m + 114) % 31) + 1;
	return { monat, tag };
}

function iso(jahr, monat, tag) {
	return `${jahr}-${String(monat).padStart(2, '0')}-${String(tag).padStart(2, '0')}`;
}

/**
 * Gesetzliche Feiertage für ein Jahr und Bundesland als Map ISO-Datum -> Name.
 * Nicht enthalten: rein kommunale bzw. teilregionale Feiertage (z. B. Augsburger Friedensfest,
 * Mariä Himmelfahrt in Teilen Bayerns) und einmalige Sonderfeiertage. Diese über
 * `zusaetzliche` (Config) ergänzen.
 */
function feiertage(jahr, region, zusaetzliche = []) {
	const DT = luxon();
	const r = String(region || '').toUpperCase();
	if (r && !BUNDESLAENDER.includes(r)) throw new Error(`Unbekannte Feiertagsregion "${region}"`);
	const o = ostersonntag(jahr);
	const ostern = DT.fromObject({ year: jahr, month: o.monat, day: o.tag }, { zone: 'UTC' });
	const rel = (tage) => ostern.plus({ days: tage }).toISODate();
	const liste = {
		[iso(jahr, 1, 1)]: 'Neujahr',
		[rel(-2)]: 'Karfreitag',
		[rel(1)]: 'Ostermontag',
		[iso(jahr, 5, 1)]: 'Tag der Arbeit',
		[rel(39)]: 'Christi Himmelfahrt',
		[rel(50)]: 'Pfingstmontag',
		[iso(jahr, 10, 3)]: 'Tag der Deutschen Einheit',
		[iso(jahr, 12, 25)]: '1. Weihnachtstag',
		[iso(jahr, 12, 26)]: '2. Weihnachtstag',
	};
	const regional = (laender, datum, name) => {
		if (laender.includes(r)) liste[datum] = name;
	};
	regional(['BW', 'BY', 'ST'], iso(jahr, 1, 6), 'Heilige Drei Könige');
	if (jahr >= 2019) regional(['BE'], iso(jahr, 3, 8), 'Internationaler Frauentag');
	if (jahr >= 2023) regional(['MV'], iso(jahr, 3, 8), 'Internationaler Frauentag');
	regional(['BW', 'BY', 'HE', 'NW', 'RP', 'SL'], rel(60), 'Fronleichnam');
	regional(['SL'], iso(jahr, 8, 15), 'Mariä Himmelfahrt');
	if (jahr >= 2019) regional(['TH'], iso(jahr, 9, 20), 'Weltkindertag');
	const reformation = jahr >= 2018 ? ['BB', 'MV', 'SN', 'ST', 'TH', 'HB', 'HH', 'NI', 'SH'] : ['BB', 'MV', 'SN', 'ST', 'TH'];
	regional(reformation, iso(jahr, 10, 31), 'Reformationstag');
	regional(['BW', 'BY', 'NW', 'RP', 'SL'], iso(jahr, 11, 1), 'Allerheiligen');
	if (r === 'SN') {
		// Mittwoch vor dem 23. November
		let d = DT.fromObject({ year: jahr, month: 11, day: 22 }, { zone: 'UTC' });
		while (d.weekday !== 3) d = d.minus({ days: 1 });
		liste[d.toISODate()] = 'Buß- und Bettag';
	}
	for (const z of zusaetzliche || []) {
		if (typeof z === 'string' && z.startsWith(`${jahr}-`)) liste[z] = 'Zusätzlicher Feiertag (Config)';
		else if (z && typeof z.datum === 'string' && z.datum.startsWith(`${jahr}-`)) liste[z.datum] = z.name || 'Zusätzlicher Feiertag (Config)';
	}
	return liste;
}

function parseUhrzeit(s) {
	const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''));
	if (!m) throw new Error(`Ungültige Uhrzeit "${s}" (erwartet HH:MM)`);
	return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * Normalisiert die Zeit-Config.
 * cfg: { zeitzone, frist_nur_geschaeftszeit, geschaeftszeiten: {tage:[1..7], von:'08:00', bis:'17:00'},
 *        feiertage_region, zusaetzliche_feiertage }
 */
function zeitConfig(cfg) {
	const c = cfg || {};
	const g = c.geschaeftszeiten || {};
	const tage = Array.isArray(g.tage) && g.tage.length ? g.tage.map(Number) : [1, 2, 3, 4, 5];
	if (tage.some((t) => !Number.isInteger(t) || t < 1 || t > 7)) throw new Error('geschaeftszeiten.tage muss Werte 1 (Mo) bis 7 (So) enthalten');
	const von = parseUhrzeit(g.von || '08:00');
	const bis = parseUhrzeit(g.bis || '17:00');
	if (bis.hour * 60 + bis.minute <= von.hour * 60 + von.minute) throw new Error('geschaeftszeiten.bis muss nach geschaeftszeiten.von liegen');
	return {
		zeitzone: c.zeitzone || 'Europe/Berlin',
		nurGeschaeftszeit: c.frist_nur_geschaeftszeit === true,
		tage,
		von,
		bis,
		region: c.feiertage_region || null,
		zusaetzliche: c.zusaetzliche_feiertage || [],
	};
}

function zuDateTime(wert, zone) {
	const DT = luxon();
	let d;
	if (wert && typeof wert === 'object' && typeof wert.setZone === 'function') d = wert;
	else if (wert instanceof Date) d = DT.fromJSDate(wert);
	else d = DT.fromISO(String(wert), { setZone: true });
	if (!d.isValid) throw new Error(`Ungültiger Zeitpunkt "${wert}"`);
	d = d.setZone(zone);
	if (!d.isValid) throw new Error(`Ungültige Zeitzone "${zone}"`);
	return d;
}

function istArbeitstag(d, z, cache) {
	if (!z.tage.includes(d.weekday)) return false;
	if (!z.region && !z.zusaetzliche.length) return true;
	if (!cache[d.year]) cache[d.year] = feiertage(d.year, z.region, z.zusaetzliche);
	return !cache[d.year][d.toISODate()];
}

function istGeschaeftszeit(zeitpunkt, cfg) {
	const z = zeitConfig(cfg);
	const d = zuDateTime(zeitpunkt, z.zeitzone);
	if (!istArbeitstag(d, z, {})) return false;
	const start = d.set({ ...z.von, second: 0, millisecond: 0 });
	const ende = d.set({ ...z.bis, second: 0, millisecond: 0 });
	return d >= start && d < ende;
}

/**
 * Berechnet eine Frist ab `start` um `stunden`.
 * Ohne Geschäftszeit-Modus: absolute Stunden. Mit: nur Minuten innerhalb der Geschäftszeiten zählen.
 * @returns {string} ISO-Zeitstempel in der konfigurierten Zeitzone
 */
function berechneFrist(start, stunden, cfg) {
	const z = zeitConfig(cfg);
	const h = Number(stunden);
	if (!Number.isFinite(h) || h < 0) throw new Error(`Ungültige Fristdauer "${stunden}"`);
	let t = zuDateTime(start, z.zeitzone);
	if (!z.nurGeschaeftszeit) return t.plus({ minutes: Math.round(h * 60) }).toISO();

	let rest = Math.round(h * 60);
	const cache = {};
	for (let schutz = 0; schutz < 3700; schutz++) {
		const tagStart = t.set({ ...z.von, second: 0, millisecond: 0 });
		const tagEnde = t.set({ ...z.bis, second: 0, millisecond: 0 });
		if (!istArbeitstag(t, z, cache) || t >= tagEnde) {
			t = t.plus({ days: 1 }).set({ ...z.von, second: 0, millisecond: 0 });
			continue;
		}
		if (t < tagStart) t = tagStart;
		const verfuegbar = tagEnde.diff(t, 'minutes').minutes;
		if (rest <= verfuegbar) return t.plus({ minutes: rest }).toISO();
		rest -= verfuegbar;
		t = t.plus({ days: 1 }).set({ ...z.von, second: 0, millisecond: 0 });
	}
	throw new Error('Frist konnte nicht berechnet werden (keine Arbeitstage gefunden)');
}

/** true, wenn die Frist zum Zeitpunkt `jetzt` überschritten ist. */
function istUeberfaellig(frist, jetzt) {
	if (!frist) return false;
	const DT = luxon();
	const f = DT.fromISO(String(frist), { setZone: true });
	const n = jetzt ? DT.fromISO(String(jetzt), { setZone: true }) : DT.now();
	if (!f.isValid || !n.isValid) throw new Error('Ungültiger Zeitpunkt für Fristvergleich');
	return f.toMillis() < n.toMillis();
}

module.exports = {
	BUNDESLAENDER,
	ostersonntag,
	feiertage,
	zeitConfig,
	istGeschaeftszeit,
	berechneFrist,
	istUeberfaellig,
};
