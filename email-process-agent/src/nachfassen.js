'use strict';
// Phase E (Masterprompt Workflow 4, Bauplan 2.2/6): Nachfassen beim Kunden, Eskalation, Erinnerung an Freigeber
// und Erneuerung abgelaufener Freigabe-Links. Reine Planungslogik: EPA-04 liest Vorgänge, offene Freigaben und
// Configs, dieses Modul entscheidet, was zu tun ist. Ausgeführt wird jede Aufgabe einzeln in "EPA SW Nachfassen".
// Es wird nie automatisch an Kunden gesendet: Eine Erinnerung an den Kunden ist immer ein Entwurf mit Freigabe.

const LOCK_SCHLUESSEL = 'epa04_lauf';
const LOCK_MINUTEN = 55;
const MAX_AUFGABEN = 50;
const EPOCHE = '1970-01-01T00:00:00.000Z';
const WARTEN = 'Warten auf Kunde';

// Reihenfolge, falls mehr Aufgaben anfallen als ein Lauf abarbeitet (Rest folgt im nächsten Lauf).
const PRIORITAET = Object.freeze({ eskalation: 1, erinnerung: 2, freigabe_erneuern: 3, freigabe_erinnerung: 4 });

function ms(t) {
	if (t === null || t === undefined || t === '') return NaN;
	const x = new Date(t).getTime();
	return Number.isFinite(x) ? x : NaN;
}

/**
 * Plant die Aufgaben eines Laufs.
 * @param {object} p
 * @param {object[]} p.vorgaenge  Zeilen aus epa_vorgaenge (Status "Warten auf Kunde")
 * @param {object[]} p.freigaben  Zeilen aus epa_freigaben (Status "offen")
 * @param {object} p.configs      kunde_id -> geprüfte Config; null = Kunde inaktiv; fehlt = Config ungültig
 * @param {string} p.jetzt        ISO-Zeitpunkt
 * @param {object} p.fristen      Modul src/fristen.js (im Code-Node eingebettet)
 * @returns {{ aufgaben: object[], uebersprungen: object[], verschoben: number }}
 */
function planen({ vorgaenge, freigaben, configs, jetzt, fristen, max = MAX_AUFGABEN }) {
	const jetztMs = ms(jetzt);
	if (!Number.isFinite(jetztMs)) throw new Error(`Ungültiger Zeitpunkt "${jetzt}"`);
	const aufgaben = [];
	const uebersprungen = [];
	const imDienst = {};
	const geschaeftszeit = (kunde, c) => {
		if (!(kunde in imDienst)) imDienst[kunde] = fristen.istGeschaeftszeit(jetzt, c);
		return imDienst[kunde];
	};

	for (const v of vorgaenge || []) {
		if (!v || v.status !== WARTEN) continue;
		const frist = ms(v.antwort_frist);
		if (!Number.isFinite(frist) || frist >= jetztMs) continue;
		const ref = { kunde_id: v.kunde_id, vorgangs_id: v.vorgangs_id };
		const c = configs[v.kunde_id];
		if (!c) {
			uebersprungen.push({ ...ref, grund: c === null ? 'kunde_inaktiv' : 'keine_gueltige_config' });
			continue;
		}
		if (!geschaeftszeit(v.kunde_id, c)) {
			uebersprungen.push({ ...ref, grund: 'ausserhalb_geschaeftszeit' });
			continue;
		}
		const gesendet = Number(v.erinnerungen_gesendet || 0);
		const erlaubt = Number(c.anzahl_erinnerungen || 0);
		aufgaben.push({
			aktion: gesendet < erlaubt ? 'erinnerung' : 'eskalation',
			...ref,
			freigabe_id: '',
			version: v.version ?? null,
			erinnerungen_gesendet: gesendet,
		});
	}

	for (const f of freigaben || []) {
		if (!f || f.status !== 'offen') continue;
		const ref = { kunde_id: f.kunde_id, vorgangs_id: f.vorgangs_id, freigabe_id: f.freigabe_id };
		const c = configs[f.kunde_id];
		if (!c) {
			uebersprungen.push({ ...ref, grund: c === null ? 'kunde_inaktiv' : 'keine_gueltige_config' });
			continue;
		}
		const abgelaufen = ms(f.ablauf) <= jetztMs;
		let erinnern = false;
		if (!abgelaufen && !f.erinnert_am && Number(c.freigabe_erinnerung_stunden) > 0) {
			const basis = f.erneuert_am || f.createdAt;
			if (Number.isFinite(ms(basis))) erinnern = ms(fristen.berechneFrist(new Date(basis).toISOString(), c.freigabe_erinnerung_stunden, c)) <= jetztMs;
		}
		if (!abgelaufen && !erinnern) continue;
		if (!geschaeftszeit(f.kunde_id, c)) {
			uebersprungen.push({ ...ref, grund: 'ausserhalb_geschaeftszeit' });
			continue;
		}
		aufgaben.push({ aktion: abgelaufen ? 'freigabe_erneuern' : 'freigabe_erinnerung', ...ref, version: null, erinnerungen_gesendet: null });
	}

	aufgaben.sort((a, b) => PRIORITAET[a.aktion] - PRIORITAET[b.aktion]);
	return { aufgaben: aufgaben.slice(0, max), uebersprungen, verschoben: Math.max(0, aufgaben.length - max) };
}

// ---------------------------------------------------------------- Lauf-Lock (Tabelle epa_system_status)

function lockHolen(laufId, jetztEcht) {
	const t = ms(jetztEcht);
	return {
		lock_bis: new Date(t + LOCK_MINUTEN * 60000).toISOString(),
		lock_durch: String(laufId),
		letzter_start: new Date(t).toISOString(),
	};
}

