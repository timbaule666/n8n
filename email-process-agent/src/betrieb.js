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
	// Jeder Befund: Kurztext (Zustand, Liste) und Einzelheiten für die aufklappbare Fehlerliste im Dashboard.
	const melden = (stufe, text, d = {}) => befunde.push({
		stufe, text, titel: d.titel || text, kunde: d.kunde || null, was: d.was || text, seit: d.seit || null,
		folge: d.folge || '', tun: d.tun || '', betroffen: d.betroffen || [],
	});
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
		if (!k.config_ok) melden('kritisch', `${n}: Config ungültig – der Agent arbeitet für diesen Kunden nicht vollständig`, {
			titel: 'Config ungültig', kunde: n,
			was: 'Die Einstellungen dieses Kunden (epa_config_allgemein bzw. Pflichtfelder) sind unvollständig oder fehlerhaft.',
			folge: 'Nachfassen, Zustelltest und Tagesübersicht laufen für diesen Kunden nicht.',
			tun: 'In n8n „EPA SW Config laden“ mit der kunde_id ausführen; die Fehlermeldung nennt das Feld. Danach die Config korrigieren.',
		});
		if (k.outlook.ok === false) melden('kritisch', `${n}: Outlook-Postfach nicht erreichbar – Credential in n8n neu verbinden, bis dahin werden keine Mails abgeholt`, {
			titel: 'Outlook-Postfach nicht erreichbar', kunde: n, seit: k.outlook.am,
			was: `Microsoft lehnt die Anmeldung am Postfach ${k.postfach || n} ab (Zugang abgelaufen oder Rechte entzogen).`,
			folge: 'Neue Mails werden nicht abgeholt, Rückfragen können nicht gesendet werden.',
			tun: 'n8n → Credentials → Outlook-Credential dieses Kunden öffnen → „Reconnect“ und mit dem Postfach-Konto anmelden.',
		});
		if (k.teams.ok === false) melden('kritisch', `${n}: Teams nicht erreichbar – Credential neu verbinden, bis dahin gehen keine Freigabe-Links und Meldungen raus`, {
			titel: 'Teams nicht erreichbar', kunde: n, seit: k.teams.am,
			was: 'Die Verbindung zu Microsoft Teams dieses Kunden ist fehlgeschlagen.',
			folge: 'Freigabe-Links und Meldungen im Kanal kommen nicht an.',
			tun: 'n8n → Credentials → Teams-Credential dieses Kunden → „Reconnect“ mit demselben Konto wie das Postfach.',
		});
		if (k.ki.ok === false) melden('kritisch', `${n}: KI nicht erreichbar – Schlüssel bzw. Guthaben prüfen`, {
			titel: 'KI nicht erreichbar', kunde: n, seit: k.ki.am,
			was: 'Der KI-Anbieter (OpenAI) hat nicht geantwortet oder den Zugang abgelehnt.',
			folge: 'Neue Mails werden nicht ausgelesen; sie gehen nicht verloren und werden als Fehler gemeldet.',
			tun: 'OpenAI-Konto prüfen: Schlüssel gültig, Guthaben bzw. Limit ausreichend; Credential in n8n.',
		});
		if (k.versand.ok === false) melden('kritisch', `${n}: letzter Zustelltest fehlgeschlagen (${k.versand.art || 'unbekannt'}) – Mails kommen evtl. nicht an`, {
			titel: 'Zustelltest fehlgeschlagen', kunde: n, seit: k.versand.am,
			was: k.versand.art === 'versand_abgelehnt' ? 'Microsoft hat den Versand der täglichen Testmail abgelehnt.' : 'Die tägliche Testmail wurde als gesendet gemeldet, kam aber nicht im Prüfpostfach an.',
			folge: 'Rückfragen und Erinnerungen erreichen die Kunden vermutlich nicht.',
			tun: 'Im Postfach nach Unzustellbarkeitsmeldungen sehen. Bei „550 5.7.708“: eigene Domain mit SPF, DKIM und DMARC einrichten. Nach der Behebung „EPA-11 Zustelltest“ manuell starten.',
		});
		else if (k.versand.ok === null) melden('warnung', `${n}: noch kein Zustelltest gelaufen`);
		else if (stundenSeit(k.versand.am, jetzt) > GRENZE_STUNDEN.zustelltest) melden('warnung', `${n}: Zustelltest seit über ${GRENZE_STUNDEN.zustelltest} h nicht gelaufen`);
		if (k.haengend.length) melden('warnung', `${n}: ${k.haengend.length} Vorgang/Vorgänge hängen seit über ${GRENZE_STUNDEN.haengt} h (${liste(k.haengend)})`, {
			titel: 'Vorgänge hängen', kunde: n,
			was: `${k.haengend.length} Vorgang/Vorgänge stehen seit über ${GRENZE_STUNDEN.haengt} h in „Neu“, „In Prüfung“ oder „Lücken erkannt“; die Verarbeitung ist abgebrochen.`,
			folge: 'Der Kunde bekommt keine Rückfrage, die Anfrage bleibt liegen.',
			tun: 'Fehlerlog bzw. Ausführung zum Vorgang in n8n ansehen. Vorgang danach manuell weiterführen oder auf „Eskaliert / Manuell“ setzen.',
			betroffen: k.haengend,
		});
		if (k.versandfehler) melden('kritisch', `${n}: ${k.versandfehler} Nachricht(en) nach Freigabe nicht gesendet`, {
			titel: 'Nachricht nach Freigabe nicht gesendet', kunde: n,
			was: `${k.versandfehler} freigegebene Nachricht(en) konnten nicht gesendet werden (Freigabe-Status „fehler“).`,
			folge: 'Der Kunde hat die Rückfrage nicht bekommen.',
			tun: 'Grund steht in epa_freigaben (Spalte grund). Ist das Postfach wieder erreichbar, kommt die Nachricht automatisch mit neuem Link erneut zur Freigabe.',
			betroffen: (freigaben || []).filter((f) => f && f.kunde_id === c.kunde_id && f.status === 'fehler').map((f) => f.vorgangs_id),
		});
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
	if (!laeufe.nachfassen.ok) melden('kritisch', `Nachfassen (EPA-04) seit über ${GRENZE_STUNDEN.nachfassen} h nicht gelaufen – Erinnerungen, Eskalationen und neue Freigabe-Links stehen`, {
		titel: 'Nachfassen läuft nicht', seit: laeufe.nachfassen.am,
		was: `Der stündliche Ablauf „EPA-04 Nachfassen“ ist seit über ${GRENZE_STUNDEN.nachfassen} h nicht gelaufen.`,
		folge: 'Erinnerungen, Eskalationen, neue Freigabe-Links und das Erkennen direkt gesendeter Mails stehen still.',
		tun: 'In n8n prüfen, ob EPA-04 veröffentlicht ist und die letzte Ausführung fehlerfrei war; Lauf-Lock in epa_system_status (Zeile epa04_lauf) prüfen.',
	});
	if (!laeufe.watchdog.ok) melden('kritisch', `Watchdog (EPA-06) seit über ${GRENZE_STUNDEN.watchdog} h nicht gelaufen – Verbindungen werden nicht geprüft`, {
		titel: 'Watchdog läuft nicht', seit: laeufe.watchdog.am,
		was: `Der Systemwächter „EPA-06 Watchdog“ ist seit über ${GRENZE_STUNDEN.watchdog} h nicht gelaufen.`,
		folge: 'Verbindungen zu Outlook, Teams und KI werden nicht mehr geprüft; Ausfälle fallen später auf.',
		tun: 'In n8n prüfen, ob EPA-06 veröffentlicht ist und die letzte Ausführung fehlerfrei war.',
	});

	// ---- Fehler und Alarmweg
	const ohneAlarm = fl.filter((f) => !f.alarmiert_am);
	const letzte24 = fl.filter((f) => stundenSeit(f.createdAt, jetzt) <= 24);
	const alarmweg = laeufe.alarm_kanal === 'telegram_test' ? 'Telegram' : 'Teams';
	if (ohneAlarm.length) melden('kritisch', `${ohneAlarm.length} Fehler ohne zugestellten Alarm – Alarmweg (${alarmweg}) prüfen`, {
		titel: 'Fehler ohne zugestellten Alarm', seit: ohneAlarm[ohneAlarm.length - 1].createdAt,
		was: `Zu ${ohneAlarm.length} Fehler(n) ging kein Alarm an dich raus.`,
		folge: 'Du erfährst von diesen Fehlern nur hier im Dashboard.',
		tun: `Alarmweg (${alarmweg}) prüfen. Ist ein Fehler erledigt, in epa_fehler_log bei diesem Eintrag alarmiert_am setzen.`,
		betroffen: ohneAlarm.slice(0, MAX_FEHLER).map((f) => `${new Date(ms(f.createdAt)).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${f.workflow_name || f.workflow_id || '?'}${f.vorgangs_id ? ' · ' + f.vorgangs_id : ''}: ${String(f.meldung || '').slice(0, 160)}`),
	});
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
		{ ok: !unberechtigt.length, text: unberechtigt.length ? `Freigabe durch nicht eingetragene Person: ${liste(unberechtigt.map((f) => f.vorgangs_id))}` : 'Alle Freigaben der letzten 7 Tage kamen von eingetragenen Freigebern',
			titel: 'Freigabe durch nicht eingetragene Person',
			was: 'Rückfragen wurden von Personen freigegeben, die (nicht mehr) als Freigeber des Kunden eingetragen sind.',
			folge: 'Möglicherweise wurde ein Freigabe-Link weitergegeben.',
			tun: 'In epa_freigaben (Spalte entscheider) nachsehen, wer freigegeben hat. Wurde nur die Freigeber-Liste geändert, ist es unkritisch (die Meldung verschwindet nach 7 Tagen); sonst die Weitergabe klären.',
			betroffen: unberechtigt.map((f) => `${f.vorgangs_id} · ${f.kunde_id} · freigegeben von ${f.entscheider}`) },
		{ ok: !direkt.length, stufe: 'warnung', text: direkt.length ? `An der Freigabe vorbei direkt in Outlook gesendet (7 Tage): ${liste(direkt.map((f) => f.vorgangs_id))}` : 'Keine Mail an der Freigabe vorbei gesendet (7 Tage)' },
		{ ok: !spoofing.length, stufe: 'warnung', text: spoofing.length ? `Verdacht auf gefälschten Absender in offenen Vorgängen: ${liste(spoofing.map((v) => v.vorgangs_id))}` : 'Kein Verdacht auf gefälschte Absender in offenen Vorgängen' },
		{ ok: betreiberLinks.length <= 1, text: betreiberLinks.length <= 1 ? 'Höchstens ein gültiger Dashboard-Link' : `${betreiberLinks.length} gültige Dashboard-Links – EPA-14 manuell starten, um alle bis auf einen neuen zu sperren`,
			titel: 'Mehrere gültige Dashboard-Links',
			was: `Es gibt ${betreiberLinks.length} gültige Links zu diesem Dashboard.`,
			folge: 'Ein alter, evtl. weitergegebener Link zeigt weiterhin alle Kunden.',
			tun: '„EPA-14 Betrieb-Dashboard“ manuell starten: alle alten Links werden gesperrt, der neue kommt per Telegram.' },
		{ ok: !neuster || (ms(neuster.ablauf) - ms(jetzt)) / 86400000 > LINK_WARNUNG_TAGE, stufe: 'warnung', text: neuster ? 'Dashboard-Link gültig bis %ABLAUF%' : 'Kein gültiger Dashboard-Link', ablauf: neuster ? neuster.ablauf : null },
		{ ok: laeufe.loeschjob.ok, stufe: 'warnung', text: laeufe.loeschjob.ok ? 'Löschjob läuft – Daten werden nach Ablauf der Aufbewahrung gelöscht' : 'Löschjob (EPA-08) läuft nicht – Daten werden nicht nach Ablauf der Aufbewahrung gelöscht' },
		{ ok: true, info: true, text: `${kundenLinks} gültige Kunden-Übersichtslink(s) (je Tagesübersicht ein neuer, 30 Tage gültig)` },
	];
	for (const s of sicherheit) {
		if (s.ok || s.info) continue;
		melden(s.stufe || 'kritisch', `Sicherheit: ${s.ablauf ? 'Dashboard-Link läuft bald ab – EPA-14 manuell starten' : s.text}`, {
			titel: s.titel ? `Sicherheit: ${s.titel}` : null, was: s.was, folge: s.folge, tun: s.tun, betroffen: s.betroffen,
		});
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




// ---------------------------------------------------------------- Agent-Status pro Kunde

// Ergebnisse in epa_verarbeitete_mails, bei denen ein Mitarbeiter entscheiden muss ("Exception").
const EXCEPTION_ERGEBNIS = Object.freeze(['zuordnung_unklar', 'klassifizierung_unklar', 'unzustellbar', 'extraktion_fehlgeschlagen']);
// Warnung: so viele Exceptions heute (oder mehr als dieser Anteil) bzw. so lange keine Mail verarbeitet.
const AGENT_GRENZEN = Object.freeze({ exceptions: 3, exceptionAnteil: 0.25, ruheStunden: 48 });
const AGENT_STUFE = Object.freeze({
	kritisch: { symbol: '🔴', text: 'Critical' },
	warnung: { symbol: '🟡', text: 'Warning' },
	ok: { symbol: '🟢', text: 'Healthy' },
});

function istException(m) {
	const e = String(m.ergebnis || '');
	return EXCEPTION_ERGEBNIS.some((x) => e === x || e.endsWith('_' + x));
}

/**
 * Eine Zeile je aktivem Agent (Postfach-Verbindung eines Kunden): Ampel, letzter Lauf und Zahlen von heute.
 * daten = Ergebnis von auswerten(); mails = epa_verarbeitete_mails der letzten 7 Tage.
 * Critical: Verbindung/Config/Versand gestört, Watchdog-Befund oder technische Fehler heute.
 * Warning: viele Exceptions, hängende Vorgänge, lange keine Mail oder Zustelltest fehlt/veraltet.
 */
function agentStatus({ daten, mails, heuteAb, jetzt }) {
	const ab = ms(heuteAb);
	const stufen = ['ok', 'warnung', 'kritisch'];
	const zeilen = daten.kunden.map((k) => {
		const eigene = (mails || []).filter((m) => m && m.kunde_id === k.kunde_id && Number.isFinite(ms(m.createdAt)));
		const heute = eigene.filter((m) => ms(m.createdAt) >= ab);
		const fertig = heute.filter((m) => m.status === 'fertig');
		const exceptions = fertig.filter(istException).length;
		const fehler = heute.filter((m) => m.status === 'fehler').length;
		let lauf = NaN;
		for (const m of eigene) { const t = ms(m.updatedAt || m.createdAt); if (Number.isFinite(t) && !(t <= lauf)) lauf = t; }
		const letzterLauf = Number.isFinite(lauf) ? new Date(lauf).toISOString() : k.letzte_mail;
		const gruende = { kritisch: [], warnung: [] };
		if (!k.config_ok) gruende.kritisch.push('Config ungültig');
		if (k.outlook.ok === false) gruende.kritisch.push('Outlook-Anmeldung fehlgeschlagen');
		if (k.teams.ok === false) gruende.kritisch.push('Teams nicht erreichbar');
		if (k.ki.ok === false) gruende.kritisch.push('KI nicht erreichbar');
		if (k.versand.ok === false) gruende.kritisch.push('Zustelltest fehlgeschlagen');
		if (k.versandfehler) gruende.kritisch.push(`${k.versandfehler} Versandfehler`);
		if (fehler) gruende.kritisch.push(`${fehler} Fehler heute`);
		if (exceptions >= AGENT_GRENZEN.exceptions || (fertig.length >= 4 && exceptions / fertig.length > AGENT_GRENZEN.exceptionAnteil)) gruende.warnung.push(`${exceptions} Exceptions heute`);
		if (k.haengend.length) gruende.warnung.push(`${k.haengend.length} Vorgang/Vorgänge hängen`);
		if (stundenSeit(letzterLauf, jetzt) > AGENT_GRENZEN.ruheStunden) gruende.warnung.push(letzterLauf ? `seit über ${AGENT_GRENZEN.ruheStunden} h keine Mail` : 'noch keine Mail verarbeitet');
		if (k.versand.ok === null) gruende.warnung.push('noch kein Zustelltest');
		else if (k.versand.ok === true && stundenSeit(k.versand.am, jetzt) > GRENZE_STUNDEN.zustelltest) gruende.warnung.push('Zustelltest veraltet');
		const stufe = gruende.kritisch.length ? 'kritisch' : gruende.warnung.length ? 'warnung' : 'ok';
		return {
			kunde_id: k.kunde_id,
			agent: 'E-Mail-Agent',
			postfach: k.postfach,
			stufe,
			...AGENT_STUFE[stufe],
			grund: [...gruende.kritisch, ...gruende.warnung].join(' · '),
			letzter_lauf: letzterLauf || null,
			heute: heute.length,
			erfolgreich: fertig.length - exceptions,
			exceptions,
			fehler,
		};
	});
	return zeilen.sort((a, b) => stufen.indexOf(b.stufe) - stufen.indexOf(a.stufe) || String(a.kunde_id).localeCompare(String(b.kunde_id)));
}

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
function kennzahlen({ daten, configs, vorgaenge, mails, heuteAb, agenten }) {
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
	// Technische Fehler heute ohne eigenen kritischen Befund des Kunden: zusätzlich als kritischer Fehler zählen,
	// damit Ampel der Tabelle, Gesamtzustand und Fehlerliste übereinstimmen.
	for (const a of agenten || []) {
		if (!a.fehler || kritisch.some((b) => b.kunde === a.kunde_id)) continue;
		kritisch.push({
			stufe: 'kritisch', text: `${a.kunde_id}: ${a.fehler} Mail(s) heute mit technischem Fehler abgebrochen`, titel: 'Verarbeitung mit Fehler abgebrochen', kunde: a.kunde_id,
			was: `${a.fehler} eingegangene Mail(s) wurden heute nicht fertig verarbeitet (epa_verarbeitete_mails, Status „fehler“).`,
			folge: 'Zu diesen Mails gibt es evtl. keinen Vorgang und keine Rückfrage.',
			tun: 'In n8n die fehlgeschlagenen Ausführungen von „EPA-01“ bzw. dem Postfach-Workflow des Kunden ansehen; Ursache beheben. Die Mails liegen weiter im Postfach.',
			betroffen: [],
		});
	}
	// Agents mit Problemen: Ampel aus agentStatus() (sonst: Verbindung, Versand, hängende Vorgänge, ungültige Config oder offene Exceptions).
	const aufmerksamkeit = agenten
		? agenten.filter((a) => a.stufe !== 'ok').length
		: daten.kunden.filter((k) => !k.config_ok || k.outlook.ok === false || k.teams.ok === false || k.ki.ok === false
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
		kritisch_liste: kritisch,
		zustand,
	};
}

// Kennzahl-Kacheln: große Zahl, Beschriftung darunter. Blau für Zahlen, Rot nur bei Problemen (mit Text).
const KOPF_STIL = `.kacheln{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}
.kachel{border:1px solid var(--linie);border-radius:12px;padding:16px}.kachel .zahl{font-size:clamp(1.7rem,3.2vw,2.2rem);white-space:nowrap;font-weight:700;line-height:1.1;color:var(--blau);font-variant-numeric:tabular-nums}
.kachel .name{color:var(--text-secondary);margin-top:4px}.kachel.alarm .zahl{color:var(--critical)}
.zustand{display:flex;gap:14px;align-items:center;border:1px solid var(--linie);border-left:8px solid var(--s);border-radius:12px;padding:18px}
.zustand .gross{font-size:1.5rem;font-weight:700}.zustand .symbol{font-size:2rem;line-height:1}
a.kachel{color:inherit;text-decoration:none;display:block}a.kachel:hover,a.kachel:focus{border-color:var(--blau);outline:none}.kachel .mehr{color:var(--blau);font-size:.85rem;margin-top:6px}
.fehlerliste{display:none;border:1px solid var(--linie);border-radius:12px;padding:16px;margin:0 0 16px}.fehlerliste:target{display:block}
.fehlerliste .kopf{display:flex;justify-content:space-between;align-items:baseline;gap:12px}.fehlerliste h2{font-size:1.15rem;margin:0}
.fehler{border:1px solid var(--linie);border-left:6px solid var(--critical);border-radius:10px;margin:10px 0}
.fehler summary{cursor:pointer;padding:12px 14px;list-style:none}.fehler summary::-webkit-details-marker{display:none}
.fehler summary::before{content:'▸';color:var(--blau);margin-right:8px}.fehler[open] summary::before{content:'▾'}
.fehler summary b{font-size:1.05rem}.fehler .inhalt{padding:0 14px 14px 32px}
.fehler dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0}.fehler dt{color:var(--text-secondary)}.fehler dd{margin:0;overflow-wrap:anywhere}
.fehler ul{margin:0;padding-left:18px}
h2.abschnitt{font-size:1.15rem;margin:24px 0 8px}.tabelle{overflow-x:auto;border:1px solid var(--linie);border-radius:12px}
table.agenten{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.agenten th,.agenten td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--linie);vertical-align:top}
.agenten th{color:var(--text-secondary);font-weight:600;font-size:.85rem;white-space:nowrap}.agenten tr:last-child td{border-bottom:0}
.agenten td.n{text-align:right;color:var(--blau);font-weight:600}.agenten th.n{text-align:right}.agenten td.n.rot{color:var(--critical)}
.agenten .ampel,.agenten td:first-child{white-space:nowrap}.agenten .ampel{font-weight:600}.agenten tr.kritisch td:first-child{box-shadow:inset 4px 0 0 var(--critical)}
.agenten tr.warnung td:first-child{box-shadow:inset 4px 0 0 var(--warning)}`;

function zahlText(n) {
	return Number(n).toLocaleString('de-DE');
}

function uhrzeit(iso, jetzt, zone) {
	if (!iso || !Number.isFinite(ms(iso))) return '–';
	try {
		const tag = (t) => new Date(t).toLocaleDateString('de-DE', { timeZone: zone });
		const uhr = new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: zone });
		return tag(iso) === tag(jetzt) ? uhr : `${new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', timeZone: zone })} ${uhr}`;
	} catch (e) { return iso; }
}

