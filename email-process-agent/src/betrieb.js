'use strict';
// Betreiber-Dashboard (EPA-14): alle Kunden, Systemläufe, Fehler und Verlauf auf einer Seite. Zugang wie bei der
// Übersichtsseite über einen geheimen Link (Hash in epa_uebersicht_zugaenge), aber mit der festen Kennung
// BETREIBER statt einer kunde_id. Kundenlinks öffnen dieses Dashboard nie und umgekehrt.

const BETREIBER = '__betreiber__';
const PFAD = 'epa-betrieb';
const LINK_TAGE = 90;
const VERLAUF_TAGE = 14;
const MAX_FEHLER = 10;
// Erwartete Laufabstände (EPA-04 stündlich, EPA-06 07:30 und 13:30, EPA-11 täglich 07:40).
const GRENZE_STUNDEN = Object.freeze({ nachfassen: 3, watchdog: 19, zustelltest: 26 });
const H = 3600000;

function ms(t) {
	const x = new Date(t ?? NaN).getTime();
	return Number.isFinite(x) ? x : NaN;
}

function json(wert, standard) {
	if (wert === null || wert === undefined || wert === '') return standard;
	if (typeof wert === 'object') return wert;
	try { return JSON.parse(wert); } catch (e) { return standard; }
}

function stundenSeit(t, jetzt) {
	const a = ms(t);
	return Number.isFinite(a) ? (ms(jetzt) - a) / H : Infinity;
}

/** Kalendertag (YYYY-MM-DD) in der Zeitzone. */
function tag(t, zone) {
	try {
		return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
	} catch (e) {
		return new Date(t).toISOString().slice(0, 10);
	}
}

/**
 * Wertet alle Tabellen aus. Nur Zähler, IDs, Zeitpunkte und bereinigte Fehlermeldungen (keine Mail-Inhalte).
 * @param {object} p
 * @param {object[]} p.configs  Zeilen aus epa_config_allgemein (alle, auch inaktive)
 * @param {object} p.gueltig    kunde_id -> true/false (Ergebnis des Config-Validators)
 * @param {object[]} p.vorgaenge Zeilen aus epa_vorgaenge
 * @param {object[]} p.freigaben Zeilen aus epa_freigaben (mindestens offen, fehler, unzustellbar, nicht_zugestellt)
 * @param {object[]} p.system   Zeilen aus epa_system_status
 * @param {object[]} p.fehler   Zeilen aus epa_fehler_log (letzte Tage)
 * @param {object} p.gruppen    Gruppen aus src/uebersicht.js (GRUPPEN)
 */
