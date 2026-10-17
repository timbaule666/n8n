'use strict';
// Rückfrage-Entwurf (Masterprompt C1, C2; Bauplan 5.5).
// Das LLM liefert nur die Hülle (Anrede, Einleitung, Schluss) als getrennte Felder. Die festen Textbausteine,
// die Signatur und der KI-Hinweis werden hier deterministisch eingesetzt. Damit stehen die Bausteine
// konstruktionsbedingt wortgleich in der Mail. Die Hülle wird geprüft; bei Verstoß gilt das Template-Gerüst (Fallback).

const MAX = Object.freeze({ anrede: 80, einleitung: 400, schluss: 300, gesamt: 600 });

// Zusage- und Fakten-Wörter, die in der Hülle nichts verloren haben (Wortanfänge, klein).
const VERBOTEN = Object.freeze([
	'garantier', 'zusag', 'zusich', 'verbindlich', 'kostenlos', 'gratis', 'preis', 'rabatt', 'euro', 'versprech',
	'spätestens', 'innerhalb von', 'bis zum', 'sofort', 'umgehend', 'bestätigen wir', 'guarantee', 'free of charge', 'price', 'discount',
]);

function normalisiereLeerraum(s) {
	return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** Anzeigename des Kunden für die Anrede: nur Buchstaben, Leerzeichen, Bindestrich, Punkt; sonst leer. */
function sichererName(name) {
	const n = normalisiereLeerraum(name).replace(/^["']|["']$/g, '');
	if (!n || n.length > 60 || n.includes('@')) return '';
	return /^[\p{L}][\p{L} .'-]*$/u.test(n) ? n : '';
}

/**
 * Antwortsprache: die erkannte Sprache der Kundenmail, wenn die Config dafür Übersetzungen hat; sonst die Hauptsprache.
 * Liefert eine Config-Sicht, in der sprache, signatur, ki_hinweistext und textbausteine zur Antwortsprache passen.
 */
function sprachConfig(config, erkannteSprache) {
	const c = config || {};
	const s = String(erkannteSprache || '').trim().toLowerCase();
	const u = c.uebersetzungen && s && s !== c.sprache ? c.uebersetzungen[s] : null;
	if (!u) return { ...c, textbausteine: null };
	return { ...c, sprache: s, signatur: u.signatur, ki_hinweistext: u.ki_hinweistext, textbausteine: u.textbausteine };
}

/**
 * Name für die Anrede: der erkannte Ansprechpartner (Feld mit Regel person), sonst leer (neutrale Anrede).
 * Bewusst nicht der Absendername: der gehört oft zu einem Sammelpostfach oder einem Weiterleitenden.
 * Die Rückfrage geht immer an den Absender. Ist der Absender erkennbar eine andere Person als der Ansprechpartner
 * (z. B. ein Kollege leitet die Anfrage weiter), wäre "Guten Tag <Ansprechpartner>" an ihn falsch: dann neutral.
 * @param {string} [absenderName] Anzeigename des Absenders der Kundenmail
 */
function ansprechpartner(extrahierteDaten, felder, absenderName) {
	const d = extrahierteDaten && typeof extrahierteDaten === 'object' ? extrahierteDaten : {};
	for (const f of felder || []) {
		const r = f.validierungsregel || {};
		if (f.typ !== 'text' || r.person !== true) continue;
		const w = d[f.feldname] && d[f.feldname].wert;
		const n = sichererName(w);
		if (n) return andererAbsender(n, absenderName) ? '' : n;
	}
	return '';
}

/** Absender ist eine Person (mindestens Vor- und Nachname) ohne gemeinsamen Namensteil mit dem Ansprechpartner. */
function andererAbsender(name, absenderName) {
	const a = sichererName(absenderName);
	if (!a) return false;
	const teile = (s) => s.toLowerCase().split(/[\s.]+/).filter((t) => t.length > 1);
	const at = teile(a);
	if (at.length < 2) return false;
	const nt = new Set(teile(name));
	return !at.some((t) => nt.has(t));
}

/** Feste Bausteine der fehlenden Felder in Config-Reihenfolge. Fehlender Baustein = Konfigurationsfehler. */
function bausteine(fehlende, felder, textbausteine) {
	const nachName = new Map((felder || []).map((f) => [f.feldname, f]));
	const fehlendeNamen = new Set((fehlende || []).map((f) => f.feldname));
	const out = [];
	for (const f of felder || []) {
		if (!fehlendeNamen.has(f.feldname)) continue;
		const b = normalisiereLeerraum(textbausteine && textbausteine[f.feldname] ? textbausteine[f.feldname] : f.resolution_textbaustein);
		if (!b) throw new Error(`Textbaustein für Feld "${f.feldname}" fehlt`);
		out.push({ feldname: f.feldname, anzeigename: f.anzeigename, text: b });
	}
	for (const n of fehlendeNamen) if (!nachName.has(n)) throw new Error(`Feld "${n}" ist in der Config unbekannt`);
	return out;
}

/** Template-Gerüst ohne LLM (Fallback). */
function vorlage({ anrede_stil: stil, sprache }, name) {
	const n = sichererName(name);
	if (sprache === 'en') {
		return {
			anrede: n ? `Dear ${n},` : 'Hello,',
			einleitung: 'Thank you for your request. To process it, we still need the following information:',
			schluss: 'Thank you in advance for your reply.',
		};
	}
	if (stil === 'Du') {
		return {
			anrede: n ? `Hallo ${n},` : 'Hallo,',
			einleitung: 'vielen Dank für deine Anfrage. Damit wir sie bearbeiten können, brauchen wir noch folgende Angaben:',
			schluss: 'Vielen Dank für deine Rückmeldung.',
		};
	}
	return {
		anrede: n ? `Guten Tag ${n},` : 'Guten Tag,',
		einleitung: 'vielen Dank für Ihre Anfrage. Damit wir sie bearbeiten können, benötigen wir noch folgende Angaben:',
		schluss: 'Vielen Dank für Ihre Rückmeldung.',
	};
}

/** Template für die Erinnerung an den Kunden (Phase E, Fall 1). Bewusst ohne LLM: deterministisch und prüfbar. */
function vorlageErinnerung({ anrede_stil: stil, sprache }, name) {
	const n = sichererName(name);
	if (sprache === 'en') {
		return {
			anrede: n ? `Dear ${n},` : 'Hello,',
			einleitung: 'we would like to kindly remind you of our previous message. To process your request, we still need the following information:',
			schluss: 'Thank you in advance for your reply.',
		};
	}
	if (stil === 'Du') {
		return {
			anrede: n ? `Hallo ${n},` : 'Hallo,',
			einleitung: 'wir möchten dich freundlich an unsere letzte Nachricht erinnern. Damit wir deine Anfrage bearbeiten können, brauchen wir noch folgende Angaben:',
			schluss: 'Vielen Dank für deine Rückmeldung.',
		};
	}
	return {
		anrede: n ? `Guten Tag ${n},` : 'Guten Tag,',
		einleitung: 'wir möchten Sie freundlich an unsere letzte Nachricht erinnern. Damit wir Ihre Anfrage bearbeiten können, benötigen wir noch folgende Angaben:',
		schluss: 'Vielen Dank für Ihre Rückmeldung.',
	};
}

/**
 * Prüft die vom LLM gelieferte Hülle. Gibt eine Liste von Verstößen zurück (leer = in Ordnung).
 * Name des Kunden darf in der Anrede stehen, sonst keine Ziffern, Beträge, URLs, Adressen, Zusagen.
 */
// Grobe Sprachprüfung der KI-Hülle: typische Wörter der jeweils anderen Sprache (gpt-4o-mini schreibt sonst gern Deutsch).
const FREMD = Object.freeze({
	en: /[äöüß]|\b(und|ihre?|ihnen|vielen|dank|guten|tag|bitte|wir|sie|für|noch|anfrage|rückmeldung|damit|benötigen|folgende)\b/i,
	de: /\b(the|thank|thanks|please|dear|regards|your|we|request|following|kind)\b/i,
});

function huellePruefen(huelle, { anrede_stil: stil, sprache } = {}) {
	const fehler = [];
	if (!huelle || typeof huelle !== 'object') return ['keine Hülle'];
	let gesamt = 0;
	for (const teil of ['anrede', 'einleitung', 'schluss']) {
		const t = normalisiereLeerraum(huelle[teil]);
		gesamt += t.length;
		if (!t) fehler.push(`${teil}: leer`);
		if (t.length > MAX[teil]) fehler.push(`${teil}: zu lang`);
		if (/\d/.test(t)) fehler.push(`${teil}: enthält Ziffern`);
		if (/[€$£]|\b(eur|usd|chf)\b/i.test(t)) fehler.push(`${teil}: enthält Währung`);
		if (/(https?:\/\/|www\.|\b[a-z0-9-]+\.(de|com|net|org|eu|io)\b)/i.test(t)) fehler.push(`${teil}: enthält Link`);
		if (/@/.test(t)) fehler.push(`${teil}: enthält E-Mail-Adresse`);
		if (/[{}[\]<>]/.test(t)) fehler.push(`${teil}: enthält Platzhalter oder Markup`);
		const klein = t.toLowerCase();
		for (const w of VERBOTEN) if (klein.includes(w)) fehler.push(`${teil}: verbotenes Wort "${w}"`);
		if (stil === 'Sie' && /\b(du|dich|dir|dein|deine|deinen|deinem|deiner|euch|euer)\b/i.test(t)) fehler.push(`${teil}: duzt statt siezt`);
		if (stil === 'Sie' && /(^|[.!?]\s+|\s)ihr\b/.test(t)) fehler.push(`${teil}: duzt statt siezt`);
	}
	if (gesamt > MAX.gesamt) fehler.push('Hülle insgesamt zu lang');
	const fremd = FREMD[sprache];
	if (fremd && ['anrede', 'einleitung', 'schluss'].some((t) => fremd.test(normalisiereLeerraum(huelle[t])))) fehler.push(`Hülle nicht in der Antwortsprache (${sprache})`);
	return [...new Set(fehler)];
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Editierbarer Teil als Text (für Vorschau und Bearbeiten-Formular). */
function bearbeitbarerText(huelle, bs) {
	return [normalisiereLeerraum(huelle.anrede), '', normalisiereLeerraum(huelle.einleitung), '', ...bs.map((b) => `- ${b.text}`), '', normalisiereLeerraum(huelle.schluss)].join('\n');
}

/** Fester Abschluss: Signatur und KI-Hinweis (nie vom LLM, nie im Formular änderbar). */
function abschlussText(config) {
	return [String(config.signatur || '').trim(), '', '--', String(config.ki_hinweistext || '').trim()].join('\n');
}

/** Gespeicherten Abschluss (abschlussText) wieder in Signatur und KI-Hinweis zerlegen, z. B. für bearbeitete Entwürfe. */
function abschlussTeile(abschluss) {
	const t = String(abschluss || '');
	const i = t.lastIndexOf('\n\n--\n');
	if (i < 0) return null;
	return { signatur: t.slice(0, i).trim(), ki_hinweistext: t.slice(i + 5).trim() };
}

/** Text (bearbeitbarer Teil) -> HTML-Mail mit festem Abschluss. Text wird vollständig escaped. */
function zuHtml(text, config) {
	const absatz = (t) => esc(t).replace(/\r\n?/g, '\n').replace(/\n/g, '<br>');
	return `<div style="font-family:Arial,sans-serif;font-size:11pt">${absatz(text)}<br><br>${absatz(String(config.signatur || '').trim())}<br><br><span style="color:#666;font-size:9pt">${esc(String(config.ki_hinweistext || '').trim())}</span></div>`;
}

/**
 * Setzt den Entwurf zusammen.
 * @param {object|null} llmHuelle { anrede, einleitung, schluss } oder null (LLM fehlgeschlagen)
 * @returns {{ text, html, abschluss, bausteine, fallback, pruefung }}
 */
function entwurfBauen(llmHuelle, { config, felder, fehlende, name }) {
	const bs = bausteine(fehlende, felder, config.textbausteine);
	if (!bs.length) throw new Error('Keine fehlenden Felder: keine Rückfrage nötig');
	const pruefung = llmHuelle ? huellePruefen(llmHuelle, config) : ['LLM-Entwurf nicht verfügbar'];
	const fallback = pruefung.length > 0;
	const huelle = fallback ? vorlage(config, name) : llmHuelle;
	const text = bearbeitbarerText(huelle, bs);
	return { text, html: zuHtml(text, config), abschluss: abschlussText(config), bausteine: bs, fallback, pruefung };
}

/** Erinnerungs-Entwurf: Template-Hülle, feste Bausteine der noch offenen Felder, fester Abschluss. */
function erinnerungBauen({ config, felder, fehlende, name }) {
	const bs = bausteine(fehlende, felder, config.textbausteine);
	if (!bs.length) throw new Error('Keine fehlenden Felder: keine Erinnerung nötig');
	const text = bearbeitbarerText(vorlageErinnerung(config, name), bs);
	return { text, html: zuHtml(text, config), abschluss: abschlussText(config), bausteine: bs, fallback: false, pruefung: [] };
}

/**
 * Prüft einen vom Mitarbeiter bearbeiteten Text. Er darf frei formulieren; abgelehnt werden nur leere oder
 * übermäßig lange Texte. Fehlende Bausteine werden als Hinweis gemeldet (der Mitarbeiter verantwortet die Änderung).
 */
function bearbeitungPruefen(text, bs) {
	const t = String(text ?? '').replace(/\r\n?/g, '\n').trim();
	if (!t) return { ok: false, grund: 'Der Text ist leer.' };
	if (t.length > 5000) return { ok: false, grund: 'Der Text ist zu lang (max. 5000 Zeichen).' };
	const norm = normalisiereLeerraum(t);
	const fehlend = (bs || []).filter((b) => !norm.includes(b.text)).map((b) => b.anzeigename);
	return { ok: true, text: t, bausteine_entfernt: fehlend };
}

module.exports = { MAX, VERBOTEN, sichererName, sprachConfig, ansprechpartner, abschlussTeile, bausteine, vorlage, vorlageErinnerung, erinnerungBauen, huellePruefen, bearbeitbarerText, abschlussText, zuHtml, entwurfBauen, bearbeitungPruefen, esc };