function agentTabelle(agenten, jetzt, zone) {
	if (!agenten || !agenten.length) return '<h2 class="abschnitt">Agent-Status pro Kunde</h2><p class="leise">Kein aktiver Kunde.</p>';
	const zeilen = agenten.map((a) => `<tr class="${a.stufe}"><td><b>${esc(a.kunde_id)}</b></td><td>${esc(a.agent)}${a.postfach ? `<div class="leise">${esc(a.postfach)}</div>` : ''}</td>
<td><span class="ampel">${a.symbol} ${esc(a.text)}</span>${a.grund ? `<div class="leise">${esc(a.grund)}</div>` : ''}</td><td>${esc(uhrzeit(a.letzter_lauf, jetzt, zone))}</td>
<td class="n">${zahlText(a.heute)}</td><td class="n">${zahlText(a.erfolgreich)}</td><td class="n">${zahlText(a.exceptions)}</td><td class="n${a.fehler ? ' rot' : ''}">${zahlText(a.fehler)}</td></tr>`).join('');
	return `<h2 class="abschnitt">Agent-Status pro Kunde</h2><div class="tabelle"><table class="agenten"><thead><tr><th>Kunde</th><th>Agent</th><th>Status</th><th>Letzter Lauf</th><th class="n">Heute</th><th class="n">Erfolgreich</th><th class="n">Exceptions</th><th class="n">Fehler</th></tr></thead><tbody>${zeilen}</tbody></table></div>
<p class="leise">🟢 Healthy: läuft normal · 🟡 Warning: viele Exceptions, hängende Vorgänge, lange keine Mail oder Zustelltest fehlt · 🔴 Critical: Verbindungs-, Credential-, Versand- oder Workflow-Fehler. Zahlen: heute verarbeitete Mails.</p>`;
}

