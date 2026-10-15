'use strict';
// Phase D: Antwort des Kunden auf einen bestehenden Vorgang (Masterprompt Workflow 3, Bauplan 5.6).
// Reine Funktionen: Weg festlegen, Daten zusammenführen (Merge), Ergebnis entscheiden, Meldungstext.
//
// Merge-Regeln (Bauplan 5.6):
// | Vorhanden        | Neu                    | Ergebnis                                   |
// | leer/ungültig    | gültig                 | übernehmen, Audit MERGE                    |
// | leer/ungültig    | ungültig               | bleibt Lücke (Grund aktualisiert)          |
// | gültig           | gleich (normalisiert)  | keine Änderung (bestätigt)                 |
// | gültig           | abweichend und gültig  | NICHT übernehmen, Konflikt + Meldung       |
// | gültig           | ungültig oder leer     | keine Änderung                             |

const AUTOMATISCH = Object.freeze(['Warten auf Kunde', 'Freigabe ausstehend', 'Bereit zur Bearbeitung']);

/**
 * Wie wird eine Mail zu einem bestehenden Vorgang behandelt?
 * - verarbeiten: Daten auswerten (Warten auf Kunde, Freigabe ausstehend, Bereit zur Bearbeitung = Nachtrag)
 * - nur_melden: Mail anhängen und Mitarbeiter informieren (Vorgang wird gerade bzw. manuell bearbeitet)
 */
function wegBestimmen(status) {
	return AUTOMATISCH.includes(status) ? 'verarbeiten' : 'nur_melden';
}

function leer(w) {
	return w === null || w === undefined || (typeof w === 'string' && w.trim() === '');
}

