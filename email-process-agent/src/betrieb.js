'use strict';
// Betreiber-Dashboard (EPA-14): nur zwei Fragen – läuft alles, und ist es sicher? Ampel mit Befunden, Verbindungen
// je Kunde, automatische Läufe, Sicherheitsprüfungen und letzte Fehler. Zugang wie bei der Übersichtsseite über
// einen geheimen Link (Hash in epa_uebersicht_zugaenge), aber mit der festen Kennung BETREIBER statt einer kunde_id.
// Kundenlinks öffnen dieses Dashboard nie und umgekehrt. Keine Mail-Inhalte: nur IDs, Codes, Zeiten, Zähler.

const BETREIBER = '__betreiber__';
const PFAD = 'epa-betrieb';
const LINK_TAGE = 90;
const MAX_FEHLER = 10;
const MAX_IDS = 5;
const DIREKT_GESENDET = 'Outlook (direkt gesendet)';
// Erwartete Laufabstände (EPA-04 stündlich, EPA-06 07:30 und 13:30, EPA-11 täglich 07:40, EPA-08 nachts).
const GRENZE_STUNDEN = Object.freeze({ nachfassen: 3, watchdog: 19, zustelltest: 26, loeschjob: 26, haengt: 1 });
// Status, in denen ein Vorgang nur kurz stehen darf (danach ist intern etwas abgebrochen).
const DURCHLAUF_STATUS = Object.freeze(['Neu', 'In Prüfung', 'Lücken erkannt']);
const LINK_WARNUNG_TAGE = 14;
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

function liste(ids) {
	const l = [...new Set(ids.filter(Boolean))];
	return l.slice(0, MAX_IDS).join(', ') + (l.length > MAX_IDS ? ` und ${l.length - MAX_IDS} weitere` : '');
}

