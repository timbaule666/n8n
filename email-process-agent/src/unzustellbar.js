'use strict';
// Unzustellbarkeitsmeldungen (NDR) zu gesendeten Rückfragen erkennen (Testlauf 17.10.2026: Microsoft hat drei
// Rückfragen mit "550 5.7.708" abgewiesen, der Agent hielt sie für zugestellt). Feste Regeln, keine KI: Absender
// ist ein Mailsystem, Betreff bzw. Text sind die einer Unzustellbarkeitsmeldung, und der Betreff trägt eine Vorgangs-ID.

const SYSTEM = /^(mailer-daemon|postmaster|microsoftexchange[0-9a-f]*)@/i;
const BETREFF = /^\s*(undeliverable|unzustellbar|nicht zustellbar|delivery status notification \(failure\)|mail delivery failed|returned mail|undelivered mail returned|delivery has failed|zustellung fehlgeschlagen)\b/i;
const TEXT = /(delivery has failed|wasn't delivered|could not be delivered|konnte nicht zugestellt werden|unzustellbar|delivery to the following recipient)/i;
const VORGANGS_ID = /V-\d{4}-\d{4,}/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/**
 * @param {object} mail normalisierte Mail (absender_adresse, betreff, text)
 * @param {string} postfach eigene Postfachadresse (kommt nie als Empfänger in Frage)
 * @returns {{ ist: boolean, vorgangs_id?: string, empfaenger?: string|null, grund?: string }}
 */
function erkennen(mail, postfach) {
	const m = mail || {};
	const betreff = String(m.betreff || '');
	const text = String(m.text || '');
	if (!SYSTEM.test(String(m.absender_adresse || ''))) return { ist: false };
	if (!BETREFF.test(betreff) && !TEXT.test(text)) return { ist: false };
	const id = (betreff.match(VORGANGS_ID) || [])[0];
	if (!id) return { ist: false };
	const eigen = String(postfach || '').toLowerCase();
	const empfaenger = (text.match(EMAIL) || []).map((a) => a.toLowerCase())
		.find((a) => a !== eigen && !SYSTEM.test(a) && !/\.prod\.outlook\.com$/.test(a)) || null;
	const smtp = text.match(/Remote server returned '([^']{1,240})'/i) || text.match(/\b([45]\d\d[ -][45]\.\d{1,3}\.\d{1,3}\b[^\n]{0,160})/);
	const grund = smtp ? smtp[1].replace(/\s+/g, ' ').trim().slice(0, 200) : 'Unzustellbarkeitsmeldung ohne genauen Grund';
	return { ist: true, vorgangs_id: id, empfaenger, grund };
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Warnung an den Kanal des Kunden. */
function meldung({ vorgangs_id, empfaenger, grund, betreff, eskaliert }) {
	return [
		`<b>📭 Nachricht nicht zugestellt</b>`,
		`Vorgang: <b>${esc(vorgangs_id)}</b>`,
		betreff ? `Betreff: ${esc(betreff)}` : null,
		empfaenger ? `Empfänger: ${esc(empfaenger)}` : null,
		`Grund laut Mailserver: ${esc(grund)}`,
		'Der Kunde hat die Rückfrage nicht bekommen. Bitte telefonisch klären oder die Adresse prüfen.',
		eskaliert ? 'Der Vorgang steht auf „Eskaliert / Manuell“; es gehen keine Erinnerungen raus.' : 'Der Vorgang wurde nicht umgestellt (Status erlaubt keinen Wechsel); bitte manuell prüfen.',
	].filter(Boolean).join('<br>');
}

module.exports = { erkennen, meldung };
