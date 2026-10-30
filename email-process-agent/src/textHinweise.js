'use strict';
// Feste Regeln (ohne KI) für Fälle, die die Extraktion still übergehen würde (Härtetest 16.10.2026):
// mehrere Aufträge in einer Mail, Stornierung bzw. Absage, mehrdeutiges Datum mit Schrägstrichen.
// Ergebnis sind nur Hinweise an die Mitarbeiter; an Daten und Status ändert sich nichts.

// Fünfstellige Zahl, nicht Teil einer längeren Ziffernfolge (Telefon-, Rechnungs-, Auftragsnummern).
// Folgt eine weitere Zahlengruppe ("02302 5557037"), ist es eine Telefonvorwahl, keine PLZ (Härtetest 2, X037).
const PLZ = /(?<![\d.,+/-])\b\d{5}\b(?![\d.,/-])(?![ \t]*[/-]?[ \t]*\d{3})/g;
const MEHRERE_WORTE = /\b(zwei|drei|vier|mehrere|2|3|4)\s+(transporte|aufträge|auftraege|touren|sendungen|fahrten|abholungen|lieferungen|shipments|orders)\b/i;
const PLZ_EINZELN = new RegExp(PLZ.source);
const NUMMERIERT = /^\s*(\d)[.)]\s+\S/;

/** Mehrere Aufträge? Mehr als zwei verschiedene PLZ, ausdrückliche Mengenangabe oder nummerierte Liste mit PLZ. */
function mehrereAuftraege(text) {
	const s = String(text || '');
	const plz = [...new Set(s.match(PLZ) || [])];
	const nummern = s.split('\n').filter((z) => NUMMERIERT.test(z) && PLZ_EINZELN.test(z));
	const worte = MEHRERE_WORTE.test(s);
	return { verdacht: plz.length > 2 || worte || nummern.length > 1, plz };
}

const STORNO = /\b(stornier\w*|storno\w*|absag\w*|sagen?\s+(\w+\s+){0,3}ab\b|hat sich (\w+\s+)?erledigt|nicht mehr (nötig|noetig|benötigt|benoetigt|erforderlich|gebraucht)|zurückzieh\w*|zurückgezogen|cancel\w*|no longer (needed|required))/i;

/** Zeile, in der der Kunde storniert bzw. absagt (gekürzt), sonst null. Zitierte Zeilen (">") zählen nicht. */
function stornoStelle(text) {
	for (const zeile of String(text || '').split('\n')) {
		if (/^\s*>/.test(zeile)) continue;
		if (STORNO.test(zeile)) return zeile.replace(/\s+/g, ' ').trim().slice(0, 200);
	}
	return null;
}

/** Daten wie "12/11/2026", bei denen Tag und Monat vertauschbar sind (beide ≤ 12, verschieden). */
function mehrdeutigeDaten(text) {
	const treffer = [];
	for (const m of String(text || '').matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/g)) {
		const a = Number(m[1]);
		const b = Number(m[2]);
		if (a >= 1 && b >= 1 && a <= 12 && b <= 12 && a !== b) treffer.push(m[0]);
	}
	return [...new Set(treffer)];
}

// ---------------------------------------------------------------- Widersprüche und Alternativen (Härtetest 2)