function gleich(a, b) {
	if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
	return String(a).replace(/\s+/g, ' ').trim().toLowerCase() === String(b).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** true, wenn der neue Name den bisherigen um Vor- oder Nachnamen ergänzt ("Max" -> "Max Müller"). */
function nameErgaenzt(alt, neu) {
	const t = (x) => String(x || '').toLowerCase().split(/\s+/).filter(Boolean);
	const a = t(alt);
	const n = t(neu);
	return a.length > 0 && n.length > a.length && a.every((w) => n.includes(w));
}

/**
 * Führt bekannte Daten und die geprüften neuen Angaben zusammen.
 * @param {object} alt extrahierte_daten des Vorgangs { Feld: { wert, roh, quelle, konfidenz } }
 * @param {object} neu Ergebnis von pflichtfelder.pruefen() für die neue Mail
 * @param {object[]} felder Feldliste aus der Config
 * @param {{ istPlatzhalter: function, konflikteBisher?: object[], message_id?: string, runde?: number }} optionen
 */
function zusammenfuehren(alt, neu, felder, optionen = {}) {
	const a = alt && typeof alt === 'object' ? alt : {};
	const nd = (neu && neu.daten) || {};
	const ungueltig = new Map([...(neu.fehlende || []), ...(neu.hinweise || [])].map((f) => [f.feldname, f.grund]));
	const daten = {};
	const uebernommen = [];
	const bestaetigt = [];
	const konflikteNeu = [];
	const hinweise = [];
	const unsicher = [];
	let angaben = 0;

	for (const f of felder || []) {
		const vorher = a[f.feldname] || {};
		const n = nd[f.feldname] || {};
		const neuWert = n.wert;
		const roh = n.roh;
		const angegeben = !leer(roh) && !(optionen.istPlatzhalter && optionen.istPlatzhalter(roh, f.platzhalter_muster));
		if (angegeben) angaben += 1;

		if (!leer(vorher.wert)) {
			daten[f.feldname] = vorher;
			if (leer(neuWert)) {
				if (angegeben) hinweise.push({ feldname: f.feldname, anzeigename: f.anzeigename, grund: `neue Angabe ungültig (${ungueltig.get(f.feldname) || 'ungültig'}), bisheriger Wert bleibt` });
			} else if (gleich(vorher.wert, neuWert)) {
				bestaetigt.push(f.feldname);
			} else if (f.validierungsregel && f.validierungsregel.person === true && nameErgaenzt(vorher.wert, neuWert)) {
				// "Max" -> "Max Müller": Ergänzung, kein Widerspruch
				daten[f.feldname] = { wert: neuWert, roh, quelle: n.quelle || null, konfidenz: n.konfidenz ?? null };
				uebernommen.push({ feldname: f.feldname, anzeigename: f.anzeigename, alt: vorher.wert, neu: neuWert, quelle: n.quelle || null });
			} else {
				konflikteNeu.push({ feldname: f.feldname, anzeigename: f.anzeigename, alt: vorher.wert, neu: neuWert, quelle: n.quelle || null, message_id: optionen.message_id || null, runde: optionen.runde ?? null });
			}
			continue;
		}
		if (!leer(neuWert)) {
			daten[f.feldname] = { wert: neuWert, roh, quelle: n.quelle || null, konfidenz: n.konfidenz ?? null };
			uebernommen.push({ feldname: f.feldname, anzeigename: f.anzeigename, alt: null, neu: neuWert, quelle: n.quelle || null });
			if (typeof n.konfidenz === 'number' && n.konfidenz < 0.5) unsicher.push({ feldname: f.feldname, anzeigename: f.anzeigename, konfidenz: n.konfidenz });
		} else {
			daten[f.feldname] = { wert: null, roh: angegeben ? roh : (vorher.roh ?? null), quelle: angegeben ? n.quelle || null : vorher.quelle || null, konfidenz: null };
		}
	}

	const fehlende = (felder || [])
		.filter((f) => f.pflicht && leer(daten[f.feldname].wert))
		.map((f) => ({ feldname: f.feldname, anzeigename: f.anzeigename, grund: ungueltig.get(f.feldname) && ungueltig.get(f.feldname) !== 'fehlt' ? ungueltig.get(f.feldname) : 'fehlt' }));

	// Offene Konflikte sammeln (gleicher Feldname + gleicher neuer Wert nur einmal)
	const bisher = Array.isArray(optionen.konflikteBisher) ? optionen.konflikteBisher : [];
	const schluessel = (k) => `${k.feldname}|${String(k.neu).toLowerCase()}`;
	const gesehen = new Set(bisher.map(schluessel));
	const konflikte = [...bisher, ...konflikteNeu.filter((k) => !gesehen.has(schluessel(k)))];

	return {
		daten,
		uebernommen,
		bestaetigt,
		konflikte_neu: konflikteNeu.filter((k) => !bisher.some((b) => schluessel(b) === schluessel(k))),
		konflikte,
		hinweise,
		unsicher,
		fehlende,
		vollstaendig: fehlende.length === 0,
		keine_daten: angaben === 0,
	};
}

/**
 * Nächster Schritt nach dem Merge.
 * keine_daten: Vorgang bleibt, wie er ist (Status, Freigabe); Frist ggf. verlängern; Mitarbeiter informieren.
 * sonst: Status -> In Prüfung -> Bereit zur Bearbeitung (vollständig) bzw. Lücken erkannt (neue Rückfrage über EPA-02).
 */
function entscheiden(merge, vorgang) {
	if (merge.keine_daten && merge.konflikte_neu.length === 0) {
		return { weg: 'keine_daten', zielstatus: null, freigabe_ersetzen: false };
	}
	return {
		weg: merge.vollstaendig ? 'bereit' : 'luecken',
		zielstatus: merge.vollstaendig ? 'Bereit zur Bearbeitung' : 'Lücken erkannt',
		freigabe_ersetzen: vorgang.status === 'Freigabe ausstehend' && Boolean(vorgang.freigabe_id_aktuell),
	};
}

/** Neue Antwortfrist bei Antworten ohne Daten: nie verkürzen. */
function fristVerlaengern(aktuelleFrist, neueFrist) {
	if (!neueFrist) return aktuelleFrist || null;
	if (!aktuelleFrist) return neueFrist;
	return new Date(neueFrist).getTime() > new Date(aktuelleFrist).getTime() ? neueFrist : aktuelleFrist;
}

/** Hinweise für die Extraktion einer Antwort: offene Felder und bekannte Feldnamen (keine Werte). */
function extraktionsHinweise(vorgang, felder) {
	const offen = (vorgang.fehlende_felder || []).map((f) => f.anzeigename || f.feldname);
	const bekannt = (felder || []).filter((f) => vorgang.extrahierte_daten && vorgang.extrahierte_daten[f.feldname] && !leer(vorgang.extrahierte_daten[f.feldname].wert)).map((f) => f.anzeigename);
	const h = ['Antwort des Kunden auf eine Rückfrage. Werte nur aus dem neuen Text übernehmen, nicht aus zitierten Vorverläufen.'];
	if (offen.length) h.push(`Noch offene Angaben: ${offen.join(', ')}`);
	if (bekannt.length) h.push(`Bereits bekannt (nur angeben, wenn der Kunde sie ausdrücklich nennt oder korrigiert): ${bekannt.join(', ')}`);
	return h;
}

// ---------------------------------------------------------------- Meldung an Mitarbeiter

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function meldungAntwort({ vorgangs_id: vid, mail, merge, entscheidung, rueckfrage, alterStatus, fristNeu, ohneRueckfrageText }) {
	const titel = {
		bereit: 'Antwort eingegangen – Anfrage jetzt vollständig',
		luecken: 'Antwort eingegangen – es fehlen noch Angaben',
		keine_daten: 'Antwort ohne neue Angaben',
		nur_melden: 'Neue Nachricht zu einem Vorgang in Bearbeitung',
	}[entscheidung.weg];
	const z = [`<b>${esc(titel)}</b>`, `Vorgang: <b>${esc(vid)}</b>`, `Von: ${esc(mail.absender_adresse)}`, `Betreff: ${esc(mail.betreff)}`];
	if (mail.web_link) z.push(`<a href="${esc(mail.web_link)}">Mail in Outlook öffnen</a>`);
	if (entscheidung.weg === 'nur_melden') {
		z.push(`Status "${esc(alterStatus)}": die Mail wurde dem Vorgang zugeordnet, aber nicht automatisch ausgewertet. Bitte manuell sichten.`);
		return z.join('<br>');
	}
	if (merge.uebernommen.length) z.push('Übernommen:<ul>' + merge.uebernommen.map((u) => `<li>${esc(u.anzeigename)}: ${esc(u.neu)}</li>`).join('') + '</ul>');
	if (merge.konflikte_neu.length) {
		z.push('⚠️ <b>Widersprüche (nicht übernommen, bitte klären):</b><ul>' + merge.konflikte_neu.map((k) => `<li>${esc(k.anzeigename)}: bisher "${esc(k.alt)}", jetzt "${esc(k.neu)}"</li>`).join('') + '</ul>');
	}
	for (const h of merge.hinweise) z.push(`Hinweis ${esc(h.anzeigename)}: ${esc(h.grund)}`);
	for (const u of merge.unsicher) z.push(`⚠️ ${esc(u.anzeigename)}: KI unsicher (Konfidenz ${esc(u.konfidenz)}), bitte prüfen`);
	if (entscheidung.weg === 'keine_daten') {
		z.push('Die Antwort enthält keine verwertbaren Angaben (z. B. Vertröstung). Der Vorgang bleibt unverändert.' + (fristNeu ? ` Antwortfrist verlängert bis ${esc(fristNeu)}.` : ''));
	} else if (entscheidung.weg === 'luecken') {
		z.push('Weiter offen:<ul>' + merge.fehlende.map((f) => `<li>${esc(f.anzeigename)}: ${esc(f.grund)}</li>`).join('') + '</ul>');
		if (ohneRueckfrageText) { /* Übersicht für die Freigabe-Nachricht */ }
		else if (rueckfrage && rueckfrage.ergebnis === 'freigabe_angefordert') z.push(`Die nächste Rückfrage liegt zur Freigabe bereit (Link an ${esc(rueckfrage.zugestellt)} Freigeber).`);
		else if (rueckfrage && rueckfrage.ergebnis === 'eskaliert_max_runden') z.push('<b>Maximale Anzahl Rückfragen erreicht – bitte manuell klären.</b>');
		else z.push('<b>Die nächste Rückfrage konnte nicht automatisch vorbereitet werden – bitte manuell klären.</b>');
	}
	if (entscheidung.freigabe_ersetzen) z.push('Die noch offene Freigabe der vorherigen Rückfrage ist damit überholt und wurde deaktiviert.');
	return z.join('<br>');
}

module.exports = { nameErgaenzt, AUTOMATISCH, wegBestimmen, gleich, zusammenfuehren, entscheiden, fristVerlaengern, extraktionsHinweise, meldungAntwort, esc };
