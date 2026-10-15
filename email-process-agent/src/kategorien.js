'use strict';
// Outlook-Kategorien (farbige Markierungen) an den Kundenmails eines Vorgangs, passend zum Status.
// Config (epa_config_allgemein.outlook_kategorien), optional: { "<Status>": { "name": "AI Geprüft", "farbe": "preset4" } }
// Farben sind die Outlook-Voreinstellungen preset0 … preset24 (preset0 = Rot, preset4 = Grün).
// Status ohne Eintrag ändern nichts (z. B. Zwischenstände wie "In Prüfung"); in ENTFERNEN_BEI werden die
// Markierungen des Systems entfernt. Fremde Kategorien des Postfachs bleiben immer unangetastet.

const ENTFERNEN_BEI = Object.freeze(['Abgeschlossen', 'Ignoriert', 'Eskaliert / Manuell']);
const FARBE = /^preset([0-9]|1[0-9]|2[0-4])$/;

/** Prüft die Config. Liefert die bereinigte Zuordnung Status -> { name, farbe }. */
function configPruefen(roh, fehler, bekannteStatus) {
	if (roh === undefined || roh === null || roh === '') return {};
	let k = roh;
	if (typeof k === 'string') {
		try { k = JSON.parse(k); } catch { fehler.push('outlook_kategorien: kein gültiges JSON'); return {}; }
	}
	if (!k || typeof k !== 'object' || Array.isArray(k)) { fehler.push('outlook_kategorien: muss ein Objekt { "<Status>": { name, farbe } } sein'); return {}; }
	const out = {};
	for (const [status, e] of Object.entries(k)) {
		const p = `outlook_kategorien.${status}`;
		if (bekannteStatus && !bekannteStatus.includes(status)) { fehler.push(`${p}: Status ist unbekannt`); continue; }
		if (!e || typeof e !== 'object') { fehler.push(`${p}: muss { name, farbe } sein`); continue; }
		const name = typeof e.name === 'string' ? e.name.trim() : '';
		if (!name || name.length > 60 || /[,;]/.test(name)) { fehler.push(`${p}.name: 1–60 Zeichen, ohne Komma/Semikolon`); continue; }
		if (e.farbe !== undefined && !FARBE.test(String(e.farbe))) { fehler.push(`${p}.farbe: preset0 bis preset24`); continue; }
		out[status] = { name, farbe: e.farbe ? String(e.farbe) : null };
	}
	return out;
}

/** Alle Kategorienamen, die das System verwaltet. */
function systemNamen(kategorien) {
	return [...new Set(Object.values(kategorien || {}).map((k) => k.name))];
}

/**
 * Was beim Statuswechsel zu tun ist.
 * @returns {{ aktion: 'setzen'|'entfernen'|null, name: string|null, farbe: string|null, system_namen: string[] }}
 */
function plan(kategorien, neuerStatus) {
	const namen = systemNamen(kategorien);
	if (!namen.length) return { aktion: null, name: null, farbe: null, system_namen: [] };
	const k = kategorien[neuerStatus];
	if (k) return { aktion: 'setzen', name: k.name, farbe: k.farbe, system_namen: namen };
	if (ENTFERNEN_BEI.includes(neuerStatus)) return { aktion: 'entfernen', name: null, farbe: null, system_namen: namen };
	return { aktion: null, name: null, farbe: null, system_namen: namen };
}

/** Neue Kategorienliste einer Mail: fremde bleiben, eigene werden ersetzt bzw. entfernt. null = keine Änderung nötig. */
function neueKategorien(vorhanden, p) {
	const alt = Array.isArray(vorhanden) ? vorhanden : [];
	const fremde = alt.filter((c) => !p.system_namen.includes(c));
	const neu = p.aktion === 'setzen' ? [...fremde, p.name] : fremde;
	const gleich = neu.length === alt.length && neu.every((c) => alt.includes(c));
	return gleich ? null : neu;
}

/** Internet-Message-IDs der Mails eines Vorgangs (erste Mail und alle bekannten), ohne Duplikate. */
function messageIds(vorgang) {
	const v = vorgang || {};
	let bekannt = v.bekannte_message_ids;
	if (typeof bekannt === 'string') { try { bekannt = JSON.parse(bekannt); } catch { bekannt = []; } }
	return [...new Set([v.erste_message_id, ...(Array.isArray(bekannt) ? bekannt : [])].filter((x) => typeof x === 'string' && x))].slice(0, 50);
}

module.exports = { ENTFERNEN_BEI, configPruefen, systemNamen, plan, neueKategorien, messageIds };
