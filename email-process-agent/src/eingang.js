'use strict';
// Entscheidungen im Eingangs-Workflow EPA-01 (Masterprompt A2, A4, B3, B5) und Texte der Mitarbeiter-Meldungen.
// Rein deterministisch und ohne n8n-Abhängigkeiten, damit alles per Unit-Test prüfbar ist.

// Ergebnis-Codes von EPA-01, bei denen die Mail aus dem Posteingang in den Archivordner verschoben wird
// (nie gelöscht). Nur wenn die Config einen Archivordner nennt; Standard ist leer: Jede Mail bleibt im Posteingang.
// Unklare Mails bleiben immer im Posteingang.
const ARCHIVIEREN_BEI = ['ignoriert', 'ignoriert_auto_antwort', 'ignoriert_gesperrt'];

function archivieren(ergebnis, archivordner) {
	return typeof archivordner === 'string' && archivordner.trim() !== '' && ARCHIVIEREN_BEI.includes(ergebnis);
}

/**
 * A2 Dedupe: Jede Ausführung trägt die Mail zuerst ein ("Claim"). Gewinner ist der älteste Eintrag (kleinste
 * Zeilen-ID), dessen Verarbeitung nicht fehlgeschlagen ist. Alle anderen sind Duplikate.
 * @param {object[]} zeilen Einträge aus epa_verarbeitete_mails zu kunde_id + message_id
 * @param {number} eigeneId Zeilen-ID des eigenen Eintrags
 */
function dedupeEntscheiden(zeilen, eigeneId) {
	const gueltig = (zeilen || [])
		.filter((z) => z && z.id !== undefined && z.id !== null && (z.status !== 'fehler' || z.id === eigeneId))
		.sort((a, b) => Number(a.id) - Number(b.id));
	const erster = gueltig[0];
	if (!erster || erster.id === eigeneId) return { duplikat: false };
	return { duplikat: true, original_id: erster.id, original_status: erster.status || null, vorgangs_id: erster.vorgangs_id || null };
}

/** Technische Hinweise für die Klassifizierung (aus Headern, keine Mailinhalte). */
function klassifizierungsHinweise(mail) {
	const h = [];
	for (const n of mail.newsletter_hinweise || []) h.push(`Header-Indiz Newsletter/Massenmail: ${n}`);
	if (mail.ist_weiterleitung) h.push('Betreff kennzeichnet eine Weiterleitung');
	if (mail.ist_antwort) h.push('Mail ist eine Antwort, aber keinem offenen Vorgang zugeordnet');
	if (mail.text_leer) h.push('Mailtext ist leer');
	if (mail.text_gekuerzt) h.push('Mailtext wurde wegen Länge gekürzt');
	return h;
}

function extraktionsHinweise(mail) {
	const h = [];
	if (mail.ist_weiterleitung) h.push('Weitergeleitete Mail: die eigentliche Anfrage steht im weitergeleiteten Teil');
	for (const a of mail.anhaenge || []) if (a.status !== 'ok') h.push(`Anhang "${a.name}" nicht auswertbar (${a.hinweis || a.status})`);
	if (mail.text_gekuerzt) h.push('Mailtext wurde wegen Länge gekürzt');
	return h;
}

/**
 * A4: Klassifizierung auswerten.
 * @param {object} llm Ergebnis von "EPA SW LLM aufrufen": { ok, ergebnis } oder { ok: false, code, fehler }
 * @param {object} config Kunden-Config
 * @param {object} mail normalisierte Mail
 * @returns {{ weg: 'pruefen'|'ignoriert'|'unklar', status: string, ausloeser: string, vorgangstyp: string|null, grund: string, details: object }}
 */
