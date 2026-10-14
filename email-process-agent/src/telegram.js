'use strict';
// Telegram als Benachrichtigungskanal NUR für interne Tests (Config: kanal "telegram_test"); Kunden nutzen immer Teams.
// Die Meldungstexte werden für Teams als HTML gebaut. Telegram versteht nur wenige Tags (b, i, u, s, a, code, pre)
// und keine Zeilenumbruch-Tags; alles andere wird in Text bzw. Zeilenumbrüche umgesetzt.

const MAX_LAENGE = 4096;
const ERLAUBT = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', code: 'code', pre: 'pre' };
const BENANNT = { nbsp: ' ', amp: '&amp;', lt: '&lt;', gt: '&gt;', quot: '&quot;', apos: '&#39;' };

function escapeText(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Teams-HTML -> Telegram-HTML (parse_mode HTML), höchstens 4096 Zeichen. */
function htmlZuTelegram(html) {
	let s = String(html ?? '');
	s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
	s = s.replace(/<br\s*\/?>/gi, '\n');
	s = s.replace(/<\/(p|div|ul|ol|tr|table|h[1-6]|dl|dd)>/gi, '\n');
	s = s.replace(/<(ul|ol)\b[^>]*>/gi, '\n');
	s = s.replace(/<li\b[^>]*>/gi, '• ');
	s = s.replace(/<\/li>/gi, '\n');
	s = s.replace(/<dt\b[^>]*>/gi, '').replace(/<\/dt>/gi, ': ');
	s = s.replace(/<\/td>/gi, ' ');
	// Übrige Tags: erlaubte normalisieren, Links behalten (nur http/https), alles andere entfernen.
	s = s.replace(/<(\/?)([a-z0-9]+)([^>]*)>/gi, (m, zu, tag, rest) => {
		const t = tag.toLowerCase();
		if (Object.hasOwn(ERLAUBT, t)) return `<${zu}${ERLAUBT[t]}>`;
		if (t === 'a') {
			if (zu) return '</a>';
			const href = (rest.match(/href\s*=\s*"([^"]*)"/i) || rest.match(/href\s*=\s*'([^']*)'/i) || [])[1];
			return href && /^https?:\/\//i.test(href) ? `<a href="${href.replace(/"/g, '&quot;')}">` : '<a>';
		}
		return '';
	});
	// <a> ohne gültiges Ziel samt Endtag auflösen
	s = s.replace(/<a>([\s\S]*?)<\/a>/g, '$1');
	// Entitäten: Telegram kennt nur &lt; &gt; &amp; &quot; und numerische.
	s = s.replace(/&([a-z]+);/gi, (m, n) => (Object.hasOwn(BENANNT, n.toLowerCase()) ? BENANNT[n.toLowerCase()] : m.replace('&', '&amp;')));
	s = s.replace(/&(?!(amp|lt|gt|quot|#\d+|#x[0-9a-f]+);)/gi, '&amp;');
	s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
	if (s.length <= MAX_LAENGE) return s;
	// Zu lang: ohne Formatierung kürzen, damit kein Tag mitten im Text abgeschnitten wird.
	const text = s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
	let kurz = escapeText(text.slice(0, MAX_LAENGE - 40));
	while (kurz.length > MAX_LAENGE - 20) kurz = kurz.slice(0, -1).replace(/&[a-z#0-9]*$/i, '');
	return `${kurz}\n… (gekürzt)`;
}

/** Chat-ID für Telegram: Zahl (Gruppen negativ) oder @kanalname. */
function istChatId(v) {
	return /^-?\d{3,20}$/.test(String(v ?? '').trim()) || /^@[A-Za-z0-9_]{5,32}$/.test(String(v ?? '').trim());
}

/** Ziel-Chat für einen Freigeber: eigene Zuordnung, sonst der allgemeine Chat. */
function chatFuerFreigeber(benachrichtigung, freigeber) {
	const b = benachrichtigung || {};
	const map = b.freigeber_chat_ids || {};
	return String(map[String(freigeber || '').toLowerCase()] || b.chat_id || '');
}

module.exports = { MAX_LAENGE, htmlZuTelegram, istChatId, chatFuerFreigeber, escapeText };
