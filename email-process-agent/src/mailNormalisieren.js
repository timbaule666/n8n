'use strict';
// Normalisiert eine eingehende Mail (Graph-Message-Objekt) für die weitere Verarbeitung (Masterprompt A1–A3, B2).
// Rein deterministisch: Header lesen, Betreff normalisieren, HTML -> Text, zitierte Vorverläufe abschneiden,
// Auto-Replies / eigene Mails / Newsletter erkennen, Spoofing-Basisprüfung, Anhänge nach Limits einordnen.
// Der Mailinhalt gilt als nicht vertrauenswürdig: hier wird nichts davon ausgeführt oder interpretiert.

const STANDARD = Object.freeze({
	max_zeichen_text: 15000,
	max_zeichen_anhaenge: 20000,
	max_mb_je_anhang: 10,
	max_mb_je_mail: 25,
	typen: ['application/pdf', 'image/jpeg', 'image/png'],
});

// Präfixe in Betreffzeilen (mehrfach und gemischt möglich): Re, AW, WG, Fwd, Fw, SV, VS, Antw, R, [Ticket …]
const PRAEFIX = /^\s*((re|aw|wg|fwd?|sv|vs|antw|r|tr|rif|odp|vb)(\[\d+\])?\s*:|\[[^\]]{1,40}\])\s*/i;
const WEITERLEITUNG = /^\s*(wg|fwd?|tr|vs|vb)(\[\d+\])?\s*:/i;
const ANTWORT = /^\s*(re|aw|sv|antw|r|rif|odp)(\[\d+\])?\s*:/i;
const VORGANGS_ID = /\bV-\d{4}-\d{4,}\b/g;

const AUTO_BETREFF = [
	/^(automatische antwort|automatic reply|auto(matic)?[- ]?reply|autoreply|abwesenheits?(notiz|meldung)?|out of (the )?office|abwesend|nicht im büro|réponse automatique|risposta automatica)\b/i,
	/^(unzustellbar|undeliverable|delivery status notification|mail delivery (failed|subsystem)|returned mail|nicht zustellbar|zustellung fehlgeschlagen)\b/i,
];
const SYSTEM_ABSENDER = /^(mailer-daemon|postmaster|no-?reply|noreply|donotreply|do-not-reply|bounce[s]?)@/i;

function headerMap(liste) {
	const map = {};
	for (const h of Array.isArray(liste) ? liste : []) {
		if (!h || typeof h.name !== 'string') continue;
		const k = h.name.toLowerCase();
		(map[k] = map[k] || []).push(String(h.value ?? ''));
	}
	return map;
}

function header(map, name) {
	const v = map[name.toLowerCase()];
	return v && v.length ? v[0] : null;
}

/** Message-IDs aus In-Reply-To/References ("<a@b> <c@d>"). */
function messageIds(text) {
	if (!text) return [];
	const m = String(text).match(/<[^<>\s]+>/g);
	return m ? [...new Set(m)] : [];
}

function adresse(obj) {
	const e = obj && obj.emailAddress ? obj.emailAddress : obj || {};
	return {
		adresse: typeof e.address === 'string' ? e.address.trim().toLowerCase() : null,
		name: typeof e.name === 'string' ? e.name.trim() : null,
	};
}

function domain(adr) {
	if (!adr || !adr.includes('@')) return null;
	return adr.slice(adr.lastIndexOf('@') + 1).toLowerCase();
}

/** Betreff ohne Antwort-/Weiterleitungspräfixe und Ticketmarken, klein, Leerraum zusammengefasst. */
function betreffNormalisieren(betreff) {
	let s = String(betreff || '');
	for (let i = 0; i < 10; i++) {
		const neu = s.replace(PRAEFIX, '');
		if (neu === s) break;
		s = neu;
	}
	return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

const ENTITAETEN = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€', ndash: '–', mdash: '—', bdquo: '„', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', shy: '' };

function entitaeten(s) {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
		if (e[0] === '#') {
			const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
		}
		return e in ENTITAETEN ? ENTITAETEN[e] : m;
	});
}