function klasseAuswerten(llm, config, mail) {
	const typen = Object.keys(config.vorgangstypen || {});
	const schwelle = config.konfidenz_schwelle;
	const unklar = (grund, details = {}) => ({ weg: 'unklar', status: 'Klassifizierung unklar', ausloeser: 'KI', vorgangstyp: null, grund, details });
	if (!llm || llm.ok !== true) {
		return { ...unklar('Klassifizierung fehlgeschlagen (ungültige KI-Antwort)', { fehlercode: (llm && llm.code) || 'EXTRAKTION_UNGUELTIG' }), ausloeser: 'System' };
	}
	const e = llm.ergebnis;
	const details = { klasse: e.klasse, konfidenz: e.konfidenz, begruendung: e.begruendung_kurz, sprache: e.sprache, verdacht_manipulation: e.verdacht_manipulation === true };
	if (e.klasse === 'unklar') return unklar('KI ist unsicher, ob es eine Anfrage ist', details);
	if (e.konfidenz < schwelle) return unklar(`Konfidenz ${e.konfidenz} unter Schwelle ${schwelle}`, details);
	if (e.klasse === 'keine_anfrage') {
		// Absender auf der Allowlist werden nie automatisch aussortiert (Mitarbeiter entscheidet).
		if (mail.vertrauenswuerdig) return unklar('Absender auf der Allowlist, KI sieht keine Anfrage', details);
		return { weg: 'ignoriert', status: 'Ignoriert', ausloeser: 'KI', vorgangstyp: null, grund: 'keine Anfrage', details };
	}
	let typ = e.vorgangstyp;
	if (typen.length === 1) typ = typen[0];
	if (!typ || !typen.includes(typ)) return unklar('Vorgangstyp nicht bestimmbar', details);
	return { weg: 'pruefen', status: 'In Prüfung', ausloeser: 'KI', vorgangstyp: typ, grund: 'Anfrage erkannt', details };
}

// ---------------------------------------------------------------- Meldungen (Teams, HTML)

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const TRENNER = '————————————————————';
const STANDARD_ZONE = 'Europe/Berlin';

/** "am 27.10.2026 um 14:56 Uhr" in der Zeitzone des Kunden; leer, wenn kein gültiger Zeitpunkt. */
function erfasstText(iso, zone) {
	const t = new Date(iso || NaN);
	if (!Number.isFinite(t.getTime())) return '';
	try {
		const z = zone || STANDARD_ZONE;
		const datum = t.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: z });
		const uhr = t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: z });
		return `am ${datum} um ${uhr} Uhr`;
	} catch (e) {
		return '';
	}
}

/**
 * Kopf jeder Meldung: Titel, Vorgangsnummer, Absender, Betreff, Eingangszeit (+ Outlook-Kategorie) und Link.
 * opts: { zone, kategorie } – kategorie ist der Name der Outlook-Kategorie, die der Vorgang jetzt trägt.
 */
function kopf(titel, vorgangsId, mail, opts = {}) {
	const z = [`<b>${esc(titel)}</b>`, ''];
	if (vorgangsId) z.push(`Vorgangsnummer: <b>${esc(vorgangsId)}</b>`);
	if (mail) {
		z.push(`Absender der Anfrage: ${esc(mail.absender_name ? `${mail.absender_name} <${mail.absender_adresse}>` : mail.absender_adresse)}`);
		z.push(`<b>Betreff: ${esc(mail.betreff || '(leer)')}</b>`);
		const erfasst = erfasstText(mail.empfangen_am, opts.zone);
		const kat = opts.kategorie ? ` und ist mit „${esc(opts.kategorie)}“ gekennzeichnet` : '';
		const link = mail.web_link ? ` <a href="${esc(mail.web_link)}">In Outlook öffnen</a>` : '';
		if (erfasst || link) z.push(`${erfasst ? `E-Mail wurde ${esc(erfasst)} erfasst${kat}.` : ''}${link}`);
	}
	return z.join('<br>');
}

function warnungen(mail, extra = []) {
	const w = [...extra];
	if (mail && mail.spoofing && mail.spoofing.auffaellig) w.push(`Absender auffällig: ${mail.spoofing.hinweise.join(', ')}. Bitte Echtheit prüfen.`);
	for (const a of (mail && mail.anhaenge) || []) if (a.status !== 'ok') w.push(`Anhang "${a.name}": ${a.hinweis || a.status}`);
	return w.length ? '<br><br>⚠️ ' + w.map(esc).join('<br>⚠️ ') : '';
}