const DATUM_DE = /(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/g;
const DATUM_ISO = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
const GEWICHT = /(?<![\d.,])(\d{1,3}(?:[.\s]\d{3})+|\d+(?:,\d+)?)\s*(kg|kilo\w*|t|to|tonnen?)(?![\p{L}])/giu;
const ALTERNATIV = /\b(oder|or|bzw\.?|beziehungsweise|alternativ)\b/i;

function iso(j, m, t) {
	const d = [Number(j), Number(m), Number(t)];
	if (d[1] < 1 || d[1] > 12 || d[2] < 1 || d[2] > 31) return null;
	return `${d[0]}-${String(d[1]).padStart(2, '0')}-${String(d[2]).padStart(2, '0')}`;
}

/** Alle vollständigen Daten (TT.MM.JJJJ oder JJJJ-MM-TT) eines Textes als ISO, ohne Doppelte. */
function datenIn(text) {
	const s = String(text || '');
	const out = [...s.matchAll(DATUM_DE)].map((m) => iso(m[3], m[2], m[1]));
	out.push(...[...s.matchAll(DATUM_ISO)].map((m) => iso(m[1], m[2], m[3])));
	return [...new Set(out.filter(Boolean))];
}

/** Alle Gewichtsangaben eines Textes in kg ("1.200 kg", "2,5 t" → 2500), ohne Doppelte. */
function gewichteIn(text) {
	const out = [];
	for (const m of String(text || '').matchAll(GEWICHT)) {
		const zahl = /^\d{1,3}([.\s]\d{3})+$/.test(m[1]) ? Number(m[1].replace(/[.\s]/g, '')) : Number(m[1].replace(',', '.'));
		if (!Number.isFinite(zahl)) continue;
		out.push(Math.round(/^(t|to|tonne|tonnen)$/i.test(m[2]) ? zahl * 1000 : zahl));
	}
	return [...new Set(out)];
}

const datumText = (d) => d.split('-').reverse().join('.');

/**
 * Mailtext und Anhang nennen unterschiedliche Gewichte bzw. Daten (beide nennen eins, keins stimmt überein).
 * Die KI übernimmt still einen der Werte; der Mitarbeiter soll den Widerspruch sehen.
 */
function widerspruecheAnhang(mail) {
	const m = mail || {};
	const h = [];
	const textGewicht = gewichteIn(m.text);
	const textDatum = datenIn(m.text);
	for (const a of m.anhaenge || []) {
		if (!a || typeof a.text !== 'string' || !a.text.trim()) continue;
		const g = gewichteIn(a.text);
		if (textGewicht.length && g.length && !g.some((x) => textGewicht.includes(x))) {
			h.push(`Mailtext und Anhang „${a.name}“ nennen unterschiedliche Gewichte: Mailtext ${textGewicht.join(' / ')} kg, Anhang ${g.join(' / ')} kg – bitte prüfen.`);
		}
		const d = datenIn(a.text);
		if (textDatum.length && d.length && !d.some((x) => textDatum.includes(x))) {
			h.push(`Mailtext und Anhang „${a.name}“ nennen unterschiedliche Daten: Mailtext ${textDatum.map(datumText).join(' / ')}, Anhang ${d.map(datumText).join(' / ')} – bitte prüfen.`);
		}
	}
	return h;
}

/** Mehrere Daten in einer Zeile, verbunden mit "oder", "bzw." …: der Kunde lässt die Wahl, erfasst wird nur eins. */
function alternativeDaten(text) {
	for (const zeile of String(text || '').split('\n')) {
		if (/^\s*>/.test(zeile) || !ALTERNATIV.test(zeile)) continue;
		const d = datenIn(zeile);
		if (d.length >= 2) return d;
	}
	return [];
}

/**
 * Alle Hinweise zu einer Mail als Texte (unescaped; der Aufrufer escaped).
 * @param {object} mail normalisierte Mail (betreff, text)
 * @param {{ antwort?: boolean }} [optionen] antwort: Kundenantwort zu einem bestehenden Vorgang (prüft auf Stornierung)
 */
function alle(mail, optionen = {}) {
	const m = mail || {};
	const text = [m.betreff, m.text].filter(Boolean).join('\n');
	const h = [];
	const mehrere = mehrereAuftraege(m.text);
	if (mehrere.verdacht) {
		h.push(`Die Mail enthält möglicherweise mehrere Aufträge${mehrere.plz.length > 2 ? ` (${mehrere.plz.length} verschiedene Postleitzahlen)` : ''}. Erfasst wurde nur ein Auftrag – bitte die Mail prüfen und weitere Aufträge manuell anlegen.`);
	}
	const daten = mehrdeutigeDaten(text);
	if (daten.length) h.push(`Datum ${daten.join(', ')} ist mehrdeutig (Tag/Monat vertauschbar) – bitte beim Kunden bestätigen.`);
	const alternativen = alternativeDaten(m.text);
	if (alternativen.length) h.push(`Mehrere mögliche Daten genannt (${alternativen.map(datumText).join(' oder ')}). Erfasst wurde nur eines – bitte beim Kunden klären.`);
	h.push(...widerspruecheAnhang(m));
	return { hinweise: h, storno: optionen.antwort ? stornoStelle(m.text) : null };
}

// Mails ohne Anfrage, bei denen trotzdem jemand handeln muss (Härtetest 2: Stornierung ohne Bezug, Rückrufbitte,
// Frage zum Stand, nur Foto im Anhang). Diese Mails werden gemeldet statt still ignoriert.
const RUECKRUF = /(\bbitte\s+(\w+\s+){0,3}zurückrufen|\bruf(en)?\s+(sie\s+)?(mich|uns)\s+(\w+\s+){0,3}(an|zurück)\b|\b(um|erbitte\w*)\s+(einen\s+|ihren\s+)?rückruf|\brückruf\s+(erbeten|erwünscht|gewünscht)|\bcall\s+me(\s+back)?\b|\bgive\s+(me|us)\s+a\s+call\b|\bcall\s*back\b)/i;
const STAND = /(\bwie\s+ist\s+der\s+stand\b|\bstand\s+der\s+dinge\b|\bwie\s+weit\s+ist\b|\bgibt\s+es\s+(schon\s+)?(neuigkeiten|ein\s+update)\b|\bstatus\s+(zu|von|meiner|unserer|des|der|of)\b|\bany\s+update\b|\bwhat\s+is\s+the\s+status\b)/i;
const ANHANG = /(\b(siehe|anbei|im|in\s+der)\s+(\w+\s+){0,2}(anhang|anlage|foto|bild|datei)\b|\b(see|find)\s+(\w+\s+){0,2}attach\w*|\battached\b)/i;
const ANHANG_KI = /(foto|bild|anhang|attachment|ohne (text|inhalt))/i;
const ANHANG_NEIN = /(rechnung|gutschrift|zahlung|mahnung|newsletter|werbung|bewerbung)/i;

function zeileMit(text, re) {
	for (const zeile of String(text || '').split('\n')) {
		if (/^\s*>/.test(zeile)) continue;
		if (re.test(zeile)) return zeile.replace(/\s+/g, ' ').trim().slice(0, 200);
	}
	return null;
}

/**
 * Anlass, eine Mail ohne Anfrage trotzdem zu melden, sonst null.
 * @param {object} mail normalisierte Mail
 * @param {string} [begruendung] Begründung der Klassifizierung (nur Zusatzindiz für "nur Anhang")
 * @returns {{ anlass: 'storno'|'rueckruf'|'status'|'anhang', stelle: string|null, vorgangs_ids?: string[] }|null}
 */
function handlungKeineAnfrage(mail, begruendung) {
	const m = mail || {};
	if ((m.auto_antwort && m.auto_antwort.ist) || (m.newsletter_hinweise || []).length || m.eigene_mail) return null;
	const text = String(m.text || '');
	const storno = stornoStelle(text);
	if (storno) return { anlass: 'storno', stelle: storno };
	const rueckruf = zeileMit(text, RUECKRUF);
	if (rueckruf) return { anlass: 'rueckruf', stelle: rueckruf };
	const ids = m.vorgangs_ids_erwaehnt || [];
	const stand = zeileMit(text, STAND);
	if (stand || ids.length) return { anlass: 'status', stelle: stand || zeileMit(text, /V-\d{4}-\d{3,}/), vorgangs_ids: ids };
	const b = String(begruendung || '');
	if ((m.anhaenge || []).length && !ANHANG_NEIN.test(b) && (zeileMit(text, ANHANG) || ANHANG_KI.test(b))) {
		return { anlass: 'anhang', stelle: zeileMit(text, ANHANG) };
	}
	return null;
}

module.exports = { mehrereAuftraege, stornoStelle, mehrdeutigeDaten, alternativeDaten, widerspruecheAnhang, datenIn, gewichteIn, alle, handlungKeineAnfrage };
