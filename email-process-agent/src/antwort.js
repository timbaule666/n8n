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

/** true, wenn der Name zu einem der Absender gehört (gleich oder Teil davon, z. B. "Jan" bzw. "Jan Hoffmann"). */
function istAbsenderName(wert, namen) {
	const w = String(wert || '').toLowerCase().split(/\s+/).filter(Boolean);
	if (!w.length) return false;
	return (namen || []).some((n) => {
		const t = String(n || '').toLowerCase().split(/\s+/).filter(Boolean);
		return t.length > 0 && (w.every((x) => t.includes(x)) || t.every((x) => w.includes(x)));
	});
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
		// Zählt nur, was die Antwort Neues bringt: neue Werte, Widersprüche oder Versuche für offene Felder.
		// Eine bloße Wiederholung bekannter Werte (z. B. Name aus der Signatur) ist keine neue Angabe.

		if (!leer(vorher.wert)) {
			daten[f.feldname] = vorher;
			if (leer(neuWert)) {
				if (angegeben) hinweise.push({ feldname: f.feldname, anzeigename: f.anzeigename, grund: `neue Angabe ungültig (${ungueltig.get(f.feldname) || 'ungültig'}), bisheriger Wert bleibt` });
			} else if (gleich(vorher.wert, neuWert)) {
				bestaetigt.push(f.feldname);
			} else if (f.validierungsregel && f.validierungsregel.person === true && istAbsenderName(neuWert, optionen.absenderNamen)
				&& !istAbsenderName(vorher.wert, optionen.absenderNamen)) {
				// Der Antwortende unterschreibt mit seinem Namen (z. B. der Kollege, der die Anfrage weitergeleitet hat):
				// kein Wechsel des Ansprechpartners, kein Widerspruch. Der bisherige Wert bleibt.
			} else if (f.validierungsregel && f.validierungsregel.person === true && nameErgaenzt(vorher.wert, neuWert)) {
				// "Max" -> "Max Müller": Ergänzung, kein Widerspruch
				daten[f.feldname] = { wert: neuWert, roh, quelle: n.quelle || null, konfidenz: n.konfidenz ?? null, nachgefordert: true, runde: optionen.runde ?? null };
				uebernommen.push({ feldname: f.feldname, anzeigename: f.anzeigename, alt: vorher.wert, neu: neuWert, quelle: n.quelle || null });
				angaben += 1;
			} else {
				angaben += 1;
				konflikteNeu.push({ feldname: f.feldname, anzeigename: f.anzeigename, alt: vorher.wert, neu: neuWert, quelle: n.quelle || null, message_id: optionen.message_id || null, runde: optionen.runde ?? null });
			}
			continue;
		}
		if (!leer(neuWert)) {
			// nachgefordert: kam per Antwort auf eine Rückfrage (für die Abschluss-Meldung "bisher" vs. "nachgefordert")
			daten[f.feldname] = { wert: neuWert, roh, quelle: n.quelle || null, konfidenz: n.konfidenz ?? null, nachgefordert: true, runde: optionen.runde ?? null };
			uebernommen.push({ feldname: f.feldname, anzeigename: f.anzeigename, alt: null, neu: neuWert, quelle: n.quelle || null });
			angaben += 1;
			if (typeof n.konfidenz === 'number' && n.konfidenz < 0.5) unsicher.push({ feldname: f.feldname, anzeigename: f.anzeigename, konfidenz: n.konfidenz });
		} else {
			if (angegeben) angaben += 1; // ungültiger Versuch für ein offenes Feld
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

/** Datum/Uhrzeit für Meldungen ("15.10.2026, 20:48"); leer, wenn unbekannt. */
function zeitText(iso, zeitzone) {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	return d.toLocaleString('de-DE', { timeZone: zeitzone || 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Abschluss-Meldung, wenn eine Antwort die Anfrage vollständig macht: kompletter Verlauf zum Nachvollziehen.
 * Erste Anfrage (Datum + Link), diese Antwort (Datum + Link), bisherige Informationen und nachgeforderte Informationen.
 * @param {object} p.vorgang  Vorgang vor der Antwort (erste_mail_am, erste_mail_link, createdAt, rundenzaehler, absender_*)
 * @param {object[]} p.felder Felder des Vorgangstyps (Reihenfolge und Anzeigenamen)
 * @param {object} p.merge    Ergebnis von zusammenfuehren (daten mit Markierung nachgefordert)
 */
function meldungVollstaendig({ vorgangs_id: vid, mail, merge, vorgang, felder, zeitzone }) {
	const v = vorgang || {};
	const daten = (merge && merge.daten) || {};
	const jetzt = new Set((merge.uebernommen || []).map((u) => u.feldname));
	const wert = (f) => { const d = daten[f.feldname]; return d && d.wert !== null && d.wert !== undefined && d.wert !== '' ? d.wert : null; };
	const link = (url, text) => (url ? ` · <a href="${esc(url)}">${esc(text)}</a>` : '');
	const kunde = v.absender_name ? `${v.absender_name} (${v.absender_adresse || mail.absender_adresse})` : (v.absender_adresse || mail.absender_adresse);
	const z = [
		'<b>✅ Anfrage vollständig – bereit zur Bearbeitung</b>',
		`Vorgang: <b>${esc(vid)}</b>`,
		`Kunde: ${esc(kunde)}`,
		`Betreff: ${esc(v.betreff || mail.betreff)}`,
		'',
		`Erste Anfrage: ${esc(zeitText(v.erste_mail_am || v.createdAt, zeitzone) || 'unbekannt')}${link(v.erste_mail_link, 'Erste Mail öffnen')}`,
		`Antwort mit den fehlenden Angaben: ${esc(zeitText(mail.empfangen_am, zeitzone) || 'gerade eben')}${link(mail.web_link, 'Antwort öffnen')}`,
		`Rückfrage-Runden: ${esc(Number(v.rundenzaehler) || 1)}`,
	];
	const bisher = []; const nach = []; const offen = [];
	for (const f of felder || []) {
		const w = wert(f);
		if (w === null) { offen.push(f); continue; }
		const d = daten[f.feldname] || {};
		if (d.nachgefordert || jetzt.has(f.feldname)) nach.push(`<li>${esc(f.anzeigename)}: <b>${esc(w)}</b>${jetzt.has(f.feldname) ? ' (aus dieser Antwort)' : d.runde ? ` (Rückfrage-Runde ${esc(d.runde)})` : ''}</li>`);
		else bisher.push(`<li>${esc(f.anzeigename)}: ${esc(w)}</li>`);
	}
	z.push('', '<b>Bisherige Informationen</b> (aus der ersten Anfrage):' + (bisher.length ? `<ul>${bisher.join('')}</ul>` : ' keine'));
	z.push('<b>Nachgeforderte Informationen</b>:' + (nach.length ? `<ul>${nach.join('')}</ul>` : ' keine'));
	if (offen.length) z.push('Nicht angegeben (optional): ' + offen.map((f) => esc(f.anzeigename)).join(', '));
	if (merge.konflikte_neu && merge.konflikte_neu.length) {
		z.push('⚠️ <b>Widersprüche (nicht übernommen, bitte klären):</b><ul>' + merge.konflikte_neu.map((k) => `<li>${esc(k.anzeigename)}: bisher "${esc(k.alt)}", jetzt "${esc(k.neu)}"</li>`).join('') + '</ul>');
	}
	for (const h of merge.hinweise || []) z.push(`Hinweis ${esc(h.anzeigename)}: ${esc(h.grund)}`);
	for (const u of merge.unsicher || []) z.push(`⚠️ ${esc(u.anzeigename)}: KI unsicher (Konfidenz ${esc(u.konfidenz)}), bitte prüfen`);
	return z.join('<br>').replace(/(<br>){2,}/g, '<br><br>');
}

/** Hinweise aus festen Regeln (textHinweise.alle) als Zeilen; Stornierung ganz oben, gut sichtbar. */
function zusatz(hinweise, storno, besonderheiten) {
	let oben = storno ? `<b>⚠️ Mögliche Stornierung / Absage – bitte prüfen</b><br>Kunde schreibt: „${esc(storno)}“<br>Der Vorgang wurde nicht automatisch geändert.<br><br>` : '';
	// Zusatzinformation aus der Antwort (z. B. Gefahrgut, Hebebühne): oben, damit sie nicht übersehen wird
	if (besonderheiten) oben += `<b>⚠️ Wichtige Information vom Kunden</b><br>${esc(String(besonderheiten).slice(0, 400))}<br><br>`;
	const unten = (hinweise || []).map((h) => `<br>⚠️ ${esc(h)}`).join('');
	return { oben, unten };
}

function meldungAntwort({ vorgangs_id: vid, mail, merge, entscheidung, rueckfrage, alterStatus, fristNeu, ohneRueckfrageText, uebersicht, text_hinweise: textHinweise, storno, besonderheiten }) {
	const zu = zusatz(textHinweise, storno, besonderheiten);
	if (entscheidung.weg === 'bereit' && uebersicht) {
		let html = meldungVollstaendig({ vorgangs_id: vid, mail, merge, ...uebersicht });
		if (entscheidung.freigabe_ersetzen) html += '<br>Die noch offene Freigabe der vorherigen Rückfrage ist damit überholt und wurde deaktiviert.';
		return zu.oben + html + zu.unten;
	}
	const titel = {
		bereit: 'Antwort eingegangen – Anfrage jetzt vollständig',
		luecken: 'Antwort eingegangen – es fehlen noch Angaben',
		keine_daten: besonderheiten ? 'Antwort mit Zusatzinformation' : 'Antwort ohne neue Angaben',
		nur_melden: 'Neue Nachricht zu einem Vorgang in Bearbeitung',
	}[entscheidung.weg];
	const z = [`<b>${esc(titel)}</b>`, `Vorgang: <b>${esc(vid)}</b>`, `Von: ${esc(mail.absender_adresse)}`, `Betreff: ${esc(mail.betreff)}`];
	if (mail.web_link) z.push(`<a href="${esc(mail.web_link)}">Mail in Outlook öffnen</a>`);
	if (entscheidung.weg === 'nur_melden') {
		z.push(`Status "${esc(alterStatus)}": die Mail wurde dem Vorgang zugeordnet, aber nicht automatisch ausgewertet. Bitte manuell sichten.`);
		return zu.oben + z.join('<br>') + zu.unten;
	}
	if (merge.uebernommen.length) z.push('Übernommen:<ul>' + merge.uebernommen.map((u) => `<li>${esc(u.anzeigename)}: ${esc(u.neu)}</li>`).join('') + '</ul>');
	if (merge.konflikte_neu.length) {
		z.push('⚠️ <b>Widersprüche (nicht übernommen, bitte klären):</b><ul>' + merge.konflikte_neu.map((k) => `<li>${esc(k.anzeigename)}: bisher "${esc(k.alt)}", jetzt "${esc(k.neu)}"</li>`).join('') + '</ul>');
	}
	for (const h of merge.hinweise) z.push(`Hinweis ${esc(h.anzeigename)}: ${esc(h.grund)}`);
	for (const u of merge.unsicher) z.push(`⚠️ ${esc(u.anzeigename)}: KI unsicher (Konfidenz ${esc(u.konfidenz)}), bitte prüfen`);
	if (entscheidung.weg === 'keine_daten') {
		z.push((storno || besonderheiten ? 'Die Antwort enthält keine neuen Transportangaben. Der Vorgang bleibt unverändert.' : 'Die Antwort enthält keine verwertbaren Angaben (z. B. Vertröstung). Der Vorgang bleibt unverändert.') + (fristNeu ? ` Antwortfrist verlängert bis ${esc(fristNeu)}.` : ''));
	} else if (entscheidung.weg === 'luecken') {
		z.push('Weiter offen:<ul>' + merge.fehlende.map((f) => `<li>${esc(f.anzeigename)}: ${esc(f.grund)}</li>`).join('') + '</ul>');
		if (ohneRueckfrageText) { /* Übersicht für die Freigabe-Nachricht */ }
		else if (rueckfrage && rueckfrage.ergebnis === 'freigabe_angefordert') z.push(`Die nächste Rückfrage liegt zur Freigabe bereit (Link an ${esc(rueckfrage.zugestellt)} Freigeber).`);
		else if (rueckfrage && rueckfrage.ergebnis === 'eskaliert_max_runden') z.push('<b>Maximale Anzahl Rückfragen erreicht – bitte manuell klären.</b>');
		else z.push('<b>Die nächste Rückfrage konnte nicht automatisch vorbereitet werden – bitte manuell klären.</b>');
	}
	if (entscheidung.freigabe_ersetzen) z.push('Die noch offene Freigabe der vorherigen Rückfrage ist damit überholt und wurde deaktiviert.');
	return zu.oben + z.join('<br>') + zu.unten;
}

module.exports = { nameErgaenzt, AUTOMATISCH, wegBestimmen, gleich, zusammenfuehren, entscheiden, fristVerlaengern, extraktionsHinweise, meldungAntwort, meldungVollstaendig, zeitText, esc, istAbsenderName };