function meldungZugeordnet(vorgangsId, mail, alterStatus) {
	return kopf('Neue Nachricht zu einem bestehenden Vorgang', vorgangsId, mail) +
		`<br>Status: ${esc(alterStatus)}<br>Die Mail wurde dem Vorgang zugeordnet. Die automatische Auswertung von Antworten folgt mit Meilenstein M4; bitte bis dahin manuell sichten.` +
		warnungen(mail);
}

function meldungZuordnungUnklar(vorgangsId, mail, zuordnung) {
	const kand = (zuordnung.bewertung || []).map((b) => `<li>${esc(b.vorgangs_id)} (${esc(b.status)}): ${b.summe} Punkte – ${b.punkte.map((p) => esc(`${p.signal} ${p.punkte > 0 ? '+' : ''}${p.punkte}`)).join(', ')}</li>`).join('');
	return kopf('Zuordnung unklar – bitte entscheiden', vorgangsId, mail) +
		`<br>Grund: ${esc(zuordnung.grund)}<br>Kandidaten:<ul>${kand}</ul>Bitte die Mail einem Kandidaten zuordnen oder als neuen Vorgang bestätigen.` +
		warnungen(mail);
}

function meldungKlassifizierung(vorgangsId, mail, auswertung) {
	const d = auswertung.details || {};
	const extra = d.verdacht_manipulation ? ['Die Mail enthält möglicherweise Anweisungen an die KI (Manipulationsversuch).'] : [];
	return kopf('Klassifizierung unklar – bitte prüfen', vorgangsId, mail) +
		`<br>Grund: ${esc(auswertung.grund)}${d.begruendung ? `<br>Einschätzung der KI: ${esc(d.begruendung)}` : ''}<br>Die Mail wurde nicht gelöscht und liegt weiter im Posteingang.` +
		warnungen(mail, extra);
}

function wertText(f, d) {
	const w = d && d.wert;
	if (w === null || w === undefined || w === '') return '—';
	if (f.typ === 'datum' && /^\d{4}-\d{2}-\d{2}$/.test(String(w))) {
		const [j, m, t] = String(w).split('-');
		return `${t}.${m}.${j}`;
	}
	return String(w);
}

/**
 * Erfasste Daten in Blöcken: aufeinanderfolgende Felder mit derselben "gruppe" (Pflichtfeld-Config) stehen unter
 * einer fetten Überschrift, beschriftet mit "kurzname" (sonst Anzeigename). Aufeinanderfolgende Felder ohne Gruppe
 * bilden einen Block ohne Überschrift.
 */
function datenBlock(felder, daten) {
	const bloecke = [];
	for (const f of felder || []) {
		const gruppe = typeof f.gruppe === 'string' ? f.gruppe.trim() : '';
		const letzter = bloecke[bloecke.length - 1];
		if (letzter && letzter.gruppe === gruppe) letzter.felder.push(f);
		else bloecke.push({ gruppe, felder: [f] });
	}
	return bloecke.map((bl) => {
		const zeilen = bl.felder.map((f) => `${esc(bl.gruppe ? (f.kurzname || f.anzeigename) : f.anzeigename)}: ${esc(wertText(f, (daten || {})[f.feldname]))}`);
		return (bl.gruppe ? [`<b>${esc(bl.gruppe)}</b>`, ...zeilen] : zeilen).join('<br>');
	}).join('<br><br>');
}

/**
 * Eingangsmeldung nach der Prüfung (Teams/Telegram). extra: { zone, kategorie, besonderheiten, rueckfrage,
 * ohneRueckfrageText, manipulation_hinweis, text_hinweise }. besonderheiten ist eine kurze, von der KI
 * zusammengefasste Zusatzinformation aus der Mail (nur Anzeige, escaped).
 */