function seite({ daten, kopf, agenten, jetzt, zone = 'Europe/Berlin', ablauf }) {
	const k = kopf;
	const quote = k.erfolgsquote === null ? '–' : `${k.erfolgsquote.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
	const kachel = (zahl, name, alarm, titel, ziel) => {
		const inhalt = `<div class="zahl">${esc(zahl)}</div><div class="name">${esc(name)}</div>${ziel ? '<div class="mehr">Liste anzeigen ▾</div>' : ''}`;
		const attr = `class="kachel${alarm ? ' alarm' : ''}"${titel ? ` title="${esc(titel)}"` : ''}`;
		return ziel ? `<a ${attr} href="#${ziel}">${inhalt}</a>` : `<div ${attr}>${inhalt}</div>`;
	};
	const kacheln = [
		kachel(zahlText(k.kunden), k.kunden === 1 ? 'Aktiver Kunde' : 'Aktive Kunden'),
		kachel(zahlText(k.agents), k.agents === 1 ? 'Aktiver Agent' : 'Aktive Agents', false, 'Agent = aktive Postfach-Verbindung eines Kunden'),
		kachel(zahlText(k.vorgaenge_heute), 'Vorgänge heute'),
		kachel(quote, 'Erfolgsquote heute', k.erfolgsquote !== null && k.erfolgsquote < 95, `${k.verarbeitet_heute} ${k.verarbeitet_heute === 1 ? 'Mail' : 'Mails'} heute verarbeitet; Anteil ohne technischen Fehler`),
		kachel(zahlText(k.exceptions), k.exceptions === 1 ? 'Offene Exception' : 'Offene Exceptions', false, 'Vorgänge, die eine Entscheidung eines Mitarbeiters brauchen'),
		kachel(zahlText(k.kritisch), k.kritisch === 1 ? 'Kritischer Fehler' : 'Kritische Fehler', k.kritisch > 0, null, k.kritisch > 0 ? 'kritisch' : null),
	].join('');
	// Liste der kritischen Fehler: öffnet sich per Klick auf die Kachel (Sprungziel, ohne JavaScript);
	// jeder Fehler klappt einzeln auf.
	const kritisch = k.kritisch_liste || daten.befunde.filter((b) => b.stufe === 'kritisch');
	const zeile = (name, wert) => (wert ? `<dt>${esc(name)}</dt><dd>${wert}</dd>` : '');
	const fehlerliste = kritisch.length ? `<section id="kritisch" class="fehlerliste"><div class="kopf"><h2>Kritische Fehler (${kritisch.length})</h2><a href="#">Schließen</a></div>
<p class="leise">Auf einen Fehler klicken, um die Einzelheiten zu sehen.</p>
${kritisch.map((b) => `<details class="fehler"><summary><b>${esc(b.titel)}</b>${b.kunde ? ` <span class="leise">· ${esc(b.kunde)}</span>` : ''}${b.seit ? ` <span class="leise">· seit ${esc(zeit(b.seit, zone))}</span>` : ''}</summary>
<div class="inhalt"><dl>${zeile('Was ist passiert', esc(b.was))}${zeile('Kunde', b.kunde ? esc(b.kunde) : '')}${zeile('Seit', b.seit ? esc(zeit(b.seit, zone)) : '')}${zeile('Folge', esc(b.folge))}${zeile('Was tun', esc(b.tun))}${zeile('Betroffen', b.betroffen && b.betroffen.length ? `<ul>${b.betroffen.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '')}</dl></div></details>`).join('')}
</section>` : '';
	const z = k.zustand;
	return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="300"><title>Betrieb</title><style>${STIL}
${KOPF_STIL}</style></head><body><main>
<h1>Betrieb Email Process Agent</h1><p class="leise">Stand ${esc(zeit(jetzt, zone))} · lädt alle 5 Minuten neu · Link gültig bis ${esc(zeit(ablauf, zone))}</p>
<div class="zustand ${z.stufe}"><span class="symbol" aria-hidden="true">${z.symbol}</span><div><div class="gross">${esc(z.text)}</div>${z.grund ? `<div class="leise">${esc(z.grund)}${daten.befunde.length > 1 ? ` · insgesamt ${daten.befunde.length} Befunde` : ''}</div>` : ''}</div></div>
<div class="kacheln">${kacheln}</div>
${fehlerliste}
${agentTabelle(agenten, jetzt, zone)}
<p class="leise">Nur für den Betreiber. Nicht weitergeben. Neuen Link: „EPA-14 Betrieb-Dashboard“ manuell starten (der alte wird gesperrt).</p>
</main></body></html>`;
}

/** Nachricht mit dem neuen Link (Telegram an den Betreiber). */
function linkNachricht({ link, ablauf, zone = 'Europe/Berlin' }) {
	return `<b>🔐 Neuer Link zum Betreiber-Dashboard</b><br><a href="${esc(link)}">Dashboard öffnen</a><br>Gültig bis ${esc(zeit(ablauf, zone))}. Alle früheren Dashboard-Links sind gesperrt. Nicht weitergeben.`;
}

module.exports = { BETREIBER, PFAD, LINK_TAGE, GRENZE_STUNDEN, DURCHLAUF_STATUS, EXCEPTION_STATUS, EXCEPTION_ERGEBNIS, AGENT_GRENZEN, auswerten, agentStatus, kennzahlen, seite, linkNachricht, esc };
