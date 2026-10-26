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
// Versand nach Freigabe fehlgeschlagen (Freigabe-Status "fehler"): Erneut zur Freigabe frühestens nach dieser
// Wartezeit und nur, solange der Fehler nicht älter ist als das Höchstalter (alte Fehler nicht wiederbeleben).
const NACH_FEHLER_WARTEN_MINUTEN = 15;
const NACH_FEHLER_HOECHSTALTER_STUNDEN = 72;
// Nur in diesen Vorgangsstatus ist die fehlgeschlagene Nachricht noch aktuell.
const NACH_FEHLER_STATUS = Object.freeze(['Eskaliert / Manuell', 'Freigabe ausstehend']);
// Nachricht kam beim Kunden nicht an (Freigabe-Status "unzustellbar", src/unzustellbar.js): Erneut zur Freigabe,
// sobald der Zustelltest (EPA-11) des Kunden nach der Unzustellbarkeitsmeldung erfolgreich war. Nach dieser Zeit
// lohnt der neue Versuch nicht mehr (Vorgang bleibt "Eskaliert / Manuell").
const NACH_UNZUSTELLBAR_HOECHSTALTER_TAGE = 7;
const ZUSTELLTEST_PRAEFIX = 'zustelltest:';
// Offene Freigaben: Wurde der Entwurf inzwischen direkt in Outlook gesendet (an der Freigabe vorbei)? Geprüft wird
// jede offene Freigabe ab diesem Alter in jedem Lauf, unabhängig von Geschäftszeiten (es geht nichts an Kunden).
const VERSAND_PRUEFEN_AB_MINUTEN = 5;
const MAX_PRUEFUNGEN = 50;
// Freigabe liegt zu lange (gleiche Grenze wie der Watchdog-Befund FREIGABE_OFFEN): Der Freigeber bekommt einen
// frischen Link mit deutlichem Hinweis, alte Links werden gesperrt. Danach höchstens alle 24 h erneut.
const FREIGABE_ESKALATION_STUNDEN = 72;
const FREIGABE_ESKALATION_WIEDERHOLEN_STUNDEN = 24;

// Reihenfolge, falls mehr Aufgaben anfallen als ein Lauf abarbeitet (Rest folgt im nächsten Lauf).
const PRIORITAET = Object.freeze({ eskalation: 1, erinnerung: 2, freigabe_nach_fehler: 3, freigabe_nach_unzustellbar: 3, freigabe_erneuern: 3, freigabe_eskalation: 3, freigabe_erinnerung: 4 });

function ms(t) {
	if (t === null || t === undefined || t === '') return NaN;
	const x = new Date(t).getTime();
	return Number.isFinite(x) ? x : NaN;
}

/**
 * Plant die Aufgaben eines Laufs.
 * @param {object} p
 * @param {object[]} p.vorgaenge  Zeilen aus epa_vorgaenge (Status "Warten auf Kunde")
 * @param {object[]} p.freigaben  Zeilen aus epa_freigaben (Status "offen", "fehler" oder "unzustellbar")
 * @param {object} p.configs      kunde_id -> geprüfte Config; null = Kunde inaktiv; fehlt = Config ungültig
 * @param {string} p.jetzt        ISO-Zeitpunkt
 * @param {object} p.fristen      Modul src/fristen.js (im Code-Node eingebettet)
 * @param {object} [p.zustelltests] kunde_id -> { ok, am } (letzter Zustelltest, siehe zustelltestsAus)
 * @returns {{ aufgaben: object[], pruefungen: object[], uebersprungen: object[], verschoben: number }}
 *   pruefungen: Versandprüfungen offener Freigaben (aktion versand_pruefen); EPA-04 führt sie vor den Aufgaben aus.
 */
