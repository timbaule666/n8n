'use strict';
// "Erledigt"-Knopf auf den Karten im Kanal "1 Vollständige Anfragen": Ein Mitarbeiter meldet, dass der Auftrag
// bearbeitet ist. Dann wird der Vorgang "Abgeschlossen", die Karte verschwindet aus dem Kanal und die Abschlusskarte
// kommt in "6 Logs" (SW Status setzen -> SW Log-Karte).
// Ablauf: SW Benachrichtigen hängt bei den Anlässen unten einen Link mit Einmal-Token an die Meldung (nur der Hash wird
// gespeichert, Tabelle epa_erledigt_links) und merkt sich die Teams-Nachricht. EPA-16 zeigt beim Öffnen eine
// Bestätigungsseite (GET ändert nichts, damit Link-Vorschauen nichts auslösen) und schließt erst beim Klick ab (POST).
// Keine Abhängigkeit zu anderen Modulen: Seitengerüst (seite) und HTML-Escaping kommen als Parameter bzw. lokal.

/** Meldungen im Kanal "Vollständige Anfragen", die den Knopf bekommen. */
const ANLAESSE = Object.freeze(['bereit', 'antwort_bereit']);
/** So lange gilt der Link (der Löschjob entfernt "Bereit zur Bearbeitung" ohnehin nach 30 Tagen). */
const GUELTIG_TAGE = 30;
const BEREIT = 'Bereit zur Bearbeitung';
const PFAD = 'epa-erledigt';
const KNOPF = '✅ Erledigt – Karte entfernen';

function esc(s) {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function mitKnopf(anlass, vorgangsId) {
	return ANLAESSE.includes(String(anlass || '')) && /^V-\d{4}-\d{4,}$/.test(String(vorgangsId || ''));
}

function link(basis, token) {
	return `${String(basis).replace(/\/+$/, '')}/webhook/${PFAD}?t=${encodeURIComponent(token)}`;
}

/** Hängt den Knopf an die Meldung an. Links im HTML werden in der Karte zu Knöpfen (postfach-kanalmeldung). */
function htmlMitKnopf(html, url) {
	return `${String(html || '')}<br><br><a href="${esc(url)}">${esc(KNOPF)}</a>`;
}

/** Zeile für epa_erledigt_links (ohne Token, nur Hash). teams: { team_id, channel_id, nachricht_id } */
function linkZeile({ kunde_id, vorgangs_id, hash, jetzt, teams }) {
	const t = new Date(jetzt).getTime();
	return {
		kunde_id,
		vorgangs_id,
		token_hash: hash,
		ablauf: new Date(t + GUELTIG_TAGE * 86400000).toISOString(),
		verbraucht_am: null,
		teams_nachricht: teams && teams.nachricht_id ? JSON.stringify({ team_id: teams.team_id, channel_id: teams.channel_id, id: String(teams.nachricht_id) }) : '',
	};
}

/** Freigeber und Vertreter aus der Config (Text oder Liste) als Auswahl für "Wer hat es erledigt?". */
function personen(config) {
	const liste = (w) => { if (Array.isArray(w)) return w; try { const x = JSON.parse(w || '[]'); return Array.isArray(x) ? x : []; } catch (e) { return []; } };
	return [...new Set([...liste(config && config.freigeber), ...liste(config && config.vertreter)].map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
}

/**
 * Prüft Link und Vorgang vor Anzeige bzw. Abschluss.
 * @returns {{ ok: true } | { ok: false, status: number, meldung: string }}
 */
function linkPruefen(zeile, vorgang, jetzt) {
	const nein = (status, meldung) => ({ ok: false, status, meldung });
	if (!zeile || zeile.id === undefined) return nein(404, 'Dieser Link ist ungültig.');
	if (zeile.verbraucht_am) return nein(409, 'Dieser Vorgang wurde bereits als erledigt gemeldet.');
	if (!(new Date(zeile.ablauf).getTime() > new Date(jetzt).getTime())) return nein(410, 'Dieser Link ist abgelaufen. Bitte den Vorgang direkt bearbeiten.');
	if (!vorgang || vorgang.id === undefined) return nein(404, 'Der Vorgang existiert nicht mehr.');
	if (vorgang.status === 'Abgeschlossen') return nein(409, 'Dieser Vorgang ist bereits abgeschlossen.');
	if (vorgang.status !== BEREIT) return nein(409, `Der Vorgang hat inzwischen den Status „${vorgang.status}“ (z. B. weil eine neue Mail des Kunden kam) und kann hier nicht abgeschlossen werden.`);
	return { ok: true };
}

/** Wer hat es erledigt? Muss in der Auswahl stehen (Protokoll). */
function werPruefen(wer, auswahl) {
	const w = String(wer || '').trim().toLowerCase();
	if (!w) return { ok: false, meldung: 'Bitte wählen Sie Ihren Namen aus.' };
	if (!(auswahl || []).includes(w)) return { ok: false, meldung: 'Dieser Name ist für diesen Kunden nicht eingetragen.' };
	return { ok: true, wer: w };
}

function seiteFormular(seite, { token, vorgang, auswahl }) {
	const knopfAus = "var f=this;setTimeout(function(){var b=f.querySelectorAll('button');for(var i=0;i<b.length;i++)b[i].disabled=true},0)";
	return seite(`Erledigt ${vorgang.vorgangs_id}`, `
<div class="karte"><h1>Auftrag erledigt? – ${esc(vorgang.vorgangs_id)}</h1>
<dl><dt>Betreff</dt><dd>${esc(vorgang.betreff || '')}</dd><dt>Absender</dt><dd>${esc(vorgang.absender_name || vorgang.absender_adresse || '')}</dd></dl>
<p>Der Vorgang wird abgeschlossen. Die Karte verschwindet aus „Vollständige Anfragen“ und steht danach in „Logs“. Der Kunde bekommt keine Nachricht.</p></div>
<form class="karte" method="post" onsubmit="${knopfAus}">
<input type="hidden" name="t" value="${esc(token)}">
<label for="wer"><b>Wer hat den Auftrag bearbeitet?</b></label><select id="wer" name="wer" required><option value="">Bitte Namen wählen …</option>${(auswahl || []).map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}</select>
<p class="hinweis">Ihr Name wird im Protokoll gespeichert.</p>
<div class="knoepfe"><button class="senden" name="aktion" value="erledigt">Als erledigt abschließen</button></div>
<p class="hinweis">Der Link ist nur einmal verwendbar.</p></form>`);
}

module.exports = { ANLAESSE, GUELTIG_TAGE, PFAD, KNOPF, mitKnopf, link, htmlMitKnopf, linkZeile, personen, linkPruefen, werPruefen, seiteFormular };
