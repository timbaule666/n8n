'use strict';
// Deterministische Pflichtfeld-Prüfung (Masterprompt B3). Ein Feld fehlt bei null, leerem Text, Platzhalter
// oder verletzter Validierungsregel. Werte werden je Feldtyp normalisiert (z. B. Datum -> JJJJ-MM-TT).

const GLOBALE_PLATZHALTER = Object.freeze([
	'k.a.', 'k. a.', 'ka', 'k.a', 'keine angabe', 'keine angaben', 'ohne angabe', '-', '--', '---', '–', '—', '/', '?', '??', '...', '…',
	'tbd', 'tba', 'tbc', 'n/a', 'na', 'n.a.', 'n. a.', 'nv', 'n.v.', 'unbekannt', 'unknown', 'offen', 'folgt', 'wird nachgereicht',
	'siehe anhang', 'siehe oben', 'xxx', 'xx', 'x', 'null', 'none', 'nil', 'leer', '0000',
]);

const STANDARD_REGELN = Object.freeze({
	plz: { regex: '^\\d{5}$' },
	email: { regex: "^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}$" },
	telefon: { min_ziffern: 6, max_ziffern: 20 },
});

const UNSICHER_UNTER = 0.5;

// Regel "person" für Textfelder (z. B. Ansprechpartner).
const ANREDE = /^(herrn?|frau|hr\.?|fr\.?|mr\.?|mrs\.?|ms\.?)\s+/i;
const KEIN_PERSONENNAME = new RegExp(
	'^(ihr|ihre|your|the|das|die|der)\\s|\\p{L}*team(?=$|[\\s\\-/).,&])|' +
		'(^|[\\s\\-/(])(team|abteilung|firma|disposition|dispo|vertrieb|einkauf|logistik|kundenservice|kundendienst|service|support|zentrale|buchhaltung|' +
		'gmbh|mbh|ag|kg|ohg|gbr|ug|e\\.\\s?k\\.?|ltd\\.?|inc\\.?|llc|b\\.v\\.?|co\\.?)(?=$|[\\s\\-/).,&])',
	'iu',
);

function istPlatzhalter(wert, zusaetzliche) {
	const s = String(wert).trim().toLowerCase().replace(/\s+/g, ' ');
	if (GLOBALE_PLATZHALTER.includes(s)) return true;
	return (zusaetzliche || []).some((p) => String(p).trim().toLowerCase() === s);
}

/** Deutsche und englische Zahlformate: "1.200,5", "1,200.5", "1200 kg", "ca. 800". */
function zahlLesen(wert) {
	if (typeof wert === 'number') return Number.isFinite(wert) ? wert : null;
	let s = String(wert).trim().toLowerCase();
	s = s.replace(/^(ca\.?|circa|etwa|ungefähr|rund|~)\s*/, '');
	s = s.replace(/\s*(kg|kilo(gramm)?|t|to|tonnen|stk\.?|stück|pal(etten)?|pakete?|colli)\.?$/, '');
	s = s.replace(/[\s ']/g, '');
	if (!/^-?[\d.,]+$/.test(s)) return null;
	const punkt = s.lastIndexOf('.');
	const komma = s.lastIndexOf(',');
	if (punkt >= 0 && komma >= 0) {
		s = punkt > komma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
	} else if (komma >= 0) {
		s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
	} else if (punkt >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(s)) {
		s = s.replace(/\./g, '');
	}
	const n = Number(s);
	return Number.isFinite(n) && /\d/.test(s) ? n : null;
}

function iso(j, m, t) {
	const d = new Date(Date.UTC(j, m - 1, t));
	if (d.getUTCFullYear() !== j || d.getUTCMonth() !== m - 1 || d.getUTCDate() !== t) return null;
	return `${String(j).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(t).padStart(2, '0')}`;
}

/**
 * "2026-10-20", "20.10.2026", "20.10.26", "20/10/2026" -> "2026-10-20".
 * Feste Regel ohne Jahr ("20.10."): nächstes Vorkommen ab heute (nur wenn heute bekannt ist).
 */
function datumLesen(wert, heute) {
	const s = String(wert).trim();
	const ohneJahr = s.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
	if (ohneJahr && heute) {
		const j = Number(heute.slice(0, 4));
		const kandidat = iso(j, +ohneJahr[2], +ohneJahr[1]);
		if (kandidat && kandidat >= heute) return kandidat;
		return iso(j + 1, +ohneJahr[2], +ohneJahr[1]);
	}
	let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(T.*)?$/);
	if (m) return iso(+m[1], +m[2], +m[3]);
	m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/);
	if (m) {
		const j = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
		return iso(j, +m[2], +m[1]);
	}
	return null;
}

