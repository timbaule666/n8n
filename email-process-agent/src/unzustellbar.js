'use strict';
// Unzustellbarkeitsmeldungen (NDR) zu gesendeten Rückfragen erkennen (Testlauf 17.10.2026: Microsoft hat drei
// Rückfragen mit "550 5.7.708" abgewiesen, der Agent hielt sie für zugestellt). Feste Regeln, keine KI: Absender
// ist ein Mailsystem, Betreff bzw. Text sind die einer Unzustellbarkeitsmeldung. Der Vorgang ergibt sich aus der
// Vorgangs-ID (Betreff oder Text) oder, wenn die Rückfrage die Nummer nur im Mailtext trug, aus der Message-ID der
// zurückgekommenen Nachricht (Header In-Reply-To/References bzw. "Original Message Headers" im Text).

const SYSTEM = /^(mailer-daemon|postmaster|microsoftexchange[0-9a-f]*)@/i;
const BETREFF = /^\s*(undeliverable|unzustellbar|nicht zustellbar|delivery status notification \(failure\)|mail delivery failed|returned mail|undelivered mail returned|delivery has failed|zustellung fehlgeschlagen)\b/i;
const TEXT = /(delivery has failed|wasn't delivered|could not be delivered|konnte nicht zugestellt werden|unzustellbar|delivery to the following recipient)/i;
const VORGANGS_ID = /V-\d{4}-\d{4,}/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Nur Message-IDs aus Header-Zeilen ("Message-ID: <…>"), nicht jede Adresse in spitzen Klammern ("Tim <a@b.de>").
const HEADER_IDS = /^\s*(?:message-id|in-reply-to|references)\s*:\s*((?:<[^<>\s"]{1,400}>\s*)+)/gim;
const ID = /<[^<>\s"]{1,400}>/g;

function messageIdsAusText(text) {
	const out = [];
	for (const z of String(text || '').matchAll(HEADER_IDS)) out.push(...(z[1].match(ID) || []));
	return out;
}
// Empfängeradresse abgelehnt (5.1.x, "user unknown" usw.): Ein neuer Versuch an dieselbe Adresse scheitert wieder.
const ADRESSFEHLER = /\b5\.1\.\d{1,3}\b|user unknown|recipient (address )?rejected|address couldn't be found|wasn't found at|does(n't| not) exist|no such user/i;

// Freigabe-Status nach einer Unzustellbarkeitsmeldung:
// unzustellbar     = wartet auf Behebung; nach erfolgreichem Zustelltest kommt die Nachricht erneut zur Freigabe (EPA-04)
// nicht_zugestellt = kein automatischer neuer Versuch (Adresse abgelehnt oder schon der zweite Fehlversuch)
const STATUS_WARTET = 'unzustellbar';
const STATUS_ENDGUELTIG = 'nicht_zugestellt';
// Markiert die Freigabe, die nach einer Unzustellbarkeit neu angelegt wurde (Spalte grund). Kommt auch sie nicht
// an, gibt es keinen weiteren automatischen Versuch.
const ERNEUT_GRUND = 'Erneut nach Unzustellbarkeit';

/**
 * @param {object} mail normalisierte Mail (absender_adresse, betreff, text)
 * @param {string} postfach eigene Postfachadresse (kommt nie als Empfänger in Frage)
 * @returns {{ ist: boolean, vorgangs_id?: string|null, message_ids?: string[], empfaenger?: string|null, grund?: string }}
 *   vorgangs_id null: über message_ids den Vorgang suchen (bekannte_message_ids enthält die gesendeten Rückfragen).
 */
function erkennen(mail, postfach) {
	const m = mail || {};
	const betreff = String(m.betreff || '');
	const text = String(m.text || '');
	if (!SYSTEM.test(String(m.absender_adresse || ''))) return { ist: false };
	if (!BETREFF.test(betreff) && !TEXT.test(text)) return { ist: false };
	const id = (betreff.match(VORGANGS_ID) || text.match(VORGANGS_ID) || [])[0] || null;
	const messageIds = id ? [] : [...new Set([...(m.bezug_message_ids || []), ...messageIdsAusText(text)])].slice(0, 20);
	if (!id && !messageIds.length) return { ist: false };
	const eigen = String(postfach || '').toLowerCase();
	const empfaenger = (text.match(EMAIL) || []).map((a) => a.toLowerCase())
		.find((a) => a !== eigen && !SYSTEM.test(a) && !/\.prod\.outlook\.com$/.test(a)) || null;
	const smtp = text.match(/Remote server returned '([^']{1,240})'/i) || text.match(/\b([45]\d\d[ -][45]\.\d{1,3}\.\d{1,3}\b[^\n]{0,160})/);
	const grund = smtp ? smtp[1].replace(/\s+/g, ' ').trim().slice(0, 200) : 'Unzustellbarkeitsmeldung ohne genauen Grund';
	return { ist: true, vorgangs_id: id, message_ids: messageIds, empfaenger, grund };
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function istAdressfehler(grund) {
	return ADRESSFEHLER.test(String(grund || ''));
}

/**
 * Was wird aus der gesendeten Freigabe, zu der die Unzustellbarkeitsmeldung gehört?
 * @param {object} p
 * @param {object|null} p.freigabe aktuelle Freigabe des Vorgangs (epa_freigaben)
 * @param {string} p.grund Grund laut Mailserver (aus erkennen)
 * @returns {{ ok: false, grund: string } | { ok: true, erneut: boolean, daten: object }}
 */
function freigabeVermerk({ freigabe, grund }) {
	if (!freigabe || freigabe.status !== 'gesendet') return { ok: false, grund: 'keine_gesendete_freigabe' };
	const erneut = !istAdressfehler(grund) && freigabe.grund !== ERNEUT_GRUND;
	return {
		ok: true,
		erneut,
		daten: { status: erneut ? STATUS_WARTET : STATUS_ENDGUELTIG, grund: `Nicht zugestellt: ${String(grund || '').replace(/\s+/g, ' ').trim()}`.slice(0, 250) },
	};
}

/**
 * Warnung an den Kanal des Kunden (und als Störung an den Betreiber).
 * erneut: true = kommt nach erfolgreichem Zustelltest erneut zur Freigabe, false = kein neuer Versuch,
 * undefined = keine gesendete Freigabe gefunden.
 */
function meldung({ vorgangs_id, empfaenger, grund, betreff, eskaliert, erneut }) {
	const weiter = erneut === true
		? 'Der Kunde hat die Nachricht nicht bekommen. Sobald der Zustelltest (EPA-11, täglich 07:40 oder manuell) wieder klappt, kommt sie automatisch mit neuem Link erneut zur Freigabe. Wer nicht warten will: telefonisch klären.'
		: erneut === false
			? 'Der Kunde hat die Nachricht nicht bekommen. Kein automatischer neuer Versuch (Empfängeradresse abgelehnt oder schon der zweite Fehlversuch). Bitte telefonisch klären oder die Adresse prüfen.'
			: 'Der Kunde hat die Rückfrage nicht bekommen. Bitte telefonisch klären oder die Adresse prüfen.';
	return [
		`<b>📭 Nachricht nicht zugestellt</b>`,
		`Vorgang: <b>${esc(vorgangs_id)}</b>`,
		betreff ? `Betreff: ${esc(betreff)}` : null,
		empfaenger ? `Empfänger: ${esc(empfaenger)}` : null,
		`Grund laut Mailserver: ${esc(grund)}`,
		weiter,
		eskaliert ? 'Der Vorgang steht auf „Eskaliert / Manuell“; es gehen keine Erinnerungen raus.' : 'Der Vorgang wurde nicht umgestellt (Status erlaubt keinen Wechsel); bitte manuell prüfen.',
	].filter(Boolean).join('<br>');
}

module.exports = { STATUS_WARTET, STATUS_ENDGUELTIG, ERNEUT_GRUND, erkennen, istAdressfehler, freigabeVermerk, meldung };