function planen({ vorgaenge, freigaben, configs, jetzt, fristen, zustelltests = {}, max = MAX_AUFGABEN }) {
	const jetztMs = ms(jetzt);
	if (!Number.isFinite(jetztMs)) throw new Error(`Ungültiger Zeitpunkt "${jetzt}"`);
	const aufgaben = [];
	const pruefungen = [];
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
		if (!f || !['offen', 'fehler', 'unzustellbar'].includes(f.status)) continue;
		const ref = { kunde_id: f.kunde_id, vorgangs_id: f.vorgangs_id, freigabe_id: f.freigabe_id };
		if (f.status === 'unzustellbar') {
			// Erst wenn ein Zustelltest NACH der Unzustellbarkeitsmeldung angekommen ist, geht der Versand wieder.
			const seit = ms(f.updatedAt);
			if (!Number.isFinite(seit) || jetztMs - seit > NACH_UNZUSTELLBAR_HOECHSTALTER_TAGE * 86400000) continue;
			const cu = configs[f.kunde_id];
			if (!cu) {
				uebersprungen.push({ ...ref, grund: cu === null ? 'kunde_inaktiv' : 'keine_gueltige_config' });
				continue;
			}
			const zt = zustelltests[f.kunde_id];
			if (!zt || zt.ok !== true || !(ms(zt.am) > seit)) {
				uebersprungen.push({ ...ref, grund: 'zustellung_noch_gestoert' });
				continue;
			}
			aufgaben.push({ aktion: 'freigabe_nach_unzustellbar', ...ref, version: null, erinnerungen_gesendet: null });
			continue;
		}
		if (f.status === 'fehler') {
			// Versand fehlgeschlagen: nach kurzer Wartezeit erneut zur Freigabe (SW Nachfassen prüft vorher das Postfach).
			const seit = jetztMs - ms(f.updatedAt);
			if (!Number.isFinite(seit) || seit < NACH_FEHLER_WARTEN_MINUTEN * 60000 || seit > NACH_FEHLER_HOECHSTALTER_STUNDEN * 3600000) continue;
			const cf = configs[f.kunde_id];
			if (!cf) {
				uebersprungen.push({ ...ref, grund: cf === null ? 'kunde_inaktiv' : 'keine_gueltige_config' });
				continue;
			}
			aufgaben.push({ aktion: 'freigabe_nach_fehler', ...ref, version: null, erinnerungen_gesendet: null });
			continue;
		}
		const c = configs[f.kunde_id];
		if (!c) {
			uebersprungen.push({ ...ref, grund: c === null ? 'kunde_inaktiv' : 'keine_gueltige_config' });
			continue;
		}
		if (f.entwurf_id && jetztMs - ms(f.createdAt) >= VERSAND_PRUEFEN_AB_MINUTEN * 60000) {
			pruefungen.push({ aktion: 'versand_pruefen', ...ref, version: null, erinnerungen_gesendet: null });
		}
		const abgelaufen = ms(f.ablauf) <= jetztMs;
		if (eskalationFaellig(f, jetztMs)) {
			if (!geschaeftszeit(f.kunde_id, c)) uebersprungen.push({ ...ref, grund: 'ausserhalb_geschaeftszeit' });
			else aufgaben.push({ aktion: 'freigabe_eskalation', ...ref, version: null, erinnerungen_gesendet: null });
			continue;
		}
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
	return {
		aufgaben: aufgaben.slice(0, max),
		pruefungen: pruefungen.slice(0, MAX_PRUEFUNGEN),
		uebersprungen,
		verschoben: Math.max(0, aufgaben.length - max) + Math.max(0, pruefungen.length - MAX_PRUEFUNGEN),
	};
}

/** Wartet die Freigabe seit FREIGABE_ESKALATION_STUNDEN (ab Anlage) und wurde in den letzten 24 h nicht eskaliert? */
function eskalationFaellig(f, jetztMs) {
	const seit = ms(f.createdAt);
	if (!Number.isFinite(seit) || jetztMs - seit < FREIGABE_ESKALATION_STUNDEN * 3600000) return false;
	const zuletzt = ms(f.eskaliert_am);
	return !Number.isFinite(zuletzt) || jetztMs - zuletzt >= FREIGABE_ESKALATION_WIEDERHOLEN_STUNDEN * 3600000;
}