function meldungGeprueft(vorgangsId, mail, felder, pruefung, extra = {}) {
	const titel = pruefung.vollstaendig ? 'Vollständige Anfrage – bereit zur Bearbeitung' : 'Unvollständige Anfrage erkannt';
	const teile = [kopf(titel, vorgangsId, mail, { zone: extra.zone, kategorie: extra.kategorie }), TRENNER];
	teile.push('<b>ERFASSTE DATEN</b><br><br>' + datenBlock(felder, pruefung.daten));
	const bes = typeof extra.besonderheiten === 'string' ? extra.besonderheiten.trim() : '';
	if (bes) teile.push(`<b>Wichtige Information erkannt</b><br>${esc(bes.slice(0, 400))}`);
	const w = [];
	for (const h of pruefung.hinweise || []) w.push(`${h.anzeigename}: ${h.grund} (verworfen)`);
	for (const u of pruefung.unsicher || []) w.push(`${u.anzeigename}: KI unsicher (Konfidenz ${u.konfidenz}), bitte prüfen`);
	if (extra.manipulation_hinweis) w.push(MANIPULATION_HINWEIS);
	for (const t of extra.text_hinweise || []) w.push(t);
	const warn = warnungen(mail, w);
	if (warn) teile.push(`<b>Bitte beachten</b>${warn.replace(/^<br><br>/, '<br>')}`);
	teile.push(TRENNER);
	if (pruefung.vollstaendig) {
		teile.push('<b>Alle Pflichtangaben vorhanden</b><br>Der Vorgang ist bereit zur Bearbeitung.');
	} else {
		let t = '<b>Fehlende oder ungültige Pflichtangaben</b><br>' + pruefung.fehlende.map((f) => `• ${esc(f.anzeigename)}${f.grund && f.grund !== 'fehlt' ? ` – ${esc(f.grund)}` : ''}`).join('<br>');
		const r = extra.rueckfrage;
		if (extra.ohneRueckfrageText) { /* Übersicht für die Freigabe-Nachricht: der Rückfrage-Teil folgt dort */ }
		else if (r && r.ergebnis === 'freigabe_angefordert') t += `<br><br>Die Rückfrage liegt als Entwurf zur Freigabe bereit (persönlicher Link an ${r.zugestellt} Freigeber per Teams-Chat${r.fallback ? '; Standardvorlage verwendet' : ''}).`;
		else if (r && r.ergebnis === 'eskaliert_max_runden') t += '<br><br>Die maximale Anzahl Rückfragen ist erreicht: bitte manuell klären.';
		else t += '<br><br><b>Die Rückfrage konnte nicht automatisch vorbereitet werden – bitte manuell klären.</b> Details im Fehlerlog.';
		teile.push(t);
	}
	return teile.join('<br><br>');
}

function meldungExtraktionFehlgeschlagen(vorgangsId, mail, fehlercode) {
	return kopf('Datenextraktion fehlgeschlagen – bitte manuell bearbeiten', vorgangsId, mail) +
		`<br>Die KI hat zweimal keine gültige Antwort geliefert (${esc(fehlercode)}). Der Vorgang steht auf "Eskaliert / Manuell".` + warnungen(mail);
}

/** true, wenn die Rückfrage-Freigabe samt Übersicht mindestens einen Freigeber erreicht hat: dann keine zweite Meldung. */
function meldungInFreigabe(rueckfrage) {
	return Boolean(rueckfrage && rueckfrage.ergebnis === 'freigabe_angefordert' && Number(rueckfrage.zugestellt) > 0);
}

// ---------------------------------------------------------------- Keine Anfrage, aber bitte ansehen

const ANLASS_TITEL = {
	storno: 'Mögliche Stornierung / Absage',
	rueckruf: 'Rückrufbitte',
	status: 'Frage zu einem Vorgang',
	anhang: 'Inhalt nur im Anhang (nicht ausgewertet)',
};

function datumText(w) {
	const s = String(w);
	return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('.') : s;
}

/**
 * Offene Vorgänge des Absenders, die zur Mail passen: mindestens zwei erfasste Werte (Orte, Datum, PLZ …) stehen
 * im Mailtext. Der Name des Absenders zählt nicht (steht in jedem seiner Vorgänge). Höchstens drei.
 * @param {object[]} kandidaten aus kandidaten_suchen (mit werte: string[])
 */
