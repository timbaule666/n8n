'use strict';
// Freigabe Variante B (Bauplan 6): einmaliges, ablaufendes Token je Freigeber. Gespeichert wird nur der
// SHA-256-Hash. Der Endpunkt EPA-07 zeigt ein Formular (Vorschau, Text bearbeitbar, Senden/Ablehnen) und
// verbraucht die Freigabe atomar (bedingtes Update auf status = 'offen').

const TOKEN_MUSTER = /^[A-Za-z0-9_-]{43}$/; // 32 Byte base64url
const AKTIONEN = ['senden', 'ablehnen'];

/** @param {object} c Node-Modul "crypto" (im Code-Node per require('crypto')) */
function tokenErzeugen(c) {
	const token = c.randomBytes(32).toString('base64url');
	return { token, hash: tokenHash(c, token) };
}

function tokenHash(c, token) {
	return c.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function freigabeIdErzeugen(c) {
	return 'F-' + c.randomUUID();
}

function istGueltigesToken(t) {
	return typeof t === 'string' && TOKEN_MUSTER.test(t);
}

/** Basis-URL der Instanz aus $execution.resumeUrl (…/webhook-waiting/<id>) bzw. einem Override. */
function basisUrl(resumeUrl, override) {
	if (override) return String(override).replace(/\/+$/, '');
	const m = String(resumeUrl || '').match(/^(https?:\/\/[^/]+(?:\/[^/]+)*?)\/webhook-waiting\//);
	if (!m) throw new Error('Basis-URL der Instanz nicht ermittelbar');
	return m[1];
}

function link(basis, token) {
	return `${basis}/webhook/epa-freigabe?t=${encodeURIComponent(token)}`;
}

/**
 * Prüft Token und Freigabe vor Anzeige bzw. Entscheidung.
 * @returns {{ ok: true } | { ok: false, status: number, code: string, meldung: string }}
 */
function freigabePruefen({ token, freigabe, freigeberErlaubt, jetzt }) {
	const nein = (status, code, meldung) => ({ ok: false, status, code, meldung });
	if (!token || token.id === undefined) return nein(404, 'NICHT_GEFUNDEN', 'Dieser Freigabe-Link ist ungültig.');
	if (!freigabe || freigabe.id === undefined) return nein(404, 'NICHT_GEFUNDEN', 'Die Freigabe existiert nicht mehr.');
	if (freigabe.status !== 'offen') {
		const wer = freigabe.entscheider ? ` von ${freigabe.entscheider}` : '';
		const was = { in_versand: 'wird gerade versendet', gesendet: 'wurde bereits freigegeben und gesendet', abgelehnt: 'wurde bereits abgelehnt', abgelaufen: 'ist abgelaufen', ersetzt: 'wurde durch eine neuere Freigabe ersetzt', fehler: 'ist beim Versand fehlgeschlagen' }[freigabe.status] || `hat den Status "${freigabe.status}"`;
		return nein(freigabe.status === 'abgelaufen' ? 410 : 409, freigabe.status === 'abgelaufen' ? 'FREIGABE_ABGELAUFEN' : 'DUPLIKAT', `Diese ${freigabe.art === 'erinnerung' ? 'Erinnerung' : 'Rückfrage'} ${was}${freigabe.status === 'gesendet' || freigabe.status === 'abgelehnt' ? wer : ''}.`);
	}
	if (token.verbraucht_am) return nein(409, 'DUPLIKAT', 'Dieser Link wurde bereits verwendet.');
	if (new Date(freigabe.ablauf).getTime() <= new Date(jetzt).getTime()) return nein(410, 'FREIGABE_ABGELAUFEN', 'Dieser Freigabe-Link ist abgelaufen. Ein neuer Link wird automatisch verschickt.');
	// Ab M5: Links haben eine eigene Ablaufzeit. Bei der Erneuerung einer abgelaufenen Freigabe werden alle alten Links gesperrt.
	if (token.ablauf && new Date(token.ablauf).getTime() <= new Date(jetzt).getTime()) return nein(410, 'FREIGABE_ABGELAUFEN', 'Dieser Freigabe-Link ist abgelaufen. Sie haben inzwischen einen neuen Link erhalten.');
	if (!freigeberErlaubt) return nein(403, 'KEINE_BERECHTIGUNG', 'Sie sind für diesen Kunden nicht (mehr) als Freigeber eingetragen.');
	return { ok: true };
}

/** Formulardaten aus EPA-07 (POST, application/x-www-form-urlencoded). */
function formularLesen(body) {
	const b = body && typeof body === 'object' ? body : {};
	const aktion = String(b.aktion || '');
	if (!AKTIONEN.includes(aktion)) return { ok: false, meldung: 'Unbekannte Aktion.' };
	if (!istGueltigesToken(b.t)) return { ok: false, meldung: 'Ungültiger Link.' };
	const grund = String(b.grund || '').trim().slice(0, 500);
	if (aktion === 'ablehnen' && !grund) return { ok: false, meldung: 'Bitte einen Grund für die Ablehnung angeben.' };
	return { ok: true, aktion, token: b.t, text: typeof b.text === 'string' ? b.text : '', grund };
}

function istBearbeitet(original, neu) {
	const n = (s) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\s+$/gm, '').trim();
	return n(original) !== n(neu);
}

// ---------------------------------------------------------------- HTML

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const STIL = `body{font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;margin:0;background:#f4f5f7;color:#1d2433}
main{max-width:760px;margin:0 auto;padding:16px}
.karte{background:#fff;border-radius:8px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:16px}
h1{font-size:1.3rem;margin:0 0 12px}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0}
dt{color:#5b6475}dd{margin:0;overflow-wrap:anywhere}textarea{width:100%;box-sizing:border-box;min-height:260px;font:inherit;padding:8px}
pre{white-space:pre-wrap;font:inherit;color:#5b6475;margin:8px 0 0}.knoepfe{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}
button{font:inherit;padding:10px 16px;border-radius:6px;border:0;cursor:pointer}.senden{background:#1f6f43;color:#fff}.ablehnen{background:#a3222b;color:#fff}
input[type=text]{width:100%;box-sizing:border-box;font:inherit;padding:8px}.hinweis{color:#5b6475;font-size:.9rem}
.ok{border-left:4px solid #1f6f43}.fehler{border-left:4px solid #a3222b}`;

function seite(titel, inhalt) {
	return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(titel)}</title><style>${STIL}</style></head><body><main>${inhalt}</main></body></html>`;
}

function seiteFormular({ token, freigabe, vorgang, fehlende, text, abschluss }) {
	const luecken = (fehlende || []).map((f) => `<li>${esc(f.anzeigename)}${f.grund ? ` <span class="hinweis">(${esc(f.grund)})</span>` : ''}</li>`).join('');
	const was = freigabe.art === 'erinnerung' ? 'Erinnerung' : 'Rückfrage';
	return seite(`${was} ${vorgang.vorgangs_id}`, `
<div class="karte"><h1>${was} freigeben – ${esc(vorgang.vorgangs_id)}</h1>
<dl><dt>An</dt><dd>${esc(freigabe.empfaenger)}</dd><dt>Betreff</dt><dd>${esc(freigabe.betreff)}</dd>
<dt>Runde</dt><dd>${esc(Number(vorgang.rundenzaehler || 0) + 1)}</dd><dt>Gültig bis</dt><dd>${esc(new Date(freigabe.ablauf).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }))}</dd></dl>
<p>Fehlende Angaben:</p><ul>${luecken}</ul>${freigabe.fallback ? '<p class="hinweis">Hinweis: Die KI-Formulierung hat die Prüfung nicht bestanden, es wird die Standardvorlage verwendet.</p>' : ''}</div>
<form class="karte" method="post" onsubmit="var f=this;setTimeout(function(){var b=f.querySelectorAll('button');for(var i=0;i<b.length;i++)b[i].disabled=true},0)">
<input type="hidden" name="t" value="${esc(token)}">
<label for="text"><b>Text der Mail</b> (bearbeitbar)</label>
<textarea id="text" name="text">${esc(text)}</textarea>
<pre>${esc(abschluss)}</pre>
<p class="hinweis">Signatur und KI-Hinweis werden immer automatisch angehängt.</p>
<label for="grund">Grund (nur bei Ablehnung)</label><input type="text" id="grund" name="grund" maxlength="500">
<div class="knoepfe"><button class="senden" name="aktion" value="senden">Freigeben und senden</button>
<button class="ablehnen" name="aktion" value="ablehnen">Ablehnen (manuell bearbeiten)</button></div>
<p class="hinweis">Der Link ist nur einmal verwendbar. Nichts wird ohne Ihren Klick versendet.</p></form>`);
}

function seiteMeldung(titel, text, art = 'ok') {
	return seite(titel, `<div class="karte ${art === 'ok' ? 'ok' : 'fehler'}"><h1>${esc(titel)}</h1><p>${esc(text)}</p></div>`);
}

/** Teams-Nachricht an den Freigeber (1:1-Chat). */
const ANLASS = Object.freeze({
	freigabe_erinnerung: 'Erinnerung: Diese Freigabe ist noch offen. Hier ist ein neuer persönlicher Link.',
	freigabe_erneuern: 'Der bisherige Link ist abgelaufen und gilt nicht mehr. Hier ist ein neuer persönlicher Link.',
});

function nachrichtFreigeber({ vorgang, freigabe, fehlende, link: url, ablaufText, art, anlass }) {
	const liste = (fehlende || []).map((f) => `<li>${esc(f.anzeigename)}</li>`).join('');
	const titel = art === 'erinnerung' ? 'Erinnerung an den Kunden freigeben' : 'Rückfrage an den Kunden freigeben';
	const hinweis = ANLASS[anlass] ? `<i>${esc(ANLASS[anlass])}</i><br>` : '';
	return `${hinweis}<b>${esc(titel)}: ${esc(vorgang.vorgangs_id)}</b><br>An: ${esc(freigabe.empfaenger)}<br>Betreff: ${esc(freigabe.betreff)}<br>Fehlende Angaben:<ul>${liste}</ul>` +
		`<a href="${esc(url)}">Entwurf ansehen, bearbeiten oder freigeben</a><br><i>Persönlicher Link, einmal verwendbar, gültig bis ${esc(ablaufText)}. Bitte nicht weiterleiten.</i>`;
}

module.exports = {
	TOKEN_MUSTER, AKTIONEN, tokenErzeugen, tokenHash, freigabeIdErzeugen, istGueltigesToken, basisUrl, link,
	freigabePruefen, formularLesen, istBearbeitet, esc, seite, seiteFormular, seiteMeldung, nachrichtFreigeber, ANLASS,
};