/** Ganze Stunden, die eine Freigabe schon wartet (für den Hinweis in der Nachricht). */
function wartetStunden(f, jetzt) {
	const seit = ms(f && f.createdAt);
	return Number.isFinite(seit) ? Math.max(0, Math.floor((ms(jetzt) - seit) / 3600000)) : null;
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

/** Alle auszuführenden Aufrufe eines Laufs in fester Reihenfolge: erst Versandprüfungen, dann Aufgaben. */
function ausfuehrungen(plan) {
	return [...((plan && plan.pruefungen) || []), ...((plan && plan.aufgaben) || [])];
}

/** Zusammenfassung eines Laufs, nur Zähler und IDs (keine personenbezogenen Daten). ergebnisse wie ausfuehrungen(plan). */
function laufAuswerten(plan, ergebnisse) {
	const zaehler = {};
	const fehler = [];
	ausfuehrungen(plan).forEach((a, i) => {
		const r = (ergebnisse || [])[i] || {};
		const ergebnis = r.error ? 'fehler' : String(r.ergebnis || 'unbekannt');
		const k = `${a.aktion}:${ergebnis}`;
		zaehler[k] = (zaehler[k] || 0) + 1;
		if (r.error) fehler.push({ aktion: a.aktion, vorgangs_id: a.vorgangs_id, freigabe_id: a.freigabe_id || null });
	});
	return {
		aufgaben: (plan.aufgaben || []).length,
		pruefungen: (plan.pruefungen || []).length,
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
function freigabeAuffrischen({ aktion, freigabe, config, jetzt, vorgang }) {
	const t = ms(jetzt);
	if (aktion === 'freigabe_nach_fehler') {
		// Versand nach Freigabe fehlgeschlagen: wieder öffnen, neue Ablaufzeit, alle alten Links gesperrt.
		if (!freigabe || freigabe.status !== 'fehler') return { ok: false, grund: 'kein_versandfehler' };
		if (vorgang && !NACH_FEHLER_STATUS.includes(vorgang.status)) return { ok: false, grund: 'status_geaendert' };
		if (vorgang && vorgang.freigabe_id_aktuell && vorgang.freigabe_id_aktuell !== freigabe.freigabe_id) return { ok: false, grund: 'veraltet' };
		const ablauf = new Date(t + Number(config.freigabe_ablauf_stunden) * 3600000).toISOString();
		return {
			ok: true, alteLinksSperren: true, ablauf,
			daten: { status: 'offen', ablauf, erneuert_am: new Date(t).toISOString(), erinnert_am: null, entscheider: null, entscheidung: null, bearbeitet: false, grund: null },
		};
	}
	if (!freigabe || freigabe.status !== 'offen') return { ok: false, grund: 'nicht_mehr_offen' };
	const abgelaufen = ms(freigabe.ablauf) <= t;
	if (aktion === 'freigabe_eskalation') {
		// Liegt zu lange: frischer Link mit voller Laufzeit, alte Links gesperrt.
		if (!eskalationFaellig(freigabe, t)) return { ok: false, grund: 'nicht_faellig' };
		const ablauf = new Date(t + Number(config.freigabe_ablauf_stunden) * 3600000).toISOString();
		const jetztIso = new Date(t).toISOString();
		return { ok: true, alteLinksSperren: true, ablauf, daten: { ablauf, erneuert_am: jetztIso, erinnert_am: null, eskaliert_am: jetztIso } };
	}
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

// ---------------------------------------------------------------- Nach Unzustellbarkeit erneut zur Freigabe

/** Letzte Zustelltests je Kunde aus epa_system_status (Zeilen "zustelltest:<kunde_id>", geschrieben von EPA-11). */
function zustelltestsAus(zeilen) {
	const r = {};
	for (const z of zeilen || []) {
		if (!z || typeof z.schluessel !== 'string' || !z.schluessel.startsWith(ZUSTELLTEST_PRAEFIX)) continue;
		let e = {};
		try { e = JSON.parse(z.letztes_ergebnis || '{}') || {}; } catch (err) { e = {}; }
		r[z.schluessel.slice(ZUSTELLTEST_PRAEFIX.length)] = { ok: e.ok === true, am: z.letzter_lauf || null };
	}
	return r;
}

/**
 * Darf die nicht zugestellte Nachricht jetzt erneut zur Freigabe? Nur solange niemand den Vorgang weitergeführt hat.
 * verwerfen: true = nie mehr automatisch (Freigabe auf "nicht_zugestellt" setzen, damit EPA-04 sie nicht weiter plant).
 */
function nachUnzustellbar({ freigabe, vorgang }) {
	if (!freigabe || freigabe.status !== 'unzustellbar') return { ok: false, grund: 'nicht_mehr_unzustellbar', verwerfen: false };
	if (!vorgang || vorgang.status !== 'Eskaliert / Manuell') return { ok: false, grund: 'status_geaendert', verwerfen: true };
	if (vorgang.freigabe_id_aktuell !== freigabe.freigabe_id) return { ok: false, grund: 'veraltet', verwerfen: true };
	return { ok: true };
}

// ---------------------------------------------------------------- Direkt in Outlook gesendet

/**
 * Ergebnis der Postfach-Aktion versand_pruefen auswerten: Liegt der Entwurf dieser Freigabe in "Gesendete Elemente",
 * hat ihn jemand direkt im Postfach gesendet. Dann wird die Freigabe wie nach einem Versand vermerkt.
 * @param {object} p
 * @param {object} p.freigabe  Zeile aus epa_freigaben
 * @param {object} p.pruefung  Antwort von EPA-00 { gesendet, internet_message_id, gesendet_am } bzw. { error }
 */
function manuellGesendet({ freigabe, pruefung }) {
	if (!freigabe || freigabe.status !== 'offen') return { ok: false, grund: 'nicht_mehr_offen' };
	const r = pruefung || {};
	if (r.error || r.ok === false) return { ok: false, grund: 'pruefung_fehlgeschlagen' };
	if (r.gesendet !== true) return { ok: false, grund: 'nicht_gesendet' };
	const am = Number.isFinite(ms(r.gesendet_am)) ? new Date(ms(r.gesendet_am)).toISOString() : null;
	return {
		ok: true,
		daten: {
			status: 'gesendet', gesendet_am: am || new Date().toISOString(), gesendet_message_id: r.internet_message_id || null,
			entscheider: 'Outlook (direkt gesendet)', entscheidung: 'manuell_gesendet', bearbeitet: false,
		},
	};
}

/** Meldung an den Kanal: Nachricht wurde an der Freigabe vorbei direkt im Postfach gesendet. */
function meldungManuellGesendet({ vorgang, freigabe, gesendetText, fristText }) {
	const was = freigabe && freigabe.art === 'erinnerung' ? 'Erinnerung' : 'Rückfrage';
	return `<b>📤 ${was} direkt in Outlook gesendet</b><br>Vorgang: <b>${esc(vorgang.vorgangs_id)}</b><br>` +
		`Betreff: ${esc(freigabe && freigabe.betreff)}<br>` +
		`Der Entwurf wurde nicht über den Freigabe-Link, sondern direkt im Postfach gesendet${gesendetText ? ` (${esc(gesendetText)})` : ''}. ` +
		`Der Vorgang wartet jetzt auf die Antwort des Kunden${fristText ? ` (Frist: ${esc(fristText)})` : ''}. Die Freigabe-Links gelten nicht mehr.` +
		'<br>Hinweis: Den tatsächlich gesendeten Text hat der Agent nicht geprüft.';
}

module.exports = {
	FREIGABE_ESKALATION_STUNDEN, FREIGABE_ESKALATION_WIEDERHOLEN_STUNDEN, eskalationFaellig, wartetStunden,
	VERSAND_PRUEFEN_AB_MINUTEN, MAX_PRUEFUNGEN, ausfuehrungen, manuellGesendet, meldungManuellGesendet,
	LOCK_SCHLUESSEL, LOCK_MINUTEN, MAX_AUFGABEN, EPOCHE, PRIORITAET, NACH_FEHLER_WARTEN_MINUTEN, NACH_UNZUSTELLBAR_HOECHSTALTER_TAGE, NACH_FEHLER_HOECHSTALTER_STUNDEN,
	planen, lockHolen, lockFreigeben, laufAuswerten, tageOhneReaktion, meldungKeineReaktion, freigabeAuffrischen,
	zustelltestsAus, nachUnzustellbar,
};