function passendeVorgaenge(mail, kandidaten) {
	const text = String((mail && mail.text) || '').toLowerCase();
	const name = String((mail && mail.absender_name) || '').toLowerCase();
	const treffer = [];
	for (const k of kandidaten || []) {
		const werte = [...new Set((k.werte || []).map((w) => String(w).toLowerCase()))]
			.filter((w) => w.length >= 4 && w !== name && !name.includes(w));
		const n = werte.filter((w) => text.includes(w) || (/^\d{4}-\d{2}-\d{2}$/.test(w) && text.includes(datumText(w)))).length;
		if (n >= 2) treffer.push({ ...k, treffer: n });
	}
	return treffer.sort((a, b) => b.treffer - a.treffer).slice(0, 3);
}

/**
 * Meldung für eine Mail, die keine Anfrage ist, bei der aber jemand handeln muss. Am Vorgang wird nichts geändert.
 * @param {object} h { anlass, stelle, vorgangs_ids } aus textHinweise.handlungKeineAnfrage
 * @param {object[]} passend aus passendeVorgaenge
 */
function meldungKeineAnfrage(vorgangsId, mail, h, passend = [], opts = {}) {
	const z = [kopf('Keine Anfrage – bitte ansehen', vorgangsId, mail, { zone: opts.zone }), ''];
	z.push(`Grund: <b>${esc(ANLASS_TITEL[h.anlass] || h.anlass)}</b>`);
	if (h.stelle) z.push(`Kunde schreibt: „${esc(h.stelle)}“`);
	if ((h.vorgangs_ids || []).length) z.push(`Genannte Vorgangsnummer: ${h.vorgangs_ids.map(esc).join(', ')} – im System nicht gefunden.`);
	if (passend.length) {
		z.push('Möglicherweise betroffen:<ul>' + passend.map((p) => `<li>${esc(p.vorgangs_id)} (${esc(p.status)}): ${esc(p.betreff || '')}</li>`).join('') + '</ul>');
	} else if (h.anlass === 'storno') {
		z.push('Kein passender offener Vorgang gefunden – bitte selbst zuordnen.');
	}
	z.push('Die Mail wurde nicht automatisch bearbeitet und liegt weiter im Posteingang. An bestehenden Vorgängen wurde nichts geändert.');
	return z.join('<br>') + warnungen(mail);
}

// ---------------------------------------------------------------- Systemwarnung Prompt-Injection

// Typische Formulierungen von Anweisungen an eine KI. Breit gefasst: Ein Treffer allein sperrt nicht, er bestätigt
// nur den Verdacht der KI (manipulationBewerten) und zeigt die auffälligen Stellen in der Warnung.
const VERDAECHTIG = /(ignorier|vergiss|anweisung|instruction|ignore (all|previous)|system[- ]?(nachricht|hinweis|prompt|message|:)|admin[- ]?(modus|rechte|mode)|du bist (jetzt|ein)|you are now|\bki\b|\bai\b|ki[- ]?(assistent|agent)|prompt|klassifizier|ohne freigabe|leite .{0,40}weiter|lösche|setze .{0,40}(auf|als)|trage .{0,40}ein)/i;

