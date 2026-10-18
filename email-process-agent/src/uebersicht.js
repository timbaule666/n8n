'use strict';
// Übersichtsseite je Kunde (EPA-12) und tägliche Zusammenfassung in Teams (EPA-13).
// Zugang über einen geheimen Link: 32 Byte Zufall, gespeichert wird nur der SHA-256-Hash (Tabelle
// epa_uebersicht_zugaenge). Der Kunde ergibt sich allein aus dem Zugang, nie aus der Adresse. Jede tägliche
// Zusammenfassung bringt einen neuen Link mit; jeder Link läuft nach LINK_TAGE ab.

const LINK_TAGE = 30;
const PFAD = 'epa-uebersicht';
const TOKEN_MUSTER = /^[A-Za-z0-9_-]{43}$/;
const MAX_LISTE_TEAMS = 5;

// Reihenfolge = Reihenfolge auf der Seite. Abgeschlossen und Ignoriert werden nicht gezeigt.
const GRUPPEN = Object.freeze([
	{ key: 'klaerung', titel: 'Klärung nötig', status: ['Eskaliert / Manuell', 'Zuordnung unklar', 'Klassifizierung unklar'], text: 'Hier muss ein Mitarbeiter entscheiden oder den Kunden anrufen.' },
	{ key: 'freigabe', titel: 'Wartet auf Freigabe', status: ['Freigabe ausstehend'], text: 'Eine Rückfrage oder Erinnerung liegt als Entwurf bereit und wartet auf den Klick eines Freigebers.' },
	{ key: 'bereit', titel: 'Bereit zur Bearbeitung', status: ['Bereit zur Bearbeitung'], text: 'Alle Pflichtangaben sind da.' },
	{ key: 'kunde', titel: 'Wartet auf Kunde', status: ['Warten auf Kunde'], text: 'Die Rückfrage ist gesendet, die Antwort des Kunden steht aus.' },
	{ key: 'system', titel: 'Wird gerade verarbeitet', status: ['Neu', 'In Prüfung', 'Lücken erkannt'], text: 'Der Agent ist gerade dabei.' },
]);

function tokenErzeugen(c) {
	const token = c.randomBytes(32).toString('base64url');
	return { token, hash: tokenHash(c, token) };
}