function tageZwischen(vonIso, bisIso) {
	return Math.round((Date.parse(bisIso + 'T00:00:00Z') - Date.parse(vonIso + 'T00:00:00Z')) / 86400000);
}

/**
 * Prüft und normalisiert einen Wert.
 * @returns {{ ok: true, wert: any } | { ok: false, grund: string }}
 */
function feldPruefen(feld, roh, { heute } = {}) {
	const regel = { ...(STANDARD_REGELN[feld.typ] || {}), ...(feld.validierungsregel || {}) };
	const fehler = (grund) => ({ ok: false, grund });
	switch (feld.typ) {
		case 'text': {
			let s = String(roh).replace(/\s+/g, ' ').trim();
			if (regel.person) {
				// Personenname: Anrede entfernen; Team-, Abteilungs- und Firmennamen gelten als fehlend,
				// damit ein erfundener Ansprechpartner keine nötige Rückfrage verhindert.
				s = s.replace(ANREDE, '').trim();
				if (KEIN_PERSONENNAME.test(s) || !/\p{L}/u.test(s)) return fehler('kein Personenname (Team, Abteilung oder Firma)');
			}
			if (regel.min_laenge !== undefined && s.length < regel.min_laenge) return fehler(`zu kurz (mind. ${regel.min_laenge} Zeichen)`);
			if (regel.max_laenge !== undefined && s.length > regel.max_laenge) return fehler(`zu lang (max. ${regel.max_laenge} Zeichen)`);
			if (regel.regex && !new RegExp(regel.regex).test(s)) return fehler('Format ungültig');
			return { ok: true, wert: s };
		}
		case 'plz': {
			const s = String(roh).trim().toUpperCase().replace(/^(D|DE)[-\s]?/, '').replace(/\s+/g, '');
			if (!new RegExp(regel.regex).test(s)) return fehler('keine gültige Postleitzahl');
			return { ok: true, wert: s };
		}
		case 'datum': {
			const d = datumLesen(roh, heute);
			if (!d) return fehler('kein eindeutiges Datum');
			if (heute) {
				const diff = tageZwischen(heute, d);
				if (regel.min_tage_ab_heute !== undefined && diff < regel.min_tage_ab_heute) return fehler('Datum liegt zu früh (z. B. in der Vergangenheit)');
				if (regel.max_tage_ab_heute !== undefined && diff > regel.max_tage_ab_heute) return fehler('Datum liegt zu weit in der Zukunft');
			}
			return { ok: true, wert: d };
		}
		case 'zahl': {
			const n = zahlLesen(roh);
			if (n === null) return fehler('keine Zahl');
			if (regel.ganzzahl === true && !Number.isInteger(n)) return fehler('muss eine ganze Zahl sein');
			if (regel.min !== undefined && n < regel.min) return fehler(`kleiner als ${regel.min}`);
			if (regel.max !== undefined && n > regel.max) return fehler(`größer als ${regel.max}`);
			return { ok: true, wert: n };
		}
		case 'email': {
			const s = String(roh).trim().replace(/^mailto:/i, '').toLowerCase();
			if (!new RegExp(regel.regex).test(s)) return fehler('keine gültige E-Mail-Adresse');
			return { ok: true, wert: s };
		}
		case 'telefon': {
			const s = String(roh).trim();
			if (!/^[+\d][\d\s()/.\-–]*$/.test(s)) return fehler('keine gültige Telefonnummer');
			// "+49 (0) 381 …": die (0) ist die nationale Vorwahl-Null und gehört nicht in die internationale Nummer
			const ziffern = s.replace(/^(\+\d{1,3})[\s/.\-–]*\(0\)/, '$1').replace(/\D/g, '');
			if (ziffern.length < regel.min_ziffern || ziffern.length > regel.max_ziffern) return fehler('keine gültige Telefonnummer (Anzahl Ziffern)');
			return { ok: true, wert: (s.startsWith('+') ? '+' : '') + ziffern };
		}
		case 'enum': {
			// Tolerant gegenüber Groß-/Kleinschreibung und einfacher Mehrzahl bzw. Beugung
			// ("Paletten" -> "Palette", "Pakete" -> "Paket"), aber nur mit eindeutigem Treffer.
			const s = String(roh).trim().toLowerCase().replace(/\s+/g, ' ');
			const werte = regel.werte || [];
			const ENDUNGEN = ['', 'n', 'en', 'e', 's', 'er'];
			let treffer = werte.find((w) => String(w).toLowerCase() === s);
			if (!treffer) {
				const kandidaten = werte.filter((w) => ENDUNGEN.some((e) => String(w).toLowerCase() + e === s));
				if (kandidaten.length === 1) treffer = kandidaten[0];
			}
			if (!treffer) return fehler(`nicht in der Werteliste (${(regel.werte || []).join(', ')})`);
			return { ok: true, wert: treffer };
		}
		default:
			return fehler(`Feldtyp "${feld.typ}" unbekannt`);
	}
}