function auswerten({ configs, gueltig, vorgaenge, freigaben, system, fehler, gruppen, jetzt, zone = 'Europe/Berlin' }) {
	const befunde = [];
	const melden = (stufe, text) => befunde.push({ stufe, text });
	const sys = {};
	for (const z of system || []) if (z && z.schluessel) sys[z.schluessel] = z;
	const statusGruppe = {};
	for (const g of gruppen || []) for (const s of g.status) statusGruppe[s] = g.key;

	// ---- Kunden
	// Nur aktive Kunden (inaktive Test- und Beispiel-Configs blenden aus).
	const kunden = (configs || []).filter((c) => c && c.kunde_id && c.aktiv === true).map((c) => {
		const eigene = (vorgaenge || []).filter((v) => v && v.kunde_id === c.kunde_id);
		const zahlen = Object.fromEntries((gruppen || []).map((g) => [g.key, 0]));
		let letzteMail = NaN;
		for (const v of eigene) {
			const g = statusGruppe[v.status];
			if (g) zahlen[g] += 1;
			if (v.status === 'Ignoriert') continue;
			const t = ms(v.erste_mail_am || v.createdAt);
			if (Number.isFinite(t) && !(t <= letzteMail)) letzteMail = t;
		}
		const fg = (freigaben || []).filter((f) => f && f.kunde_id === c.kunde_id);
		const zaehle = (status) => fg.filter((f) => f.status === status).length;
		const zt = sys[`zustelltest:${c.kunde_id}`];
		const zErg = zt ? json(zt.letztes_ergebnis, {}) : null;
		const k = {
			kunde_id: c.kunde_id,
			postfach: c.postfach || '',
			aktiv: c.aktiv === true,
			config_ok: gueltig ? gueltig[c.kunde_id] === true : null,
			zahlen,
			letzte_mail: Number.isFinite(letzteMail) ? new Date(letzteMail).toISOString() : null,
			zustelltest: zt ? { ok: zErg.ok === true, art: zErg.art || null, am: zt.letzter_lauf || null } : null,
			versandfehler: zaehle('fehler'),
			unzustellbar: zaehle('unzustellbar') + zaehle('nicht_zugestellt'),
		};
		if (k.aktiv) {
			if (k.config_ok === false) melden('kritisch', `${k.kunde_id}: Config ungültig – Nachfassen und Zustelltest laufen für diesen Kunden nicht`);
			if (!k.zustelltest) melden('warnung', `${k.kunde_id}: noch kein Zustelltest gelaufen`);
			else if (!k.zustelltest.ok) melden('kritisch', `${k.kunde_id}: letzter Zustelltest fehlgeschlagen (${k.zustelltest.art || 'unbekannt'}) – Mails kommen evtl. nicht an`);
			else if (stundenSeit(k.zustelltest.am, jetzt) > GRENZE_STUNDEN.zustelltest) melden('warnung', `${k.kunde_id}: Zustelltest seit über ${GRENZE_STUNDEN.zustelltest} h nicht gelaufen`);
			if (k.versandfehler) melden('kritisch', `${k.kunde_id}: ${k.versandfehler} Nachricht(en) nach Freigabe nicht gesendet`);
			if (k.unzustellbar) melden('warnung', `${k.kunde_id}: ${k.unzustellbar} Nachricht(en) kamen beim Kunden nicht an`);
			if (zahlen.klaerung) melden('warnung', `${k.kunde_id}: ${zahlen.klaerung} Vorgang/Vorgänge brauchen eine Klärung`);
		}
		return k;
	});

	// ---- Systemläufe
	const nf = sys.epa04_lauf || null;
	const wd = sys.watchdog || null;
	const wdErg = wd ? json(wd.letztes_ergebnis, {}) : {};
	const alarm = sys.alarmierung || {};
	const laeufe = {
		nachfassen: { am: nf ? nf.letzter_lauf || null : null, ergebnis: nf ? json(nf.letztes_ergebnis, {}) : null },
		watchdog: { am: wd ? wd.letzter_lauf || null : null, gesamt: wdErg.gesamt || null, befunde: Array.isArray(wdErg.befunde) ? wdErg.befunde : [] },
		alarm_kanal: alarm.alarm_kanal || 'teams',
	};
	if (stundenSeit(laeufe.nachfassen.am, jetzt) > GRENZE_STUNDEN.nachfassen) melden('kritisch', `Nachfassen (EPA-04) seit über ${GRENZE_STUNDEN.nachfassen} h nicht gelaufen – Erinnerungen und Eskalationen stehen`);
	if (stundenSeit(laeufe.watchdog.am, jetzt) > GRENZE_STUNDEN.watchdog) melden('warnung', `Watchdog (EPA-06) seit über ${GRENZE_STUNDEN.watchdog} h nicht gelaufen`);
	else if (laeufe.watchdog.gesamt && laeufe.watchdog.gesamt !== 'ok') melden(laeufe.watchdog.gesamt === 'kritisch' ? 'kritisch' : 'warnung', `Watchdog meldet „${laeufe.watchdog.gesamt}“ (${laeufe.watchdog.befunde.map((b) => b.code).join(', ') || 'ohne Details'})`);

	// ---- Fehler
	const fl = (fehler || []).filter((f) => f && Number.isFinite(ms(f.createdAt))).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
	const letzte24 = fl.filter((f) => stundenSeit(f.createdAt, jetzt) <= 24);
	const ohneAlarm = fl.filter((f) => !f.alarmiert_am);
	if (ohneAlarm.length) melden('kritisch', `${ohneAlarm.length} Fehler ohne zugestellten Alarm – Alarmweg (${laeufe.alarm_kanal}) prüfen`);
	if (letzte24.length) melden('warnung', `${letzte24.length} Fehler in den letzten 24 h`);
	const fehlerListe = fl.slice(0, MAX_FEHLER).map((f) => ({
		am: new Date(ms(f.createdAt)).toISOString(),
		workflow: f.workflow_name || f.workflow_id || '',
		node: f.node || '',
		code: `${f.statuscode || ''} ${f.fehlercode || ''}`.trim(),
		vorgangs_id: f.vorgangs_id || '',
		meldung: String(f.meldung || '').slice(0, 200),
		alarmiert: Boolean(f.alarmiert_am),
	}));

	// ---- Verlauf: neue Anfragen je Tag (alle Kunden), ältester Tag zuerst
	const heute = ms(jetzt);
	const tage = [];
	for (let i = VERLAUF_TAGE - 1; i >= 0; i--) tage.push(tag(heute - i * 86400000, zone));
	const proTag = Object.fromEntries(tage.map((t) => [t, 0]));
	for (const v of vorgaenge || []) {
		// Ignorierte Mails (Newsletter, Abwesenheitsnotizen) sind keine Anfragen.
		if (!v || v.status === 'Ignoriert') continue;
		const t = ms(v.erste_mail_am || v.createdAt);
		if (!Number.isFinite(t)) continue;
		const d = tag(t, zone);
		if (d in proTag) proTag[d] += 1;
	}

	const stufe = befunde.some((b) => b.stufe === 'kritisch') ? 'kritisch' : befunde.length ? 'warnung' : 'ok';
	befunde.sort((a, b) => (a.stufe === b.stufe ? 0 : a.stufe === 'kritisch' ? -1 : 1));
	return {
		stufe,
		befunde,
		kunden,
		laeufe,
		fehler: { anzahl: fl.length, letzte24: letzte24.length, liste: fehlerListe },
		verlauf: tage.map((t) => ({ tag: t, anzahl: proTag[t] })),
	};
}