function lockFreigeben(jetztEcht, ergebnis) {
	return {
		lock_bis: EPOCHE,
		lock_durch: '',
		letzter_lauf: new Date(ms(jetztEcht)).toISOString(),
		letztes_ergebnis: JSON.stringify(ergebnis || {}),
	};
}

/** Zusammenfassung eines Laufs, nur Zähler und IDs (keine personenbezogenen Daten). */
function laufAuswerten(plan, ergebnisse) {
	const zaehler = {};
	const fehler = [];
	(plan.aufgaben || []).forEach((a, i) => {
		const r = (ergebnisse || [])[i] || {};
		const ergebnis = r.error ? 'fehler' : String(r.ergebnis || 'unbekannt');
		const k = `${a.aktion}:${ergebnis}`;
		zaehler[k] = (zaehler[k] || 0) + 1;
		if (r.error) fehler.push({ aktion: a.aktion, vorgangs_id: a.vorgangs_id, freigabe_id: a.freigabe_id || null });
	});
	return {
		aufgaben: (plan.aufgaben || []).length,
		ergebnisse: zaehler,
		fehler,
		uebersprungen: (plan.uebersprungen || []).length,
		verschoben: plan.verschoben || 0,
	};
}

// ---------------------------------------------------------------- Eskalation (Fall 2)

/**
 * Seit wann wartet der Vorgang? Erste versendete Rückfrage der aktuellen Runde, sonst die jüngste versendete
 * Nachricht. Liefert ganze Tage oder null, wenn kein Versand bekannt ist.
 */
function tageOhneReaktion(vorgang, gesendete, jetzt) {
	const liste = (gesendete || []).filter((f) => f && f.status === 'gesendet' && Number.isFinite(ms(f.gesendet_am)));
	const runde = Number(vorgang.rundenzaehler || 0);
	const dieseRunde = liste.filter((f) => f.art === 'rueckfrage' && Number(f.runde) === runde);
	let start = NaN;
	if (dieseRunde.length) start = Math.min(...dieseRunde.map((f) => ms(f.gesendet_am)));
	else if (liste.length) start = Math.max(...liste.map((f) => ms(f.gesendet_am)));
	if (!Number.isFinite(start)) return null;
	return Math.max(0, Math.floor((ms(jetzt) - start) / 86400000));
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function wertAus(daten, feld) {
	const d = daten && daten[feld];
	if (d === null || d === undefined) return '';
	return typeof d === 'object' ? String(d.wert ?? '') : String(d);
}

/** Teams-Nachricht an die Mitarbeiter (Masterprompt Fall 2) mit Kontaktdaten aus dem Vorgang. */
function meldungKeineReaktion({ vorgang, tage, erinnerungen, fehlende, daten, telefonFeld = 'Telefon' }) {
	const name = vorgang.absender_name ? `${vorgang.absender_name} ` : '';
	const seit = tage === null || tage === undefined ? 'seit längerer Zeit' : tage === 1 ? 'seit 1 Tag' : `seit ${tage} Tagen`;
	const tel = wertAus(daten, telefonFeld);
	const offen = (fehlende || []).map((f) => esc(f.anzeigename || f.feldname)).join(', ');
	return `<b>Kunde reagiert nicht – bitte telefonisch kontaktieren</b><br>Vorgang: <b>${esc(vorgang.vorgangs_id)}</b><br>` +
		`Kunde ${esc(name)}(${esc(vorgang.absender_adresse)}) reagiert ${esc(seit)} nicht auf Nachfragen (${Number(erinnerungen || 0)} Erinnerung(en) gesendet).<br>` +
		`Betreff: ${esc(vorgang.betreff)}${tel ? `<br>Telefon: ${esc(tel)}` : ''}${offen ? `<br>Noch offen: ${offen}` : ''}` +
		'<br>Es gehen keine automatischen Nachfragen mehr raus. Der Vorgang steht auf "Eskaliert / Manuell".';
}

// ---------------------------------------------------------------- Freigabe erinnern / erneuern

/**
 * Prüft, ob die Aufgabe für diese Freigabe noch gilt, und liefert die zu schreibenden Daten.
 * aktion: freigabe_erinnerung (neue Links zusätzlich, alte bleiben gültig)
 *         freigabe_erneuern   (neue Ablaufzeit, alle bisherigen Links werden ungültig)
 */
function freigabeAuffrischen({ aktion, freigabe, config, jetzt }) {
	if (!freigabe || freigabe.status !== 'offen') return { ok: false, grund: 'nicht_mehr_offen' };
	const t = ms(jetzt);
	const abgelaufen = ms(freigabe.ablauf) <= t;
	if (aktion === 'freigabe_erneuern') {
		if (!abgelaufen) return { ok: false, grund: 'nicht_abgelaufen' };
		const ablauf = new Date(t + Number(config.freigabe_ablauf_stunden) * 3600000).toISOString();
		return { ok: true, alteLinksSperren: true, ablauf, daten: { ablauf, erneuert_am: new Date(t).toISOString(), erinnert_am: null } };
	}
	if (aktion === 'freigabe_erinnerung') {
		if (abgelaufen) return { ok: false, grund: 'abgelaufen' };
		if (freigabe.erinnert_am) return { ok: false, grund: 'schon_erinnert' };
		return { ok: true, alteLinksSperren: false, ablauf: new Date(ms(freigabe.ablauf)).toISOString(), daten: { erinnert_am: new Date(t).toISOString() } };
	}
	return { ok: false, grund: 'unbekannte_aktion' };
}

module.exports = {
	LOCK_SCHLUESSEL, LOCK_MINUTEN, MAX_AUFGABEN, EPOCHE, PRIORITAET,
	planen, lockHolen, lockFreigeben, laufAuswerten, tageOhneReaktion, meldungKeineReaktion, freigabeAuffrischen,
};
