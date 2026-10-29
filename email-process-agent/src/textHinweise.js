'use strict';
// Feste Regeln (ohne KI) für Fälle, die die Extraktion still übergehen würde (Härtetest 16.10.2026):
// mehrere Aufträge in einer Mail, Stornierung bzw. Absage, mehrdeutiges Datum mit Schrägstrichen.
// Ergebnis sind nur Hinweise an die Mitarbeiter; an Daten und Status ändert sich nichts.

// Fünfstellige Zahl, nicht Teil einer längeren Ziffernfolge (Telefon-, Rechnungs-, Auftragsnummern).
const PLZ = /(?<![\d.,+/-])\b\d{5}\b(?![\d.,/-])/g;
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

module.exports = { mehrereAuftraege, stornoStelle, mehrdeutigeDaten, alle, handlungKeineAnfrage };