// ---------------------------------------------------------------- HTML

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function zeit(iso, zone) {
	if (!iso || !Number.isFinite(ms(iso))) return '–';
	try { return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short', timeZone: zone }); } catch (e) { return iso; }
}

function vor(iso, jetzt) {
	const h = stundenSeit(iso, jetzt);
	if (!Number.isFinite(h)) return 'nie';
	if (h < 1) return `vor ${Math.max(0, Math.round(h * 60))} min`;
	if (h < 48) return `vor ${Math.round(h)} h`;
	return `vor ${Math.round(h / 24)} Tagen`;
}

// Farben: Status-Palette (gut/Warnung/kritisch, immer mit Symbol und Text) und eine Reihe in Blau für den Verlauf.
const STIL = `:root{color-scheme:light;--bg:#f4f4f2;--surface-1:#fcfcfb;--text-primary:#0b0b0b;--text-secondary:#52514e;--linie:#e4e3df;--series-1:#2a78d6;--good:#0ca30c;--warning:#fab219;--critical:#d03b3b}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111110;--surface-1:#1a1a19;--text-primary:#f0efec;--text-secondary:#c3c2b7;--linie:#383835;--series-1:#3987e5}}
body{font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;margin:0;background:var(--bg);color:var(--text-primary)}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:1.4rem;margin:8px 0 2px}h2{font-size:1.05rem;margin:0 0 10px}
.leise{color:var(--text-secondary);font-size:.88rem}.karte{background:var(--surface-1);border-radius:10px;padding:16px;margin:14px 0;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.ampel{display:flex;gap:12px;align-items:center;border-left:6px solid var(--s)}.ampel b{font-size:1.15rem}
.ok{--s:var(--good)}.warnung{--s:var(--warning)}.kritisch{--s:var(--critical)}
.punkt{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--s);margin-right:6px;vertical-align:baseline}
ul.befunde{list-style:none;padding:0;margin:10px 0 0}ul.befunde li{padding:4px 0}
.tab{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--linie);white-space:nowrap}
th{color:var(--text-secondary);font-weight:600}td.zahl,th.zahl{text-align:right;font-variant-numeric:tabular-nums}td.text{white-space:normal;min-width:240px}td:first-child{white-space:normal;overflow-wrap:anywhere;min-width:140px}
.raster{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.wert{font-size:1.4rem;font-weight:600;font-variant-numeric:tabular-nums}
svg text{fill:var(--text-secondary);font-size:11px}svg .gitter{stroke:var(--linie);stroke-width:1}svg .basis{stroke:var(--text-secondary);stroke-width:1}
svg .balken{fill:var(--series-1)}.diagramm{overflow-x:auto}.diagramm svg{min-width:560px}svg .ziel:hover+.balken,svg .balken:hover{opacity:.8}`;

// Kurze Spaltenköpfe für die Kundentabelle (voller Titel als Tooltip).
const KURZ = Object.freeze({ klaerung: 'Klärung', freigabe: 'Freigabe', bereit: 'Bereit', kunde: 'Wartet Kunde', system: 'In Arbeit' });

function symbol(stufe) {
	return { ok: '✅', warnung: '⚠️', kritisch: '⛔' }[stufe] || '';
}

function statusZelle(stufe, text) {
	return `<span class="${stufe}"><span class="punkt" aria-hidden="true"></span>${esc(text)}</span>`;
}

/** Säulendiagramm einer Reihe (neue Anfragen je Tag), ohne Skripte. Hover über <title>. */
function verlaufSvg(verlauf) {
	const B = 640, HOEHE = 180, L = 30, R = 8, O = 12, U = 26;
	const max = Math.max(1, ...verlauf.map((v) => v.anzahl));
	const schritt = max <= 4 ? 1 : max <= 10 ? 2 : Math.ceil(max / 4 / 5) * 5;
	const oben = Math.ceil(max / schritt) * schritt;
	const y = (w) => O + (HOEHE - O - U) * (1 - w / oben);
	const slot = (B - L - R) / verlauf.length;
	const breite = Math.min(24, slot - 4);
	const teile = [];
	for (let w = 0; w <= oben; w += schritt) {
		teile.push(`<line class="${w === 0 ? 'basis' : 'gitter'}" x1="${L}" x2="${B - R}" y1="${y(w)}" y2="${y(w)}"/><text x="${L - 6}" y="${y(w) + 4}" text-anchor="end">${w}</text>`);
	}
	verlauf.forEach((v, i) => {
		const x = L + i * slot + (slot - breite) / 2;
		const [jj, mm, tt] = v.tag.split('-');
		const titel = `${tt}.${mm}.${jj}: ${v.anzahl} ${v.anzahl === 1 ? 'Anfrage' : 'Anfragen'}`;
		// Großes, unsichtbares Ziel für den Hover; die Säule selbst mit 4px runder Oberkante, eckig an der Basis.
		teile.push(`<rect class="ziel" x="${L + i * slot}" y="${O}" width="${slot}" height="${HOEHE - O - U}" fill="transparent"><title>${esc(titel)}</title></rect>`);
		if (v.anzahl > 0) {
			const y0 = y(0), y1 = y(v.anzahl), r = Math.min(4, (y0 - y1) / 2, breite / 2);
			teile.push(`<path class="balken" d="M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + breite - r} Q${x + breite},${y1} ${x + breite},${y1 + r} V${y0} Z"><title>${esc(titel)}</title></path>`);
		}
		// Jeden zweiten Tag beschriften, vom letzten (heute) aus gezählt.
		if ((verlauf.length - 1 - i) % 2 === 0) teile.push(`<text x="${x + breite / 2}" y="${HOEHE - 8}" text-anchor="middle">${tt}.${mm}.</text>`);
	});
	return `<svg viewBox="0 0 ${B} ${HOEHE}" width="100%" role="img" aria-label="Neue Anfragen je Tag, letzte ${verlauf.length} Tage">${teile.join('')}</svg>`;
}

function seite({ daten, jetzt, zone = 'Europe/Berlin', ablauf, gruppen }) {
	const d = daten;
	const titel = { ok: 'Alles in Ordnung', warnung: 'Es gibt Hinweise', kritisch: 'Handlungsbedarf' }[d.stufe];
	const befunde = d.befunde.length
		? `<ul class="befunde">${d.befunde.map((b) => `<li>${statusZelle(b.stufe, b.stufe === 'kritisch' ? 'Kritisch' : 'Hinweis')}: ${esc(b.text)}</li>`).join('')}</ul>`
		: '<p class="leise">Keine Auffälligkeiten.</p>';
	const gKopf = (gruppen || []).map((g) => `<th class="zahl" title="${esc(g.titel)}">${esc(KURZ[g.key] || g.titel)}</th>`).join('');
	const kunden = d.kunden.map((k) => {
		const zt = !k.zustelltest ? statusZelle('warnung', 'noch nie') : statusZelle(k.zustelltest.ok ? 'ok' : 'kritisch', `${k.zustelltest.ok ? 'ok' : 'fehlgeschlagen'} · ${vor(k.zustelltest.am, jetzt)}`);
		return `<tr><td><b>${esc(k.kunde_id)}</b><br><span class="leise">${esc(k.postfach)}</span></td>
<td>${k.aktiv ? statusZelle(k.config_ok === false ? 'kritisch' : 'ok', k.config_ok === false ? 'aktiv, Config ungültig' : 'aktiv') : '<span class="leise">inaktiv</span>'}</td>
${(gruppen || []).map((g) => `<td class="zahl">${k.zahlen[g.key] || 0}</td>`).join('')}
<td class="zahl">${k.versandfehler + k.unzustellbar}</td><td>${zt}</td><td>${esc(vor(k.letzte_mail, jetzt))}</td></tr>`;
	}).join('');
	const nf = d.laeufe.nachfassen;
	const wd = d.laeufe.watchdog;
	const nfZ = nf.ergebnis && typeof nf.ergebnis === 'object' ? `${Number(nf.ergebnis.aufgaben || 0)} Aufgaben, ${Number(nf.ergebnis.pruefungen || 0)} Prüfungen` : '';
	const lauf = (name, am, grenze, extra) => {
		const s = stundenSeit(am, jetzt) > grenze ? 'kritisch' : 'ok';
		return `<div><div class="leise">${esc(name)}</div><div class="wert">${statusZelle(s, vor(am, jetzt))}</div><div class="leise">${esc(zeit(am, zone))}${extra ? ' · ' + esc(extra) : ''}</div></div>`;
	};
	const fehler = d.fehler.liste.length
		? `<div class="tab"><table><thead><tr><th>Zeit</th><th>Workflow / Node</th><th>Code</th><th>Vorgang</th><th>Meldung</th><th>Alarm</th></tr></thead><tbody>${d.fehler.liste.map((f) => `<tr><td>${esc(zeit(f.am, zone))}</td><td>${esc(f.workflow)}<br><span class="leise">${esc(f.node)}</span></td><td>${esc(f.code)}</td><td>${esc(f.vorgangs_id || '–')}</td><td class="text">${esc(f.meldung)}</td><td>${f.alarmiert ? statusZelle('ok', 'gesendet') : statusZelle('kritisch', 'fehlt')}</td></tr>`).join('')}</tbody></table></div>`
		: '<p class="leise">Keine Fehler in diesem Zeitraum.</p>';
	const summe = d.verlauf.reduce((n, v) => n + v.anzahl, 0);
	return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="300"><title>Betrieb</title><style>${STIL}</style></head><body><main>
<h1>Betrieb Email Process Agent</h1><p class="leise">Stand ${esc(zeit(jetzt, zone))} · lädt alle 5 Minuten neu · Link gültig bis ${esc(zeit(ablauf, zone))}</p>
<div class="karte ampel ${d.stufe}"><span style="font-size:1.6rem" aria-hidden="true">${symbol(d.stufe)}</span><div><b>${esc(titel)}</b><div class="leise">${d.befunde.length} Befund(e) · ${d.kunden.filter((k) => k.aktiv).length} aktive(r) Kunde(n) · Alarme gehen an: ${esc(d.laeufe.alarm_kanal === 'telegram_test' ? 'Telegram' : 'Teams')}</div></div></div>
<div class="karte"><h2>Befunde</h2>${befunde}</div>
<div class="karte"><h2>Kunden</h2><div class="tab"><table><thead><tr><th>Kunde</th><th>Status</th>${gKopf}<th class="zahl" title="Nach Freigabe nicht gesendet oder beim Kunden nicht angekommen">Nicht angekommen</th><th>Zustelltest</th><th>Letzte Anfrage</th></tr></thead><tbody>${kunden || '<tr><td colspan="10" class="leise">Keine aktiven Kunden.</td></tr>'}</tbody></table></div></div>
<div class="karte"><h2>Automatische Läufe</h2><div class="raster">${lauf('Nachfassen (EPA-04, stündlich)', nf.am, GRENZE_STUNDEN.nachfassen, nfZ)}${lauf('Watchdog (EPA-06, 07:30 und 13:30)', wd.am, GRENZE_STUNDEN.watchdog, wd.gesamt ? 'Ergebnis: ' + wd.gesamt : '')}</div></div>
<div class="karte"><h2>Neue Anfragen je Tag</h2><p class="leise">Alle Kunden, letzte ${d.verlauf.length} Tage: ${summe} Anfragen</p><div class="diagramm">${verlaufSvg(d.verlauf)}</div>
<details><summary class="leise">Als Tabelle</summary><div class="tab"><table><thead><tr><th>Tag</th><th class="zahl">Anfragen</th></tr></thead><tbody>${d.verlauf.map((v) => `<tr><td>${esc(v.tag.split('-').reverse().join('.'))}</td><td class="zahl">${v.anzahl}</td></tr>`).join('')}</tbody></table></div></details></div>
<div class="karte"><h2>Fehler (letzte 7 Tage: ${d.fehler.anzahl}, davon 24 h: ${d.fehler.letzte24})</h2>${fehler}</div>
<p class="leise">Nur für den Betreiber. Nicht weitergeben. Neuen Link: „EPA-14 Betrieb-Dashboard“ manuell starten (der alte wird gesperrt).</p>
</main></body></html>`;
}

/** Nachricht mit dem neuen Link (Telegram an den Betreiber). */
function linkNachricht({ link, ablauf, zone = 'Europe/Berlin' }) {
	return `<b>🔐 Neuer Link zum Betreiber-Dashboard</b><br><a href="${esc(link)}">Dashboard öffnen</a><br>Gültig bis ${esc(zeit(ablauf, zone))}. Alle früheren Dashboard-Links sind gesperrt. Nicht weitergeben.`;
}

module.exports = { BETREIBER, PFAD, LINK_TAGE, VERLAUF_TAGE, GRENZE_STUNDEN, auswerten, verlaufSvg, seite, linkNachricht, esc };
