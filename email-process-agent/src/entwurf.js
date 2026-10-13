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

/** Feste Bausteine der fehlenden Felder in Config-Reihenfolge. Fehlender Baustein = Konfigurationsfehler. */
function bausteine(fehlende, felder) {
	const nachName = new Map((felder || []).map((f) => [f.feldname, f]));
	const fehlendeNamen = new Set((fehlende || []).map((f) => f.feldname));
	const out = [];
	for (const f of felder || []) {
		if (!fehlendeNamen.has(f.feldname)) continue;
		const b = normalisiereLeerraum(f.resolution_textbaustein);
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

/**
 * Prüft die vom LLM gelieferte Hülle. Gibt eine Liste von Verstößen zurück (leer = in Ordnung).
 * Name des Kunden darf in der Anrede stehen, sonst keine Ziffern, Beträge, URLs, Adressen, Zusagen.
 */
function huellePruefen(huelle, { anrede_stil: stil } = {}) {
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
	const bs = bausteine(fehlende, felder);
	if (!bs.length) throw new Error('Keine fehlenden Felder: keine Rückfrage nötig');
	const pruefung = llmHuelle ? huellePruefen(llmHuelle, config) : ['LLM-Entwurf nicht verfügbar'];
	const fallback = pruefung.length > 0;
	const huelle = fallback ? vorlage(config, name) : llmHuelle;
	const text = bearbeitbarerText(huelle, bs);
	return { text, html: zuHtml(text, config), abschluss: abschlussText(config), bausteine: bs, fallback, pruefung };
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

module.exports = { MAX, VERBOTEN, sichererName, bausteine, vorlage, huellePruefen, bearbeitbarerText, abschlussText, zuHtml, entwurfBauen, bearbeitungPruefen, esc };
