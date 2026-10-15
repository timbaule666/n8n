'use strict';
// Entscheidungen im Eingangs-Workflow EPA-01 (Masterprompt A2, A4, B3, B5) und Texte der Mitarbeiter-Meldungen.
// Rein deterministisch und ohne n8n-Abhängigkeiten, damit alles per Unit-Test prüfbar ist.

// Ergebnis-Codes von EPA-01, bei denen die Mail aus dem Posteingang in den Archivordner verschoben wird
// (nie gelöscht). Unklare Mails bleiben im Posteingang.
const ARCHIVIEREN_BEI = ['ignoriert', 'ignoriert_auto_antwort', 'ignoriert_gesperrt'];

function archivieren(ergebnis) {
	return ARCHIVIEREN_BEI.includes(ergebnis);
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

function kopf(titel, vorgangsId, mail) {
	const z = [`<b>${esc(titel)}</b>`];
	if (vorgangsId) z.push(`Vorgang: <b>${esc(vorgangsId)}</b>`);
	if (mail) {
		z.push(`Von: ${esc(mail.absender_name ? `${mail.absender_name} <${mail.absender_adresse}>` : mail.absender_adresse)}`);
		z.push(`Betreff: ${esc(mail.betreff || '(leer)')}`);
		if (mail.web_link) z.push(`<a href="${esc(mail.web_link)}">Mail in Outlook öffnen</a>`);
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

function feldTabelle(felder, daten) {
	const zeilen = (felder || []).map((f) => {
		const d = daten[f.feldname] || {};
		const wert = d.wert === null || d.wert === undefined ? '—' : d.wert;
		return `<tr><td>${esc(f.anzeigename)}${f.pflicht ? ' *' : ''}</td><td>${esc(wert)}</td></tr>`;
	}).join('');
	return `<table>${zeilen}</table>`;
}

function meldungGeprueft(vorgangsId, mail, felder, pruefung, extra = {}) {
	const titel = pruefung.vollstaendig ? 'Anfrage vollständig – bereit zur Bearbeitung' : 'Anfrage mit Lücken erkannt';
	let html = kopf(titel, vorgangsId, mail) + '<br>' + feldTabelle(felder, pruefung.daten);
	if (!pruefung.vollstaendig) {
		html += '<br>Fehlende oder ungültige Pflichtangaben:<ul>' + pruefung.fehlende.map((f) => `<li>${esc(f.anzeigename)}: ${esc(f.grund)}</li>`).join('') + '</ul>';
		const r = extra.rueckfrage;
		if (extra.ohneRueckfrageText) { /* Übersicht für die Freigabe-Nachricht: der Rückfrage-Teil folgt dort */ }
		else if (r && r.ergebnis === 'freigabe_angefordert') html += `Die Rückfrage liegt als Entwurf zur Freigabe bereit (persönlicher Link an ${r.zugestellt} Freigeber per Teams-Chat${r.fallback ? '; Standardvorlage verwendet' : ''}).`;
		else if (r && r.ergebnis === 'eskaliert_max_runden') html += 'Die maximale Anzahl Rückfragen ist erreicht: bitte manuell klären.';
		else html += '<b>Die Rückfrage konnte nicht automatisch vorbereitet werden – bitte manuell klären.</b> Details im Fehlerlog.';
	}
	const w = [];
	for (const h of pruefung.hinweise || []) w.push(`${h.anzeigename}: ${h.grund} (verworfen)`);
	for (const u of pruefung.unsicher || []) w.push(`${u.anzeigename}: KI unsicher (Konfidenz ${u.konfidenz}), bitte prüfen`);
	if (extra.verdacht_manipulation) w.push('Die Mail enthält möglicherweise Anweisungen an die KI (Manipulationsversuch).');
	return html + warnungen(mail, w);
}

function meldungExtraktionFehlgeschlagen(vorgangsId, mail, fehlercode) {
	return kopf('Datenextraktion fehlgeschlagen – bitte manuell bearbeiten', vorgangsId, mail) +
		`<br>Die KI hat zweimal keine gültige Antwort geliefert (${esc(fehlercode)}). Der Vorgang steht auf "Eskaliert / Manuell".` + warnungen(mail);
}

/** true, wenn die Rückfrage-Freigabe samt Übersicht mindestens einen Freigeber erreicht hat: dann keine zweite Meldung. */
function meldungInFreigabe(rueckfrage) {
	return Boolean(rueckfrage && rueckfrage.ergebnis === 'freigabe_angefordert' && Number(rueckfrage.zugestellt) > 0);
}

module.exports = {
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