function tokenHash(c, token) {
	return c.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function istGueltigesToken(t) {
	return typeof t === 'string' && TOKEN_MUSTER.test(t);
}

function link(basis, token) {
	return `${String(basis).replace(/\/+$/, '')}/webhook/${PFAD}?k=${encodeURIComponent(token)}`;
}

/** Neue Zeile für epa_uebersicht_zugaenge. */
function zugangZeile({ kunde_id, hash, jetzt, tage = LINK_TAGE }) {
	const t = new Date(jetzt).getTime();
	return { kunde_id, schluessel_hash: hash, erstellt_am: new Date(t).toISOString(), ablauf: new Date(t + tage * 86400000).toISOString(), gesperrt_am: null };
}

// Zugänge zum Betreiber-Dashboard (EPA-14) liegen in derselben Tabelle mit dieser Kennung statt einer kunde_id.
const BETREIBER = '__betreiber__';

/**
 * betreiber: true = nur Betreiber-Zugänge gelten (EPA-14), sonst nur Kunden-Zugänge (EPA-12).
 * @returns {{ ok: true, kunde_id } | { ok: false, status, titel, text }}
 */
function zugangPruefen({ zugang, jetzt, betreiber = false }) {
	const nein = (status, titel, text) => ({ ok: false, status, titel, text });
	const passt = zugang && zugang.id !== undefined && zugang.kunde_id && (zugang.kunde_id === BETREIBER) === betreiber;
	if (!passt) return nein(404, 'Link ungültig', 'Dieser Link ist ungültig. Den aktuellen Link finden Sie in der täglichen Zusammenfassung in Teams.');
	if (zugang.gesperrt_am) return nein(403, 'Link gesperrt', 'Dieser Link wurde gesperrt. Den aktuellen Link finden Sie in der täglichen Zusammenfassung in Teams.');
	if (!(new Date(zugang.ablauf).getTime() > new Date(jetzt).getTime())) return nein(410, 'Link abgelaufen', 'Dieser Link ist abgelaufen. Den aktuellen Link finden Sie in der täglichen Zusammenfassung in Teams.');
	return { ok: true, kunde_id: zugang.kunde_id };
}

function json(wert, standard) {
	if (wert === null || wert === undefined || wert === '') return standard;
	if (typeof wert === 'object') return wert;
	try { return JSON.parse(wert); } catch (e) { return standard; }
}

function ms(t) {
	const x = new Date(t || NaN).getTime();
	return Number.isFinite(x) ? x : NaN;
}

/**
 * Ordnet die Vorgänge eines Kunden den Gruppen zu. Nur Zeilen dieses Kunden (zweite Sicherung neben dem Filter
 * beim Lesen). Älteste zuerst: Was am längsten liegt, steht oben.
 * @param {object} p
 * @param {object[]} p.vorgaenge Zeilen aus epa_vorgaenge
 * @param {object[]} p.freigaben offene Freigaben (status offen) dieses Kunden
 * @param {object[]} p.felder Zeilen aus epa_config_pflichtfelder (für Anzeigenamen)
 */
function gruppieren({ kunde_id, vorgaenge, freigaben, felder, jetzt }) {
	const name = {};
	for (const f of felder || []) if (f && f.feldname) name[f.feldname] = f.anzeigename || f.feldname;
	const anzeige = (feld) => name[feld] || String(feld).replace(/_/g, ' ');
	const offen = {};
	for (const f of freigaben || []) if (f && f.status === 'offen' && f.kunde_id === kunde_id) offen[f.freigabe_id] = f;
	const t = ms(jetzt);
	const gruppen = GRUPPEN.map((g) => ({ key: g.key, titel: g.titel, text: g.text, eintraege: [] }));
	const index = {};
	GRUPPEN.forEach((g, i) => g.status.forEach((s) => { index[s] = i; }));
	for (const v of vorgaenge || []) {
		if (!v || v.kunde_id !== kunde_id || !(v.status in index)) continue;
		const daten = json(v.extrahierte_daten, {});
		const fehlend = json(v.fehlende_felder, []);
		const seit = ms(v.updatedAt || v.createdAt);
		const fg = v.freigabe_id_aktuell ? offen[v.freigabe_id_aktuell] : null;
		gruppen[index[v.status]].eintraege.push({
			vorgangs_id: v.vorgangs_id,
			status: v.status,
			betreff: v.betreff || '',
			absender: v.absender_name ? `${v.absender_name} (${v.absender_adresse || ''})` : (v.absender_adresse || ''),
			seit: Number.isFinite(seit) ? new Date(seit).toISOString() : null,
			tage: Number.isFinite(seit) && Number.isFinite(t) ? Math.max(0, Math.floor((t - seit) / 86400000)) : null,
			eingang: v.erste_mail_am || null,
			frist: v.status === 'Warten auf Kunde' ? (v.antwort_frist || null) : null,
			erinnerungen: Number(v.erinnerungen_gesendet || 0),
			freigabe_bis: fg ? fg.ablauf : null,
			fehlend: (Array.isArray(fehlend) ? fehlend : []).filter((f) => f && f.feldname).map((f) => f.anzeigename || anzeige(f.feldname)),
			angaben: Object.entries(daten && typeof daten === 'object' ? daten : {})
				.map(([k, w]) => [anzeige(k), w && typeof w === 'object' ? w.wert : w])
				.filter(([, w]) => w !== null && w !== undefined && String(w).trim() !== ''),
			hinweis: v.spoofing_hinweis ? 'Absender möglicherweise gefälscht – bitte prüfen' : (json(v.konflikte, []).length ? 'Widersprüchliche Angaben – bitte prüfen' : ''),
			mail_link: /^https:\/\//.test(String(v.erste_mail_link || '')) ? v.erste_mail_link : null,
		});
	}
	for (const g of gruppen) g.eintraege.sort((a, b) => (ms(a.seit) || 0) - (ms(b.seit) || 0));
	return gruppen;
}

function zaehlen(gruppen) {
	const r = {};
	for (const g of gruppen || []) r[g.key] = g.eintraege.length;
	return r;
}

// ---------------------------------------------------------------- HTML

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function zeit(iso, zone, nurDatum) {
	if (!iso || !Number.isFinite(ms(iso))) return '';
	const o = nurDatum ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' };
	try { return new Date(iso).toLocaleString('de-DE', { ...o, timeZone: zone || 'Europe/Berlin' }); } catch (e) { return new Date(iso).toISOString(); }
}

const STIL = `:root{--bg:#f4f5f7;--karte:#fff;--text:#1d2433;--leise:#5b6475;--linie:#e3e6eb;--rot:#a3222b;--gelb:#9a6700;--gruen:#1f6f43;--blau:#1f5fa8;--grau:#5b6475}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--karte:#1d2128;--text:#e6e8ec;--leise:#9aa3b2;--linie:#2c313a;--rot:#e5737b;--gelb:#e0b44c;--gruen:#5cc28c;--blau:#7aaef0;--grau:#9aa3b2}}
body{font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;margin:0;background:var(--bg);color:var(--text)}
main{max-width:980px;margin:0 auto;padding:16px}h1{font-size:1.4rem;margin:8px 0 4px}h2{font-size:1.1rem;margin:0}
.leise{color:var(--leise);font-size:.9rem}.zahlen{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
.zahl{background:var(--karte);border-radius:8px;padding:10px 14px;border-left:4px solid var(--g);min-width:120px;text-decoration:none;color:inherit}
.zahl b{display:block;font-size:1.5rem}section{margin:20px 0}.kopf{border-left:4px solid var(--g);padding-left:10px;margin-bottom:8px}
details{background:var(--karte);border-radius:8px;margin:6px 0;box-shadow:0 1px 2px rgba(0,0,0,.06)}
summary{cursor:pointer;padding:10px 12px;display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline}
summary b{overflow-wrap:anywhere}.inhalt{padding:0 12px 12px}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:8px 0}
dt{color:var(--leise)}dd{margin:0;overflow-wrap:anywhere}.warn{color:var(--rot)}a{color:var(--blau)}.leer{color:var(--leise);font-style:italic}
.klaerung{--g:var(--rot)}.freigabe{--g:var(--gelb)}.bereit{--g:var(--gruen)}.kunde{--g:var(--blau)}.system{--g:var(--grau)}`;

function eintragHtml(e, zone) {
	const zeilen = [
		['Status', e.status],
		['Von', e.absender],
		['Eingang', zeit(e.eingang, zone)],
		e.frist ? ['Antwortfrist', zeit(e.frist, zone)] : null,
		e.frist || e.erinnerungen ? ['Erinnerungen', String(e.erinnerungen)] : null,
		e.freigabe_bis ? ['Freigabe-Link gültig bis', zeit(e.freigabe_bis, zone)] : null,
		e.fehlend.length ? ['Fehlt noch', e.fehlend.join(', ')] : null,
	].filter(Boolean);
	const angaben = e.angaben.length ? `<p class="leise">Erkannte Angaben</p><dl>${e.angaben.map(([k, w]) => `<dt>${esc(k)}</dt><dd>${esc(w)}</dd>`).join('')}</dl>` : '';
	const seit = e.tage === null ? '' : e.tage === 0 ? 'seit heute' : e.tage === 1 ? 'seit 1 Tag' : `seit ${e.tage} Tagen`;
	return `<details><summary><b>${esc(e.betreff || '(ohne Betreff)')}</b><span class="leise">${esc(e.vorgangs_id)} · ${esc(seit)}</span>${e.hinweis ? `<span class="warn">${esc(e.hinweis)}</span>` : ''}</summary>
<div class="inhalt"><dl>${zeilen.map(([k, w]) => `<dt>${esc(k)}</dt><dd>${esc(w)}</dd>`).join('')}</dl>${angaben}${e.mail_link ? `<a href="${esc(e.mail_link)}" rel="noopener noreferrer">Originalmail in Outlook öffnen</a>` : ''}</div></details>`;
}

/** Ganze Seite. kunde: { kunde_id, postfach }; ablauf: Ablauf dieses Links. */
function seite({ kunde, gruppen, jetzt, zone, ablauf }) {
	const z = zaehlen(gruppen);
	const kacheln = gruppen.map((g) => `<a class="zahl ${g.key}" href="#${g.key}"><b>${z[g.key]}</b>${esc(g.titel)}</a>`).join('');
	const teile = gruppen.map((g) => `<section id="${g.key}" class="${g.key}"><div class="kopf"><h2>${esc(g.titel)} (${g.eintraege.length})</h2><span class="leise">${esc(g.text)}</span></div>
${g.eintraege.length ? g.eintraege.map((e) => eintragHtml(e, zone)).join('') : '<p class="leer">Keine Vorgänge.</p>'}</section>`).join('');
	return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Vorgänge</title><style>${STIL}</style></head><body><main>
<h1>Offene Vorgänge</h1><p class="leise">Postfach ${esc(kunde.postfach || kunde.kunde_id)} · Stand ${esc(zeit(jetzt, zone))} · Seite neu laden für den aktuellen Stand</p>
<div class="zahlen">${kacheln}</div>${teile}
<p class="leise">Dieser Link ist persönlich für Ihr Team und gültig bis ${esc(zeit(ablauf, zone, true))}. Bitte nicht weitergeben. Einen neuen Link bringt jede tägliche Zusammenfassung in Teams.</p>
</main></body></html>`;
}

function seiteMeldung(titel, text) {
	return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(titel)}</title><style>${STIL}</style></head><body><main><h1>${esc(titel)}</h1><p>${esc(text)}</p></main></body></html>`;
}

/** Tägliche Zusammenfassung für Teams (HTML wie die übrigen Meldungen). */
function zusammenfassung({ gruppen, link: url, ablauf, zone }) {
	const z = zaehlen(gruppen);
	const offen = (gruppen || []).reduce((n, g) => n + g.eintraege.length, 0);
	const zeilen = [`<b>📋 Tagesübersicht: ${offen === 0 ? 'keine offenen Vorgänge' : offen === 1 ? '1 offener Vorgang' : `${offen} offene Vorgänge`}</b>`];
	for (const g of gruppen || []) {
		if (!z[g.key] && g.key !== 'klaerung') continue;
		zeilen.push(`${esc(g.titel)}: <b>${z[g.key]}</b>`);
	}
	for (const key of ['klaerung', 'freigabe']) {
		const g = (gruppen || []).find((x) => x.key === key);
		if (!g || !g.eintraege.length) continue;
		zeilen.push('', `<b>${esc(g.titel)}</b> (älteste zuerst):`);
		for (const e of g.eintraege.slice(0, MAX_LISTE_TEAMS)) {
			const seit = e.tage === null ? '' : e.tage === 0 ? ', seit heute' : e.tage === 1 ? ', seit 1 Tag' : `, seit ${e.tage} Tagen`;
			zeilen.push(`• ${esc(e.vorgangs_id)}: ${esc(e.betreff || '(ohne Betreff)')}${esc(seit)}`);
		}
		if (g.eintraege.length > MAX_LISTE_TEAMS) zeilen.push(`… und ${g.eintraege.length - MAX_LISTE_TEAMS} weitere`);
	}
	zeilen.push('', `<a href="${esc(url)}">Alle Vorgänge ansehen</a> (Link gültig bis ${esc(zeit(ablauf, zone, true))}, bitte nicht weitergeben)`);
	return zeilen.join('<br>');
}

module.exports = {
	BETREIBER, LINK_TAGE, PFAD, GRUPPEN, tokenErzeugen, tokenHash, istGueltigesToken, link, zugangZeile, zugangPruefen,
	gruppieren, zaehlen, esc, seite, seiteMeldung, zusammenfassung,
};