/** HTML -> lesbarer Text (Zeilenumbrüche bleiben erhalten, Zitatblöcke werden mit "> " markiert). */
function htmlZuText(html) {
	let s = String(html || '');
	s = s.replace(/<!--[\s\S]*?-->/g, '');
	s = s.replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
	// Outlook trennt den Vorverlauf mit einem div (border-top) bzw. <hr>; als Trennlinie markieren.
	s = s.replace(/<div[^>]*id=["']?(divRplyFwdMsg|appendonsend)["']?[^>]*>/gi, '\n________________________________\n');
	s = s.replace(/<hr[^>]*>/gi, '\n________________________________\n');
	s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, inhalt) => '\n' + htmlZuText(inhalt).split('\n').map((z) => '> ' + z).join('\n') + '\n');
	s = s.replace(/<br\s*\/?>/gi, '\n');
	s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol)\s*>/gi, '\n');
	s = s.replace(/<li[^>]*>/gi, '- ');
	s = s.replace(/<\/t[dh]\s*>/gi, '\t');
	s = s.replace(/<[^>]+>/g, '');
	s = entitaeten(s);
	return s
		.replace(/\r\n?/g, '\n')
		.replace(/[ \t ]+/g, ' ')
		.split('\n')
		.map((z) => z.trim())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// Zeilen, ab denen ein zitierter Vorverlauf beginnt.