// Eindeutige Angriffsmuster: Ein Treffer reicht für die Sperre, auch wenn die KI nichts meldet (Härtetest 2:
// Anweisung in der Signatur, "Freigabe bereits erteilt", gefälschtes JSON). Eng gefasst, damit normale Anfragen
// (z. B. "Freigabe der Ware ist erfolgt", KI-Hinweis in einer Signatur) nicht gesperrt werden.
const STARK = [
	/\bignor\w*\s+(\w+\s+){0,3}(anweisung|instruktion|instruction|regel|rule|prompt|vorgabe)/i,
	/\b(vergiss|forget|disregard)\s+(\w+\s+){0,3}(anweisung|instruction|regel|rule|vorgabe)/i,
	/\b(an|für)\s+(die|den|das)\s+(ki|ai)\b/i,
	/\b(to|for)\s+the\s+(ai|assistant|llm|language model)\b/i,
	/\bsystem[- ]?(override|prompt|anweisung|instruction)/i,
	/^\s*\[?\s*(system|developer|admin)\s*(nachricht|message)?\s*:/i,
	/\b(admin|developer|entwickler)[- ]?(modus|mode)\b|\bjailbreak\b/i,
	/\b(you are now|du bist (ab )?jetzt|ab (sofort|jetzt) bist du|lass uns ein spiel spielen|let'?s play a game)\b/i,
	/verdacht_manipulation|"(klasse|konfidenz|felder|begruendung_kurz|vorgangstyp)"\s*:/i,
	/\b(ohne|without)\s+(freigabe|prüfung|pruefung|(human\s+)?review|approval)\b/i,
	/\bfreigabe\b.{0,60}\b(bereits|schon)\b.{0,40}\b(erteilt|gegeben)\b/i,
	/\bfreigabe-id\b|\bmark\w*\s+(\w+\s+){0,3}as\s+approved\b|\bals\s+freigegeben\s+markier/i,
	/\b(direkt|sofort|umgehend)\s+(ab|ver)?senden\b|\bsend\s+(\w+\s+){0,3}immediately\b/i,
	/игнорир|инструкц|без проверки|(^|[^а-яё])ИИ([^а-яё]|$)/i,
	/\bignorez\b|\bignora\s+(todas|las|le|tutte)\b|\binstrucciones\b|\bistruzioni\b/i,
];

function istStark(zeile) {
	return STARK.some((r) => r.test(zeile));
}

/** Zeilen aus Betreff, Mailtext und Anhängen mit eindeutigem Angriffsmuster (gekürzt). */
function starkeStellen(mail) {
	const quellen = [{ wo: 'Betreff', text: (mail && mail.betreff) || '' }, { wo: 'Mailtext', text: (mail && mail.text) || '' }];
	for (const a of (mail && mail.anhaenge) || []) if (a && a.text) quellen.push({ wo: `Anhang "${a.name}"`, text: a.text });
	const out = [];
	for (const q of quellen) {
		for (const zeile of String(q.text).split(/\n+/)) {
			const z = zeile.trim();
			if (z && istStark(z)) out.push({ wo: q.wo, text: z.length > 200 ? z.slice(0, 200) + ' …' : z });
		}
	}
	return out;
}

const MANIPULATION_HINWEIS = 'Die KI vermutet Anweisungen an die KI, die feste Prüfung hat aber keine auffällige Stelle gefunden. Die Mail wurde normal bearbeitet – bitte kurz gegenlesen.';

/**
 * Manipulationsverdacht aus KI-Einschätzung und fester Musterprüfung (Härtetest 2: die KI allein lieferte
 * 6 Fehlalarme und übersah 3 Angriffe).
 * - eindeutiges Muster → sperren (auch ohne KI)
 * - KI-Verdacht und auffällige Stelle → sperren
 * - nur KI-Verdacht → hinweis (normale Bearbeitung, Hinweis in der Meldung)
 * @returns {{ stufe: 'sperren'|'hinweis'|'keine', ki: boolean, muster: boolean }}
 */
function manipulationBewerten(kiVerdacht, mail) {
	const ki = kiVerdacht === true;
	if (starkeStellen(mail).length) return { stufe: 'sperren', ki, muster: true };
	if (ki && verdaechtigeStellen(mail).length) return { stufe: 'sperren', ki, muster: true };
	if (ki) return { stufe: 'hinweis', ki, muster: false };
	return { stufe: 'keine', ki, muster: false };
}

/** Für die Systemwarnung: wodurch der Verdacht entstand. */
function manipulationQuellen(bewertung, kiStelle) {
	const q = [];
	if (bewertung && bewertung.ki) q.push(kiStelle || 'KI-Prüfung');
	if (bewertung && bewertung.muster) q.push('feste Musterprüfung');
	return q;
}

/** Bis zu max auffällige Stellen (Zeilen) aus Mailtext und Anhängen, gekürzt. */
// Je Quelle (Mailtext, jeder Anhang) bis zu max Stellen, damit ein Angriff im Anhang neben dem Mailtext sichtbar bleibt.
function verdaechtigeStellen(mail, max = 3, gesamt = 6) {
	const quellen = [{ wo: 'Mailtext', text: (mail && mail.text) || '' }];
	for (const a of (mail && mail.anhaenge) || []) if (a && a.text) quellen.push({ wo: `Anhang "${a.name}"`, text: a.text });
	const out = [];
	for (const q of quellen) {
		let n = 0;
		for (const zeile of String(q.text).split(/\n+/)) {
			const z = zeile.trim();
			if (!z || !(VERDAECHTIG.test(z) || istStark(z))) continue;
			out.push({ wo: q.wo, text: z.length > 200 ? z.slice(0, 200) + ' …' : z });
			if (out.length >= gesamt) return out;
			if (++n >= max) break;
		}
	}
	return out;
}

/**
 * Eigene Telegram/Teams-Meldung bei Verdacht auf Prompt-Injection (auch wenn die Mail keine Anfrage ist).
 * @param {object} p { vorgangs_id, mail, erkannt_bei: string[], begruendung, behandlung, eingang_text }
 */
function meldungManipulation({ vorgangs_id: vid, mail, erkannt_bei, begruendung, behandlung, eingang_text }) {
	const m = mail || {};
	const z = ['<b>⚠️ Systemwarnung: möglicher Prompt-Injection-Versuch</b>'];
	z.push(`Grund: Die Mail enthält Anweisungen an die KI (erkannt bei: ${esc((erkannt_bei || []).join(', ') || 'Prüfung')}).`);
	if (begruendung) z.push(`Einschätzung der KI: ${esc(begruendung)}`);
	const stellen = verdaechtigeStellen(m);
	if (stellen.length) z.push('Auffällige Stellen:<ul>' + stellen.map((s) => `<li>${esc(s.wo)}: „${esc(s.text)}“</li>`).join('') + '</ul>');
	z.push('');
	z.push('<b>Absender</b>');
	z.push(`Name: ${esc(m.absender_name || '–')}`);
	z.push(`Adresse: ${esc(m.absender_adresse || '–')}${m.absender_domain ? ` (Domain ${esc(m.absender_domain)})` : ''}`);
	if (m.antwort_an && String(m.antwort_an).toLowerCase() !== String(m.absender_adresse || '').toLowerCase()) z.push(`Antwort an: ${esc(m.antwort_an)} (abweichend vom Absender)`);
	if (m.spoofing && m.spoofing.auffaellig) z.push(`⚠️ Absender auffällig: ${esc((m.spoofing.hinweise || []).join(', '))}`);
	z.push(`Betreff: ${esc(m.betreff || '(leer)')}`);
	if (eingang_text) z.push(`Eingang: ${esc(eingang_text)}`);
	if (vid) z.push(`Vorgang: ${esc(vid)}`);
	if (m.web_link) z.push(`<a href="${esc(m.web_link)}">Mail in Outlook öffnen</a>`);
	z.push('');
	if (behandlung) z.push(`Behandlung: ${esc(behandlung)}`);
	z.push('<b>👉 Bitte die Mail prüfen und bei Bedarf selbst bearbeiten.</b>');
	z.push('Die KI hat keine Werkzeuge: Es wurde nichts ausgeführt, gesendet oder gelöscht. Kundenmails gehen nur nach Freigabe raus.');
	return z.join('<br>').replace(/(<br>){2,}/g, '<br><br>');
}

module.exports = {
	TRENNER,
	erfasstText,
	verdaechtigeStellen,
	starkeStellen,
	manipulationBewerten,
	manipulationQuellen,
	MANIPULATION_HINWEIS,
	meldungKeineAnfrage,
	passendeVorgaenge,
	meldungManipulation,
	meldungInFreigabe,
	ARCHIVIEREN_BEI,
	archivieren,
	dedupeEntscheiden,
	klassifizierungsHinweise,
	extraktionsHinweise,
	klasseAuswerten,
	esc,
	meldungZugeordnet,
	meldungZuordnungUnklar,
	meldungKlassifizierung,
	meldungGeprueft,
	meldungExtraktionFehlgeschlagen,
};