function freigeberVon(c) {
	const f = json(c && c.freigeber, []);
	return (Array.isArray(f) ? f : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
}

/**
 * @param {object} p
 * @param {object[]} p.configs  Zeilen aus epa_config_allgemein (nur aktive werden gezeigt)
 * @param {object} p.gueltig    kunde_id -> true/false (Config-Validator)
 * @param {object[]} p.vorgaenge Zeilen aus epa_vorgaenge (offene)
 * @param {object[]} p.freigaben Zeilen aus epa_freigaben (Versandprobleme und Entscheidungen der letzten 7 Tage)
 * @param {object[]} p.system   Zeilen aus epa_system_status
 * @param {object[]} p.fehler   Zeilen aus epa_fehler_log (letzte 7 Tage)
 * @param {object[]} p.zugaenge Zeilen aus epa_uebersicht_zugaenge
 */
function auswerten({ configs, gueltig, vorgaenge, freigaben, system, fehler, zugaenge, jetzt }) {
	const befunde = [];
	const melden = (stufe, text) => befunde.push({ stufe, text });
	const sys = {};
	for (const z of system || []) if (z && z.schluessel) sys[z.schluessel] = z;
	const wd = sys.watchdog || null;
	const wdErg = wd ? json(wd.letztes_ergebnis, {}) : {};
	const wdBefunde = Array.isArray(wdErg.befunde) ? wdErg.befunde : [];
	const fl = (fehler || []).filter((f) => f && Number.isFinite(ms(f.createdAt))).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
	const aktiv = (configs || []).filter((c) => c && c.kunde_id && c.aktiv === true);

	// ---- Verbindungen und Durchlauf je aktivem Kunden
	// Quelle: letzter Watchdog-Lauf; ein Anmeldefehler (401/403) des Postfach-Workflows danach gilt sofort.
	const wdHat = (code, kunde) => wdBefunde.some((b) => b.code === code && (!b.kunde_id || b.kunde_id === kunde));
	const kunden = aktiv.map((c) => {
		const auth = fl.find((f) => c.postfach_workflow_id && f.workflow_id === c.postfach_workflow_id
			&& (f.fehlercode === 'AUTH_FEHLER' || f.fehlercode === 'KEINE_BERECHTIGUNG') && !(ms(f.createdAt) < ms(wd && wd.letzter_lauf)));
		const geprueft = wd ? wd.letzter_lauf || null : null;
		const verb = (rot) => (geprueft ? { ok: !rot, am: geprueft } : { ok: null, am: null });
		const zt = sys[`zustelltest:${c.kunde_id}`];
		const zErg = zt ? json(zt.letztes_ergebnis, {}) : null;
		const eigene = (vorgaenge || []).filter((v) => v && v.kunde_id === c.kunde_id);
		const haengt = eigene.filter((v) => DURCHLAUF_STATUS.includes(v.status) && stundenSeit(v.updatedAt || v.createdAt, jetzt) > GRENZE_STUNDEN.haengt);
		let letzte = NaN;
		for (const v of eigene) { const t = ms(v.erste_mail_am || v.createdAt); if (Number.isFinite(t) && !(t <= letzte)) letzte = t; }
		const k = {
			kunde_id: c.kunde_id,
			postfach: c.postfach || '',
			config_ok: gueltig ? gueltig[c.kunde_id] !== false : true,
			outlook: auth ? { ok: false, am: auth.createdAt } : verb(wdHat('VERBINDUNG_POSTFACH', c.kunde_id)),
			teams: verb(wdHat('VERBINDUNG_TEAMS', c.kunde_id)),
			ki: verb(wdHat('VERBINDUNG_LLM', c.kunde_id)),
			versand: zt ? { ok: zErg.ok === true, am: zt.letzter_lauf || null, art: zErg.art || null } : { ok: null, am: null },
			haengend: haengt.map((v) => v.vorgangs_id),
			letzte_mail: Number.isFinite(letzte) ? new Date(letzte).toISOString() : null,
			versandfehler: (freigaben || []).filter((f) => f && f.kunde_id === c.kunde_id && f.status === 'fehler').length,
		};
		const n = k.kunde_id;
		if (!k.config_ok) melden('kritisch', `${n}: Config ungültig – der Agent arbeitet für diesen Kunden nicht vollständig`);
		if (k.outlook.ok === false) melden('kritisch', `${n}: Outlook-Postfach nicht erreichbar – Credential in n8n neu verbinden, bis dahin werden keine Mails abgeholt`);
		if (k.teams.ok === false) melden('kritisch', `${n}: Teams nicht erreichbar – Credential neu verbinden, bis dahin gehen keine Freigabe-Links und Meldungen raus`);
		if (k.ki.ok === false) melden('kritisch', `${n}: KI nicht erreichbar – Schlüssel bzw. Guthaben prüfen`);
		if (k.versand.ok === false) melden('kritisch', `${n}: letzter Zustelltest fehlgeschlagen (${k.versand.art || 'unbekannt'}) – Mails kommen evtl. nicht an`);
		else if (k.versand.ok === null) melden('warnung', `${n}: noch kein Zustelltest gelaufen`);
		else if (stundenSeit(k.versand.am, jetzt) > GRENZE_STUNDEN.zustelltest) melden('warnung', `${n}: Zustelltest seit über ${GRENZE_STUNDEN.zustelltest} h nicht gelaufen`);
		if (k.haengend.length) melden('kritisch', `${n}: ${k.haengend.length} Vorgang/Vorgänge hängen seit über ${GRENZE_STUNDEN.haengt} h (${liste(k.haengend)})`);
		if (k.versandfehler) melden('kritisch', `${n}: ${k.versandfehler} Nachricht(en) nach Freigabe nicht gesendet`);
		return k;
	});
	if (!aktiv.length) melden('warnung', 'Kein Kunde ist aktiv');

	// ---- Automatische Läufe
	const lauf = (schluessel, grenze) => ({ am: sys[schluessel] ? sys[schluessel].letzter_lauf || null : null, grenze, ok: stundenSeit(sys[schluessel] && sys[schluessel].letzter_lauf, jetzt) <= grenze });
	const laeufe = {
		nachfassen: lauf('epa04_lauf', GRENZE_STUNDEN.nachfassen),
		watchdog: { ...lauf('watchdog', GRENZE_STUNDEN.watchdog), gesamt: wdErg.gesamt || null },
		loeschjob: lauf('loeschjob', GRENZE_STUNDEN.loeschjob),
		alarm_kanal: (sys.alarmierung || {}).alarm_kanal || 'teams',
	};
	if (!laeufe.nachfassen.ok) melden('kritisch', `Nachfassen (EPA-04) seit über ${GRENZE_STUNDEN.nachfassen} h nicht gelaufen – Erinnerungen, Eskalationen und neue Freigabe-Links stehen`);
	if (!laeufe.watchdog.ok) melden('kritisch', `Watchdog (EPA-06) seit über ${GRENZE_STUNDEN.watchdog} h nicht gelaufen – Verbindungen werden nicht geprüft`);

	// ---- Fehler und Alarmweg
	const ohneAlarm = fl.filter((f) => !f.alarmiert_am);
	const letzte24 = fl.filter((f) => stundenSeit(f.createdAt, jetzt) <= 24);
	if (ohneAlarm.length) melden('kritisch', `${ohneAlarm.length} Fehler ohne zugestellten Alarm – Alarmweg (${laeufe.alarm_kanal === 'telegram_test' ? 'Telegram' : 'Teams'}) prüfen`);
	if (letzte24.length) melden('warnung', `${letzte24.length} Fehler in den letzten 24 h`);

	// ---- Sicherheit
	const freigeber = {};
	for (const c of configs || []) if (c && c.kunde_id) freigeber[c.kunde_id] = freigeberVon(c);
	const entschieden = (freigaben || []).filter((f) => f && f.entscheider && stundenSeit(f.updatedAt, jetzt) <= 7 * 24);
	const unberechtigt = entschieden.filter((f) => f.entscheider !== DIREKT_GESENDET && !(freigeber[f.kunde_id] || []).includes(String(f.entscheider).toLowerCase()));
	const direkt = entschieden.filter((f) => f.entscheider === DIREKT_GESENDET);
	const spoofing = (vorgaenge || []).filter((v) => v && v.spoofing_hinweis && v.status !== 'Abgeschlossen' && v.status !== 'Ignoriert');
	const gueltigeZugaenge = (zugaenge || []).filter((z) => z && !z.gesperrt_am && ms(z.ablauf) > ms(jetzt));
	const betreiberLinks = gueltigeZugaenge.filter((z) => z.kunde_id === BETREIBER).sort((a, b) => ms(b.erstellt_am) - ms(a.erstellt_am));
	const kundenLinks = gueltigeZugaenge.filter((z) => z.kunde_id !== BETREIBER).length;
	const neuster = betreiberLinks[0] || null;
	const sicherheit = [
		{ ok: !unberechtigt.length, text: unberechtigt.length ? `Freigabe durch nicht eingetragene Person: ${liste(unberechtigt.map((f) => f.vorgangs_id))}` : 'Alle Freigaben der letzten 7 Tage kamen von eingetragenen Freigebern' },
		{ ok: !direkt.length, stufe: 'warnung', text: direkt.length ? `An der Freigabe vorbei direkt in Outlook gesendet (7 Tage): ${liste(direkt.map((f) => f.vorgangs_id))}` : 'Keine Mail an der Freigabe vorbei gesendet (7 Tage)' },
		{ ok: !spoofing.length, stufe: 'warnung', text: spoofing.length ? `Verdacht auf gefälschten Absender in offenen Vorgängen: ${liste(spoofing.map((v) => v.vorgangs_id))}` : 'Kein Verdacht auf gefälschte Absender in offenen Vorgängen' },
		{ ok: betreiberLinks.length <= 1, text: betreiberLinks.length <= 1 ? 'Höchstens ein gültiger Dashboard-Link' : `${betreiberLinks.length} gültige Dashboard-Links – EPA-14 manuell starten, um alle bis auf einen neuen zu sperren` },
		{ ok: !neuster || (ms(neuster.ablauf) - ms(jetzt)) / 86400000 > LINK_WARNUNG_TAGE, stufe: 'warnung', text: neuster ? 'Dashboard-Link gültig bis %ABLAUF%' : 'Kein gültiger Dashboard-Link', ablauf: neuster ? neuster.ablauf : null },
		{ ok: laeufe.loeschjob.ok, stufe: 'warnung', text: laeufe.loeschjob.ok ? 'Löschjob läuft – Daten werden nach Ablauf der Aufbewahrung gelöscht' : 'Löschjob (EPA-08) läuft nicht – Daten werden nicht nach Ablauf der Aufbewahrung gelöscht' },
		{ ok: true, info: true, text: `${kundenLinks} gültige Kunden-Übersichtslink(s) (je Tagesübersicht ein neuer, 30 Tage gültig)` },
	];
	for (const s of sicherheit) {
		if (s.ok || s.info) continue;
		melden(s.stufe || 'kritisch', `Sicherheit: ${s.ablauf ? 'Dashboard-Link läuft bald ab – EPA-14 manuell starten' : s.text}`);
	}

	const stufe = befunde.some((b) => b.stufe === 'kritisch') ? 'kritisch' : befunde.length ? 'warnung' : 'ok';
	befunde.sort((a, b) => (a.stufe === b.stufe ? 0 : a.stufe === 'kritisch' ? -1 : 1));
	return {
		stufe,
		befunde,
		kunden,
		laeufe,
		sicherheit,
		fehler: {
			anzahl: fl.length,
			letzte24: letzte24.length,
			liste: fl.slice(0, MAX_FEHLER).map((f) => ({
				am: new Date(ms(f.createdAt)).toISOString(),
				workflow: f.workflow_name || f.workflow_id || '',
				node: f.node || '',
				code: `${f.statuscode || ''} ${f.fehlercode || ''}`.trim(),
				vorgangs_id: f.vorgangs_id || '',
				meldung: String(f.meldung || '').slice(0, 200),
				alarmiert: Boolean(f.alarmiert_am),
			})),
		},
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


// Immer hell: weißer Hintergrund, schwarze Schrift, Zahlen in Blau #1E90FF.
// Statusfarben (gut/Warnung/kritisch) nur zusammen mit Symbol und Text.
const STIL = `:root{color-scheme:light;--bg:#ffffff;--text-primary:#000000;--text-secondary:#444444;--linie:#e3e3e3;--blau:#1e90ff;--good:#0ca30c;--warning:#fab219;--critical:#d03b3b}
body{font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;margin:0;background:var(--bg);color:var(--text-primary)}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:1.4rem;margin:8px 0 2px}a{color:var(--blau)}
.leise{color:var(--text-secondary);font-size:.88rem}.ok{--s:var(--good)}.warnung{--s:var(--warning)}.kritisch{--s:var(--critical)}`;




// ---------------------------------------------------------------- Kopfbereich: Kennzahlen und Gesamtzustand

// Vorgänge, die auf eine Entscheidung eines Mitarbeiters warten ("Exceptions").
const EXCEPTION_STATUS = Object.freeze(['Eskaliert / Manuell', 'Zuordnung unklar', 'Klassifizierung unklar']);

/**
 * Kennzahlen für den Kopf. daten = Ergebnis von auswerten().
 * Agent = aktive Postfach-Verbindung (EPA-00-Kopie) eines Kunden.
 * @param {object[]} p.vorgaenge  offene und heute angelegte Vorgänge
 * @param {object[]} p.mails      Zeilen aus epa_verarbeitete_mails seit heuteAb
 * @param {string} p.heuteAb      Beginn des heutigen Tages (ISO, Zeitzone des Betreibers)
 */
function kennzahlen({ daten, configs, vorgaenge, mails, heuteAb }) {
	const aktiv = (configs || []).filter((c) => c && c.kunde_id && c.aktiv === true);
	const kundenIds = new Set(aktiv.map((c) => c.kunde_id));
	const agents = new Set(aktiv.map((c) => c.postfach_workflow_id || `kunde:${c.kunde_id}`));
	const ab = ms(heuteAb);
	const heute = (vorgaenge || []).filter((v) => v && kundenIds.has(v.kunde_id) && v.status !== 'Ignoriert' && ms(v.createdAt) >= ab);
	const m = (mails || []).filter((x) => x && kundenIds.has(x.kunde_id) && ms(x.createdAt) >= ab);
	const ok = m.filter((x) => x.status === 'fertig').length;
	const fehl = m.filter((x) => x.status === 'fehler').length;
	const exceptions = (vorgaenge || []).filter((v) => v && kundenIds.has(v.kunde_id) && EXCEPTION_STATUS.includes(v.status));
	const kritisch = daten.befunde.filter((b) => b.stufe === 'kritisch');
	// Agents mit Problemen: Verbindung, Versand, hängende Vorgänge, ungültige Config oder offene Exceptions.
	const aufmerksamkeit = daten.kunden.filter((k) => !k.config_ok || k.outlook.ok === false || k.teams.ok === false || k.ki.ok === false
		|| k.versand.ok !== true || k.haengend.length || k.versandfehler || exceptions.some((v) => v.kunde_id === k.kunde_id)).length;
	const zustand = kritisch.length
		? { stufe: 'kritisch', symbol: '🔴', text: kritisch.length === 1 ? 'Kritischer Fehler' : `${kritisch.length} kritische Fehler`, grund: kritisch[0].text }
		: aufmerksamkeit
			? { stufe: 'warnung', symbol: '🟡', text: aufmerksamkeit === 1 ? '1 Agent benötigt Aufmerksamkeit' : `${aufmerksamkeit} Agents benötigen Aufmerksamkeit`, grund: daten.befunde[0] ? daten.befunde[0].text : '' }
			: daten.befunde.length
				? { stufe: 'warnung', symbol: '🟡', text: 'Systeme laufen, es gibt Hinweise', grund: daten.befunde[0].text }
				: { stufe: 'ok', symbol: '🟢', text: 'Alle Systeme normal', grund: '' };
	return {
		kunden: kundenIds.size,
		agents: agents.size,
		vorgaenge_heute: heute.length,
		erfolgsquote: ok + fehl ? Math.round((ok / (ok + fehl)) * 1000) / 10 : null,
		verarbeitet_heute: ok + fehl,
		exceptions: exceptions.length,
		kritisch: kritisch.length,
		zustand,
	};
}

// Kennzahl-Kacheln: große Zahl, Beschriftung darunter. Blau für Zahlen, Rot nur bei Problemen (mit Text).
const KOPF_STIL = `.kacheln{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.kachel{border:1px solid var(--linie);border-radius:12px;padding:16px}.kachel .zahl{font-size:2.2rem;font-weight:700;line-height:1.1;color:var(--blau);font-variant-numeric:tabular-nums}
.kachel .name{color:var(--text-secondary);margin-top:4px}.kachel.alarm .zahl{color:var(--critical)}
.zustand{display:flex;gap:14px;align-items:center;border:1px solid var(--linie);border-left:8px solid var(--s);border-radius:12px;padding:18px}
.zustand .gross{font-size:1.5rem;font-weight:700}.zustand .symbol{font-size:2rem;line-height:1}`;

function zahlText(n) {
	return Number(n).toLocaleString('de-DE');
}

function seite({ daten, kopf, jetzt, zone = 'Europe/Berlin', ablauf }) {
	const k = kopf;
	const quote = k.erfolgsquote === null ? '–' : `${k.erfolgsquote.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
	const kachel = (zahl, name, alarm, titel) => `<div class="kachel${alarm ? ' alarm' : ''}"${titel ? ` title="${esc(titel)}"` : ''}><div class="zahl">${esc(zahl)}</div><div class="name">${esc(name)}</div></div>`;
	const kacheln = [
		kachel(zahlText(k.kunden), k.kunden === 1 ? 'Aktiver Kunde' : 'Aktive Kunden'),
		kachel(zahlText(k.agents), k.agents === 1 ? 'Aktiver Agent' : 'Aktive Agents', false, 'Agent = aktive Postfach-Verbindung eines Kunden'),
		kachel(zahlText(k.vorgaenge_heute), 'Vorgänge heute'),
		kachel(quote, 'Erfolgsquote heute', k.erfolgsquote !== null && k.erfolgsquote < 95, `${k.verarbeitet_heute} Mails heute verarbeitet; Anteil ohne technischen Fehler`),
		kachel(zahlText(k.exceptions), k.exceptions === 1 ? 'Offene Exception' : 'Offene Exceptions', false, 'Vorgänge, die eine Entscheidung eines Mitarbeiters brauchen'),
		kachel(zahlText(k.kritisch), k.kritisch === 1 ? 'Kritischer Fehler' : 'Kritische Fehler', k.kritisch > 0),
	].join('');
	const z = k.zustand;
	return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="300"><title>Betrieb</title><style>${STIL}
${KOPF_STIL}</style></head><body><main>
<h1>Betrieb Email Process Agent</h1><p class="leise">Stand ${esc(zeit(jetzt, zone))} · lädt alle 5 Minuten neu · Link gültig bis ${esc(zeit(ablauf, zone))}</p>
<div class="zustand ${z.stufe}"><span class="symbol" aria-hidden="true">${z.symbol}</span><div><div class="gross">${esc(z.text)}</div>${z.grund ? `<div class="leise">${esc(z.grund)}${daten.befunde.length > 1 ? ` · insgesamt ${daten.befunde.length} Befunde` : ''}</div>` : ''}</div></div>
<div class="kacheln">${kacheln}</div>
<p class="leise">Nur für den Betreiber. Nicht weitergeben. Neuen Link: „EPA-14 Betrieb-Dashboard“ manuell starten (der alte wird gesperrt).</p>
</main></body></html>`;
}

/** Nachricht mit dem neuen Link (Telegram an den Betreiber). */
function linkNachricht({ link, ablauf, zone = 'Europe/Berlin' }) {
	return `<b>🔐 Neuer Link zum Betreiber-Dashboard</b><br><a href="${esc(link)}">Dashboard öffnen</a><br>Gültig bis ${esc(zeit(ablauf, zone))}. Alle früheren Dashboard-Links sind gesperrt. Nicht weitergeben.`;
}

module.exports = { BETREIBER, PFAD, LINK_TAGE, GRENZE_STUNDEN, DURCHLAUF_STATUS, EXCEPTION_STATUS, auswerten, kennzahlen, seite, linkNachricht, esc };