const ZITAT_START = [
	/^-{2,}\s*(original message|ursprüngliche nachricht|originalnachricht|weitergeleitete nachricht|forwarded message|message d'origine)\s*-{2,}/i,
	/^_{10,}\s*$/,
	/^(am|on|le|il)\s.{4,200}\s(schrieb|wrote|a écrit|ha scritto)\b.{0,120}:?\s*$/i,
];
const KOPF_VON = /^\*?(von|from|de|da)\s*:\*?\s*\S/i;
const KOPF_FOLGE = /^\*?(gesendet|sent|datum|date|an|to|betreff|subject|envoyé|inviato)\s*:\*?/i;

/**
 * Schneidet zitierte Vorverläufe ab. Gibt { neu, zitat_entfernt } zurück.
 * Bei Weiterleitungen wird nichts abgeschnitten (der weitergeleitete Teil ist der eigentliche Inhalt).
 */
function zitateAbschneiden(text, { weiterleitung = false } = {}) {
	const zeilen = String(text || '').split('\n');
	if (weiterleitung) return { neu: zeilen.join('\n').trim(), zitat_entfernt: false };
	let ende = zeilen.length;
	for (let i = 0; i < zeilen.length; i++) {
		const z = zeilen[i].trim();
		// "Am ... schrieb" kann über zwei Zeilen umbrechen.
		const doppel = i + 1 < zeilen.length ? `${z} ${zeilen[i + 1].trim()}` : z;
		if (ZITAT_START.some((r) => r.test(z)) || (/^(am|on)\s/i.test(z) && ZITAT_START[2].test(doppel))) {
			ende = i;
			break;
		}
		if (KOPF_VON.test(z)) {
			const folge = zeilen.slice(i + 1, i + 5).map((x) => x.trim());
			if (folge.some((x) => KOPF_FOLGE.test(x))) {
				ende = i;
				break;
			}
		}
	}
	const behalten = zeilen.slice(0, ende).filter((z) => !/^\s*>/.test(z));
	const entfernt = ende < zeilen.length || behalten.length < ende;
	return { neu: behalten.join('\n').replace(/\n{3,}/g, '\n\n').trim(), zitat_entfernt: entfernt };
}

function kuerzen(text, max) {
	const s = String(text || '');
	if (s.length <= max) return { text: s, gekuerzt: false };
	return { text: s.slice(0, max) + '\n[… gekürzt]', gekuerzt: true };
}

function autoAntwort(headers, betreff, absender) {
	const auto = (header(headers, 'auto-submitted') || '').toLowerCase();
	if (auto && auto !== 'no') return { ist: true, grund: `Auto-Submitted: ${auto}` };
	const praez = (header(headers, 'precedence') || '').toLowerCase();
	if (praez === 'auto_reply') return { ist: true, grund: 'Precedence: auto_reply' };
	if (header(headers, 'x-autoreply') || header(headers, 'x-autorespond')) return { ist: true, grund: 'X-Autoreply' };
	if (absender && SYSTEM_ABSENDER.test(absender) && /^(mailer-daemon|postmaster)@/i.test(absender)) return { ist: true, grund: 'Unzustellbarkeitsmeldung' };
	const b = String(betreff || '').replace(PRAEFIX, '').trim();
	for (const r of AUTO_BETREFF) if (r.test(b) || r.test(String(betreff || '').trim())) return { ist: true, grund: 'Betreff einer automatischen Antwort' };
	return { ist: false, grund: null };
}

function newsletterHinweis(headers, absender) {
	const gruende = [];
	if (header(headers, 'list-unsubscribe')) gruende.push('List-Unsubscribe');
	if (header(headers, 'list-id')) gruende.push('List-Id');
	const praez = (header(headers, 'precedence') || '').toLowerCase();
	if (praez === 'bulk' || praez === 'list' || praez === 'junk') gruende.push(`Precedence: ${praez}`);
	if (absender && SYSTEM_ABSENDER.test(absender)) gruende.push('No-Reply-Absender');
	return gruende;
}

/** Basisprüfung auf Spoofing/Phishing. Ergebnis ist nur ein Hinweis, keine automatische Reaktion. */
function spoofingPruefen(headers, von, sender, antwortAn) {
	const hinweise = [];
	const auth = (headers['authentication-results'] || []).join(' ').toLowerCase();
	for (const art of ['spf', 'dkim', 'dmarc']) {
		// "none" (kein Eintrag beim Absender) ist zu häufig für einen Hinweis; nur echte Fehlschläge zählen.
		const m = auth.match(new RegExp(`\\b${art}=(fail|softfail|permerror)\\b`));
		if (m) hinweise.push(`${art.toUpperCase()} ${m[1]}`);
	}
	const vd = domain(von.adresse);
	if (sender.adresse && von.adresse && sender.adresse !== von.adresse && domain(sender.adresse) !== vd) {
		hinweise.push('Sender weicht von From ab (im Auftrag gesendet)');
	}
	const rpd = domain(antwortAn);
	if (rpd && vd && rpd !== vd) hinweise.push('Reply-To zeigt auf andere Domain');
	const anzeige = von.name || '';
	const imNamen = anzeige.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
	if (imNamen && imNamen[0].toLowerCase() !== von.adresse) hinweise.push('Anzeigename enthält eine andere Adresse');
	return { auffaellig: hinweise.length > 0, hinweise };
}

function listeTrifft(liste, adr) {
	if (!adr) return false;
	const d = domain(adr);
	return (Array.isArray(liste) ? liste : []).some((e) => {
		const x = String(e || '').trim().toLowerCase();
		if (!x) return false;
		if (x.startsWith('@')) return d === x.slice(1);
		if (!x.includes('@')) return d === x || (d && d.endsWith('.' + x));
		return x === adr;
	});
}

/**
 * Ordnet Anhänge nach Typ- und Größenlimits ein.
 * anhaenge: [{ name, contentType, size, isInline, text?, status?, bild_data_url? }] (vom Postfach-Workflow vorbereitet)
 */
function anhaengeEinordnen(anhaenge, limits) {
	const l = { ...STANDARD, ...(limits || {}) };
	const typen = (Array.isArray(l.typen) ? l.typen : STANDARD.typen).map((t) => String(t).toLowerCase());
	let summe = 0;
	let textRest = l.max_zeichen_anhaenge;
	const out = [];
	for (const a of Array.isArray(anhaenge) ? anhaenge : []) {
		if (!a || a.isInline === true) continue; // Logos/Signaturbilder
		const typ = String(a.contentType || '').toLowerCase().split(';')[0].trim();
		const groesse = Number(a.size) || 0;
		summe += groesse;
		const eintrag = { name: String(a.name || 'Anhang').slice(0, 200), typ, groesse_bytes: groesse, status: 'ok', text: null, bild: false, hinweis: null };
		if (!typen.includes(typ)) {
			eintrag.status = 'typ_nicht_erlaubt';
			eintrag.hinweis = 'Dateityp wird nicht ausgewertet';
		} else if (groesse > l.max_mb_je_anhang * 1024 * 1024) {
			eintrag.status = 'zu_gross';
			eintrag.hinweis = `größer als ${l.max_mb_je_anhang} MB`;
		} else if (summe > l.max_mb_je_mail * 1024 * 1024) {
			eintrag.status = 'zu_gross';
			eintrag.hinweis = `Mail insgesamt größer als ${l.max_mb_je_mail} MB`;
		} else if (a.status && a.status !== 'ok') {
			eintrag.status = a.status; // z. B. 'leer', 'defekt', 'ohne_textebene' aus der Extraktion
			eintrag.hinweis = a.hinweis || null;
		} else if (typ.startsWith('image/')) {
			eintrag.bild = true;
			if (typeof a.bild_data_url === 'string' && a.bild_data_url.startsWith('data:image/')) eintrag.bild_data_url = a.bild_data_url;
			else {
				eintrag.status = 'nicht_ausgewertet';
				eintrag.hinweis = 'Bild nicht automatisch ausgewertet';
			}
		} else {
			const t = String(a.text || '').replace(/\s+\n/g, '\n').trim();
			if (!t) {
				eintrag.status = typ === 'application/pdf' ? 'ohne_textebene' : 'leer';
				eintrag.hinweis = typ === 'application/pdf' ? 'PDF ohne Textebene (Scan?), bitte manuell prüfen' : 'Anhang ohne lesbaren Text';
			} else {
				const k = kuerzen(t, Math.max(0, textRest));
				eintrag.text = k.text;
				eintrag.gekuerzt = k.gekuerzt;
				textRest -= k.text.length;
			}
		}
		out.push(eintrag);
	}
	return out;
}

/**
 * @param {object} msg Graph-Message (internetMessageId, conversationId, subject, body, from, sender, replyTo,
 *   toRecipients, ccRecipients, receivedDateTime, internetMessageHeaders, id)
 * @param {object} cfg { postfach, anhang_limits, absender_allowlist, absender_blocklist }
 * @param {object[]} [anhaenge]
 */
function normalisieren(msg, cfg, anhaenge) {
	const m = msg || {};
	const c = cfg || {};
	const limits = { ...STANDARD, ...(c.anhang_limits || {}) };
	const headers = headerMap(m.internetMessageHeaders);
	const von = adresse(m.from);
	const sender = adresse(m.sender);
	const antwortAn = Array.isArray(m.replyTo) && m.replyTo.length ? adresse(m.replyTo[0]).adresse : null;
	const betreff = typeof m.subject === 'string' ? m.subject : '';
	const messageId = String(m.internetMessageId || header(headers, 'message-id') || '').trim();

	const bodyTyp = m.body && String(m.body.contentType || '').toLowerCase();
	const roh = m.body ? (bodyTyp === 'html' ? htmlZuText(m.body.content) : entitaeten(String(m.body.content || '')).replace(/\r\n?/g, '\n').trim()) : String(m.bodyPreview || '');
	const istWeiterleitung = WEITERLEITUNG.test(betreff);
	const istAntwort = ANTWORT.test(betreff) || Boolean(header(headers, 'in-reply-to'));
	const z = zitateAbschneiden(roh, { weiterleitung: istWeiterleitung });
	const k = kuerzen(z.neu, limits.max_zeichen_text);

	const postfach = String(c.postfach || '').toLowerCase();
	const eigene = Boolean((von.adresse && von.adresse === postfach) || header(headers, 'x-epa-vorgang'));
	const inReplyTo = messageIds(header(headers, 'in-reply-to'));
	const references = messageIds((headers.references || []).join(' '));
	const erwaehnt = [...new Set([...(betreff.match(VORGANGS_ID) || []), ...(k.text.match(VORGANGS_ID) || [])])];

	return {
		message_id: messageId || null,
		graph_id: m.id || null,
		conversation_id: m.conversationId || null,
		in_reply_to: inReplyTo,
		references,
		bezug_message_ids: [...new Set([...inReplyTo, ...references])],
		betreff: betreff.slice(0, 500),
		betreff_normalisiert: betreffNormalisieren(betreff).slice(0, 300),
		ist_antwort: istAntwort,
		ist_weiterleitung: istWeiterleitung,
		absender_adresse: von.adresse,
		absender_name: von.name,
		absender_domain: domain(von.adresse),
		antwort_an: antwortAn,
		empfangen_am: m.receivedDateTime || null,
		text: k.text,
		text_gekuerzt: k.gekuerzt,
		zitat_entfernt: z.zitat_entfernt,
		text_leer: k.text.replace(/\s+/g, '').length === 0,
		vorgangs_ids_erwaehnt: erwaehnt,
		eigene_mail: eigene,
		auto_antwort: autoAntwort(headers, betreff, von.adresse),
		newsletter_hinweise: newsletterHinweis(headers, von.adresse),
		gesperrt: listeTrifft(c.absender_blocklist, von.adresse),
		vertrauenswuerdig: listeTrifft(c.absender_allowlist, von.adresse),
		spoofing: spoofingPruefen(headers, von, sender, antwortAn),
		anhaenge: anhaengeEinordnen(anhaenge, limits),
	};
}

/**
 * Vorentscheidung ohne LLM: Mails, die nie verarbeitet werden. Gibt null zurück, wenn die Mail weiterläuft.
 */
function vorpruefung(n) {
	if (!n.message_id) return { ergebnis: 'ungueltig', grund: 'internetMessageId fehlt' };
	if (n.eigene_mail) return { ergebnis: 'eigene_mail', grund: 'Mail aus dem eigenen Postfach bzw. vom System' };
	if (n.auto_antwort.ist) return { ergebnis: 'auto_antwort', grund: n.auto_antwort.grund };
	if (n.gesperrt) return { ergebnis: 'gesperrt', grund: 'Absender steht auf der Blockliste' };
	return null;
}

module.exports = {
	STANDARD,
	headerMap,
	messageIds,
	betreffNormalisieren,
	htmlZuText,
	zitateAbschneiden,
	anhaengeEinordnen,
	spoofingPruefen,
	listeTrifft,
	normalisieren,
	vorpruefung,
};
