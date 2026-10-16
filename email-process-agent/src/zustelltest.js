'use strict';
// Täglicher Zustelltest (EPA-11): Jedes Kundenpostfach schickt eine Kontrollmail an ein externes Prüfpostfach des
// Betreibers. Kommt sie nicht an, ist der Versand gestört, obwohl Microsoft "gesendet" meldet (z. B. Konto nach
// Sperre eingeschränkt). Dann erreichen Rückfragen keine Kunden; das soll sofort auffallen (Testphase 16.10.2026).

const PRAEFIX = 'EPA-Zustelltest';
const WARTEN_MINUTEN = 10;
const SCHLUESSEL = (kundeId) => `zustelltest:${kundeId}`;

function istAdresse(s) {
	return /^[^@<>\s]+@[^@<>\s]+\.[A-Za-z]{2,}$/.test(String(s || ''));
}

/** Eindeutiger Betreff je Kunde und Lauf, z. B. "EPA-Zustelltest epa-test 202610160740-k3x9". */
function betreff(kundeId, jetzt, zufall) {
	const stempel = String(jetzt).slice(0, 16).replace(/[-:T]/g, '');
	return `${PRAEFIX} ${kundeId} ${stempel}-${zufall}`;
}

/**
 * Ein Auftrag je aktivem Kunden mit Postfach-Workflow.
 * @param {object[]} configs geprüfte Configs
 */
function auftraege(configs, { jetzt, zufall, pruefadresse }) {
	if (!istAdresse(pruefadresse)) throw new Error('Prüfadresse fehlt oder ist ungültig');
	return (configs || [])
		.filter((c) => c && c.postfach && c.postfach_workflow_id)
		.map((c) => ({
			kunde_id: c.kunde_id,
			postfach: c.postfach,
			postfach_workflow_id: c.postfach_workflow_id,
			empfaenger: pruefadresse,
			betreff: betreff(c.kunde_id, jetzt, zufall),
			kanal: c.benachrichtigung || {},
		}));
}

/** Darf EPA-00 diese Testmail senden? Nur an eine Adresse, nur mit Zustelltest-Betreff (kein freier Versand). */
function sendenErlaubt({ empfaenger, betreff: b }) {
	if (!istAdresse(empfaenger)) return { ok: false, grund: 'Empfänger ungültig' };
	if (!String(b || '').startsWith(PRAEFIX + ' ') || String(b).length > 120) return { ok: false, grund: 'Betreff ist kein Zustelltest' };
	return { ok: true };
}

/**
 * Ergebnis je Auftrag.
 * @param {object[]} liste Aufträge (Reihenfolge wie gesendet)
 * @param {object[]} sendungen Antworten von EPA-00 (gleiche Reihenfolge): { gesendet, status, meldung } oder { error }
 * @param {string[]} gefunden Betreffzeilen, die im Prüfpostfach angekommen sind
 */
function auswerten(liste, sendungen, gefunden) {
	const da = new Set((gefunden || []).map((s) => String(s || '').trim()));
	return (liste || []).map((a, i) => {
		const s = (sendungen || [])[i] || {};
		if (s.error || s.gesendet !== true) {
			const grund = String((s.error && (s.error.message || s.error)) || s.meldung || `HTTP ${s.status || '?'}`).replace(/\s+/g, ' ').slice(0, 200);
			return { ...a, ok: false, art: 'versand_abgelehnt', grund: `Microsoft hat den Versand abgelehnt: ${grund}` };
		}
		if (!da.has(a.betreff)) return { ...a, ok: false, art: 'nicht_angekommen', grund: `Microsoft meldet "gesendet", die Testmail ist nach ${WARTEN_MINUTEN} Minuten aber nicht im Prüfpostfach angekommen` };
		return { ...a, ok: true, art: 'ok', grund: '' };
	});
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Warnung an den Kanal des Kunden, wenn die Testmail nicht ankommt. */
function meldung(e) {
	return [
		'<b>🚫 Systemwarnung: Postfach versendet keine Mails</b>',
		`Postfach: ${esc(e.postfach)}`,
		`Grund: ${esc(e.grund)}`,
		'Folge: Rückfragen und Erinnerungen erreichen die Kunden vermutlich nicht, obwohl sie als gesendet gelten.',
		'Was tun: Im Postfach anmelden und auf Sperr- oder Bestätigungshinweise des Anbieters achten (z. B. account.microsoft.com → Sicherheit). Bis zur Klärung wichtige Rückfragen telefonisch stellen.',
		`Test: ${esc(e.betreff)}`,
	].join('<br>');
}

/** Zeile für epa_system_status (nur Zähler und Kennung, keine Inhalte). */
function stand(e, jetzt) {
	return { schluessel: SCHLUESSEL(e.kunde_id), letzter_lauf: jetzt, letztes_ergebnis: JSON.stringify({ ok: e.ok, art: e.art }) };
}

module.exports = { PRAEFIX, WARTEN_MINUTEN, SCHLUESSEL, istAdresse, betreff, auftraege, sendenErlaubt, auswerten, meldung, stand };
