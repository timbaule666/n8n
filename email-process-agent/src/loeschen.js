'use strict';
// Lösch- und Aufräumjob (Masterprompt 7, Bauplan Datenschutz): Daten nur so lange wie nötig.
// - Vorgänge in einem Endstatus ("Abgeschlossen", "Ignoriert") nach aufbewahrung_tage seit der letzten Änderung,
//   samt Audit, Freigaben und Freigabe-Links. Offene oder eskalierte Vorgänge werden nie automatisch gelöscht.
// - Dedupe-Einträge (epa_verarbeitete_mails) nach aufbewahrung_tage.
// - Fehlerlog nach 90 Tagen (enthält nur IDs und technische Meldungen).
// - Ersetzte Rückfrage-Entwürfe im Postfach (nie gesendet, nie mehr gültig). Gelöscht wird nur, was nachweislich
//   ein Entwurf ist und die passende Freigabe-Kennung trägt. Outlook verschiebt ihn in "Gelöschte Elemente".

const ENDSTATUS = Object.freeze(['Abgeschlossen', 'Ignoriert']);
const FEHLERLOG_TAGE = 90;
const MAX_VORGAENGE = 200;
const MAX_ENTWUERFE = 50;
const TAG = 86400000;

function ms(t) {
	if (t === null || t === undefined || t === '') return NaN;
	const x = new Date(t).getTime();
	return Number.isFinite(x) ? x : NaN;
}

/**
 * @param {object} p
 * @param {string} p.jetzt
 * @param {object[]} p.vorgaenge  Zeilen aus epa_vorgaenge (mit updatedAt)
 * @param {object[]} p.freigaben  Zeilen aus epa_freigaben
 * @param {object} p.configs      kunde_id -> { aufbewahrung_tage, postfach, postfach_workflow_id } (auch inaktive Kunden)
 */
function planen({ jetzt, vorgaenge, freigaben, configs, maxVorgaenge = MAX_VORGAENGE, maxEntwuerfe = MAX_ENTWUERFE }) {
	const t = ms(jetzt);
	if (!Number.isFinite(t)) throw new Error(`Ungültiger Zeitpunkt "${jetzt}"`);
	const ohneConfig = new Set();
	const tage = (kunde) => {
		const c = configs[kunde];
		const n = c ? Number(c.aufbewahrung_tage) : NaN;
		if (!(n > 0)) {
			ohneConfig.add(kunde);
			return null;
		}
		return n;
	};

	// Ersetzte Entwürfe, die noch im Postfach liegen
	const offeneEntwuerfe = (freigaben || []).filter((f) => f && f.status === 'ersetzt' && f.entwurf_id && !f.entwurf_entfernt_am);
	const entwuerfe = [];
	for (const f of offeneEntwuerfe) {
		const c = configs[f.kunde_id];
		if (!c || !c.postfach_workflow_id || !c.postfach) continue;
		if (entwuerfe.length >= maxEntwuerfe) break;
		entwuerfe.push({ kunde_id: f.kunde_id, vorgangs_id: f.vorgangs_id, freigabe_id: f.freigabe_id, entwurf_id: f.entwurf_id, postfach: c.postfach, postfach_workflow_id: c.postfach_workflow_id });
	}
	const entwurfOffen = new Set(offeneEntwuerfe.map((f) => `${f.kunde_id}|${f.vorgangs_id}`));

	// Vorgänge nach Ablauf der Aufbewahrung
	const zuLoeschen = [];
	let zurueckgestellt = 0;
	for (const v of vorgaenge || []) {
		if (!v || !ENDSTATUS.includes(v.status)) continue;
		const n = tage(v.kunde_id);
		if (n === null) continue;
		const stand = ms(v.updatedAt);
		if (!Number.isFinite(stand) || stand + n * TAG > t) continue;
		// Erst den alten Entwurf aus dem Postfach entfernen, dann die Freigabe (sonst ginge die Zuordnung verloren).
		if (entwurfOffen.has(`${v.kunde_id}|${v.vorgangs_id}`)) {
			zurueckgestellt += 1;
			continue;
		}
		zuLoeschen.push({ kunde_id: v.kunde_id, vorgangs_id: v.vorgangs_id });
	}
	const vorgaengeListe = zuLoeschen.slice(0, maxVorgaenge);
	const schluessel = new Set(vorgaengeListe.map((v) => `${v.kunde_id}|${v.vorgangs_id}`));
	const freigabeIds = (freigaben || []).filter((f) => f && schluessel.has(`${f.kunde_id}|${f.vorgangs_id}`)).map((f) => ({ kunde_id: f.kunde_id, vorgangs_id: f.vorgangs_id, freigabe_id: f.freigabe_id }));

	const mailGrenzen = Object.keys(configs).map((k) => ({ kunde_id: k, n: tage(k) })).filter((x) => x.n !== null)
		.map((x) => ({ kunde_id: x.kunde_id, grenze: new Date(t - x.n * TAG).toISOString() }));

	return {
		vorgaenge: vorgaengeListe,
		freigaben: freigabeIds,
		entwuerfe,
		mail_grenzen: mailGrenzen,
		fehler_grenze: new Date(t - FEHLERLOG_TAGE * TAG).toISOString(),
		zurueckgestellt,
		verschoben: Math.max(0, zuLoeschen.length - maxVorgaenge) + Math.max(0, offeneEntwuerfe.length - entwuerfe.length),
		ohne_config: [...ohneConfig].sort(),
	};
}

/**
 * Darf der Entwurf gelöscht werden? Antwort von GET /messages/{id} mit fullResponse.
 * @returns {{ loeschen: boolean, erledigt: boolean, grund: string }}
 */
function entwurfPruefen(antwort, freigabeId, eigenschaftId) {
	const status = Number(antwort && antwort.statusCode);
	if (status === 404) return { loeschen: false, erledigt: true, grund: 'nicht_mehr_vorhanden' };
	if (status !== 200) return { loeschen: false, erledigt: false, grund: `http_${status || 'unbekannt'}` };
	const b = (antwort && antwort.body) || {};
	if (b.isDraft !== true) return { loeschen: false, erledigt: true, grund: 'kein_entwurf' };
	const prop = (b.singleValueExtendedProperties || []).find((p) => String(p.id).toLowerCase() === String(eigenschaftId).toLowerCase());
	if (!prop || prop.value !== freigabeId) return { loeschen: false, erledigt: true, grund: 'kennung_passt_nicht' };
	return { loeschen: true, erledigt: true, grund: 'entwurf_geloescht' };
}

function zusammenfassung(plan) {
	return {
		vorgaenge: plan.vorgaenge.length,
		freigaben: plan.freigaben.length,
		entwuerfe: plan.entwuerfe.length,
		zurueckgestellt: plan.zurueckgestellt,
		verschoben: plan.verschoben,
		ohne_config: plan.ohne_config,
		fehler_grenze: plan.fehler_grenze,
	};
}

module.exports = { ENDSTATUS, FEHLERLOG_TAGE, MAX_VORGAENGE, MAX_ENTWUERFE, planen, entwurfPruefen, zusammenfassung };