/**
 * Die KI ergänzt bei Daten ohne Jahr ("am 3.11.") manchmal ein falsches Jahr. Steht das Jahr nicht in der Mail,
 * der Tag und Monat aber ohne Jahr, gilt das Datum als "TT.MM." (nächstes Vorkommen ab heute).
 * @returns {string|null} "T.M." oder null, wenn nichts zu korrigieren ist
 */
function jahrNichtImText(isoDatum, quelltext) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDatum || ''));
	if (!m || !quelltext) return null;
	const text = String(quelltext);
	const [j, mo, t] = [m[1], Number(m[2]), Number(m[3])];
	if (new RegExp(`(^|\\D)${j}(\\D|$)`).test(text)) return null;
	const ohneJahr = new RegExp(`(^|[^\\d.])0?${t}\\.0?${mo}\\.(?!\\d)`);
	return ohneJahr.test(text) ? `${t}.${mo}.` : null;
}

/**
 * Ansprechpartner nur mit Vor- oder Nachnamen ("Max"): steht im Absendernamen der vollständige Name
 * ("Max Müller") und passt er dazu, wird der vollständige Name übernommen. Sonst bleibt der Wert, wie er ist.
 * @returns {string|null} vollständiger Name oder null
 */
function nameVervollstaendigen(wert, absenderName) {
	const w = String(wert || '').replace(ANREDE, '').replace(/\s+/g, ' ').trim();
	const a = String(absenderName || '').replace(/["']/g, '').replace(/\s+/g, ' ').trim();
	if (!w || w.includes(' ') || !a || a.includes('@') || KEIN_PERSONENNAME.test(a)) return null;
	const teile = a.split(' ');
	if (teile.length < 2 || teile.length > 4 || !teile.every((t) => /^\p{L}[\p{L}.'-]*$/u.test(t))) return null;
	return teile.some((t) => t.toLowerCase() === w.toLowerCase()) ? a : null;
}

/**
 * Postleitzahlen und Telefonnummern müssen wörtlich in der Mail stehen. Sonst hat die KI sie ergänzt
 * (z. B. eine PLZ aus dem Ortsnamen abgeleitet) und der Wert gilt als ungültig.
 */
function wertImText(typ, wert, quelltext) {
	const text = String(quelltext || '');
	if (!text) return true;
	if (typ === 'plz') return new RegExp(`(^|[^\\d])${String(wert).replace(/[^\dA-Za-z]/g, '')}([^\\d]|$)`).test(text.replace(/(\d)\s+(?=\d)/g, '$1'));
	if (typ === 'telefon') {
		const t = text.replace(/(\d)[\s/().\-–]+(?=\d)/g, '$1');
		const w = String(wert).replace(/^\+/, '');
		const varianten = [w];
		if (w.startsWith('49')) varianten.push('0' + w.slice(2));
		if (w.startsWith('0')) varianten.push('49' + w.slice(1));
		return varianten.some((v) => t.includes(v));
	}
	return true;
}

/** Betreff, Mailtext und Anhangtexte einer normalisierten Mail als ein Text (für jahrNichtImText). */
function quelltextAus(mail) {
	const m = mail || {};
	return [m.betreff, m.text, ...(Array.isArray(m.anhaenge) ? m.anhaenge.map((a) => a && a.text) : [])].filter((x) => typeof x === 'string' && x).join('\n');
}

/**
 * @param {object} extrakt { Feldname: { wert, quelle, konfidenz } } (validierte LLM-Ausgabe)
 * @param {object[]} felder Feldliste aus der Config (config.vorgangstypen[typ])
 * @param {{ heute?: string, quelltext?: string }} [optionen] heute als JJJJ-MM-TT in der Zeitzone des Kunden;
 *   quelltext = Betreff, Mailtext und Anhangtexte (für die Prüfung von Daten ohne Jahr);
 *   absenderName = Anzeigename des Absenders (ergänzt einen Ansprechpartner, der nur mit Vornamen genannt ist)
 */
function pruefen(extrakt, felder, optionen = {}) {
	const daten = {};
	const fehlende = [];
	const hinweise = [];
	const unsicher = [];
	for (const f of felder || []) {
		const e = extrakt && extrakt[f.feldname] && typeof extrakt[f.feldname] === 'object' ? extrakt[f.feldname] : {};
		const roh = e.wert;
		const meta = { quelle: e.quelle ?? null, konfidenz: typeof e.konfidenz === 'number' ? e.konfidenz : null };
		let grund = null;
		let wert = null;
		if (roh === null || roh === undefined || (typeof roh === 'string' && roh.trim() === '')) grund = 'fehlt';
		else if (typeof roh === 'object') grund = 'ungültig: unerwartetes Format';
		else if (istPlatzhalter(roh, f.platzhalter_muster)) grund = 'Platzhalter statt Angabe';
		else {
			let eingabe = roh;
			if (f.typ === 'datum' && optionen.quelltext) eingabe = jahrNichtImText(datumLesen(roh), optionen.quelltext) || roh;
			if (f.typ === 'text' && f.validierungsregel && f.validierungsregel.person === true && optionen.absenderName) eingabe = nameVervollstaendigen(roh, optionen.absenderName) || roh;
			const r = feldPruefen(f, eingabe, optionen);
			if (r.ok && optionen.quelltext && !wertImText(f.typ, r.wert, optionen.quelltext)) grund = 'ungültig: steht so nicht in der Mail';
			else if (r.ok) wert = r.wert;
			else grund = `ungültig: ${r.grund}`;
		}
		daten[f.feldname] = { wert, roh: roh === undefined ? null : roh, ...meta };
		if (grund) {
			const eintrag = { feldname: f.feldname, anzeigename: f.anzeigename, grund };
			if (f.pflicht) fehlende.push(eintrag);
			else if (grund !== 'fehlt') hinweise.push(eintrag);
		} else if (meta.konfidenz !== null && meta.konfidenz < UNSICHER_UNTER) {
			unsicher.push({ feldname: f.feldname, anzeigename: f.anzeigename, konfidenz: meta.konfidenz });
		}
	}
	return { daten, fehlende, hinweise, unsicher, vollstaendig: fehlende.length === 0 };
}

/** Kompakte Sicht für Speicherung und Anzeige: { Feldname: wert } (nur gültige Werte). */
function werte(daten) {
	return Object.fromEntries(Object.entries(daten || {}).filter(([, v]) => v && v.wert !== null && v.wert !== undefined).map(([k, v]) => [k, v.wert]));
}

module.exports = { GLOBALE_PLATZHALTER, UNSICHER_UNTER, istPlatzhalter, zahlLesen, datumLesen, jahrNichtImText, quelltextAus, nameVervollstaendigen, wertImText, feldPruefen, pruefen, werte };
