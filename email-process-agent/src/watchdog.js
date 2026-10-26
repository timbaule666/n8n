'use strict';
// Watchdog (Masterprompt Workflow 6, Bauplan Phase F): prüft unabhängig vom Tagesgeschäft, ob das System arbeitet.
// Reine Auswertung; EPA-06 sammelt die Daten (Tabellen, Testaufrufe) und versendet das Ergebnis.
// Befunde enthalten nur IDs, Codes und Zählwerte, keine Mail-Inhalte und keine Kundendaten.

const SCHLUESSEL = 'watchdog';

// Grenzwerte in Stunden. Übergangsstatus müssen in Sekunden bis Minuten durchlaufen; hängt einer länger,
// ist eine Ausführung abgebrochen. Arbeitslisten (Mitarbeiter muss entscheiden) werden nur gezählt.
const GRENZEN = Object.freeze({
	cron_stunden: 3,
	uebergang_stunden: 1,
	arbeitsliste_stunden: 24,
	freigabe_stunden: 72,
	fehler_fenster_stunden: 24,
	max_einzeln: 20,
});
const UEBERGANG = Object.freeze(['Neu', 'In Prüfung', 'Lücken erkannt']);
const ARBEITSLISTE = Object.freeze(['Zuordnung unklar', 'Klassifizierung unklar', 'Eskaliert / Manuell', 'Bereit zur Bearbeitung']);

const EMPFEHLUNG = Object.freeze({
	CRON_NIE: 'EPA-04 veröffentlichen (Reihenfolge siehe Inbetriebnahme). Bis dahin gibt es keine Erinnerungen und keine Eskalation.',
	CRON_AUS: 'In n8n prüfen, ob EPA-04 veröffentlicht ist und die letzten Ausführungen erfolgreich waren. Hängt der Lauf-Lock (epa_system_status, Zeile epa04_lauf), gibt er sich nach 55 Minuten selbst frei.',
	VORGANG_HAENGT: 'Ausführung zum Vorgang in n8n ansehen (Fehlerlog/EPA-05). Den Vorgang danach manuell weiterführen oder auf "Eskaliert / Manuell" setzen.',
	FREIGABE_OFFEN: 'Der Freigeber bekommt automatisch einen neuen Link mit Eskalationshinweis (Teams-Chat, im nächsten Nachfass-Lauf in Geschäftszeit, danach höchstens alle 24 h). Wenn nötig Freigeber bzw. Vertretung direkt ansprechen; gesendet wird erst nach Freigabe.',
	ARBEITSLISTE: 'Diese Vorgänge warten auf eine Entscheidung eines Mitarbeiters.',
	STILLE: 'Postfach-Workflow (EPA-00-Kopie) prüfen: veröffentlicht, Outlook-Credential gültig, Mails im Posteingang? Bei echter Ruhe kann der Hinweis ignoriert werden.',
	VERBINDUNG_TEAMS: 'Teams-Credential (Dienstkonto) in n8n neu verbinden. Ohne Teams gehen keine Freigabe-Links und Meldungen raus.',
	VERBINDUNG_LLM: 'OpenAI-Credential bzw. Kontingent prüfen (401 = Schlüssel ungültig, 429 = Limit erreicht). Bis dahin werden neue Mails als Fehler gemeldet und nicht verloren.',
	VERBINDUNG_POSTFACH: 'Outlook-Credential der EPA-00-Kopie neu verbinden (Token abgelaufen oder Rechte entzogen). Bis dahin werden keine Mails abgeholt.',
	FEHLER_OHNE_ALARM: 'Fehlerlog (epa_fehler_log) ansehen: Diese Fehler konnten nicht nach Teams gemeldet werden.',
});

function ms(t) {
	if (t === null || t === undefined || t === '') return NaN;
	const x = new Date(t).getTime();
	return Number.isFinite(x) ? x : NaN;
}

function stundenSeit(t, jetzt) {
	const a = ms(t);
	return Number.isFinite(a) ? (ms(jetzt) - a) / 3600000 : null;
}

function befund(code, schwere, text, extra = {}) {
	return { code, schwere, text, empfehlung: EMPFEHLUNG[code] || '', ...extra };
}

/**
 * @param {object} p
 * @param {string} p.jetzt
 * @param {object|null} p.cron        Zeile epa04_lauf aus epa_system_status
 * @param {object[]} p.vorgaenge      offene Vorgänge (nicht Abgeschlossen/Ignoriert), mit updatedAt
 * @param {object} p.configs          kunde_id -> geprüfte Config (nur aktive)
 * @param {object} p.letzteMails      kunde_id -> Zeitpunkt der letzten eingegangenen Mail
 * @param {object[]} p.fehler         Zeilen aus epa_fehler_log (createdAt, alarmiert_am)
 * @param {object[]} p.verbindungen   [{ art: teams|llm|postfach, kunde_id?, ok, status, meldung }]
 * @param {object} p.fristen          Modul src/fristen.js
 */
function pruefen({ jetzt, cron, vorgaenge, configs, letzteMails, fehler, verbindungen, fristen, grenzen = GRENZEN }) {
	const g = { ...GRENZEN, ...grenzen };
	const befunde = [];

	// 1. Heartbeat des Cronjobs (EPA-04)
	if (!cron || (!cron.letzter_lauf && !cron.letzter_start)) {
		befunde.push(befund('CRON_NIE', 'warnung', 'EPA-04 (Nachfassen) ist noch nie gelaufen.'));
	} else {
		const h = stundenSeit(cron.letzter_lauf || cron.letzter_start, jetzt);
		if (h === null || h > g.cron_stunden) befunde.push(befund('CRON_AUS', 'alarm', `EPA-04 (Nachfassen) ist seit ${h === null ? '?' : Math.floor(h)} Stunden nicht mehr gelaufen.`));
	}

	// 2. Hängende Vorgänge
	const haengend = [];
	const liste = {};
	for (const v of vorgaenge || []) {
		const h = stundenSeit(v.updatedAt, jetzt);
		if (h === null) continue;
		if (UEBERGANG.includes(v.status) && h > g.uebergang_stunden) haengend.push({ v, h });
		else if (v.status === 'Freigabe ausstehend' && h > g.freigabe_stunden) {
			befunde.push(befund('FREIGABE_OFFEN', 'warnung', `Vorgang ${v.vorgangs_id} wartet seit ${Math.floor(h)} Stunden auf Freigabe.`, { kunde_id: v.kunde_id, vorgangs_id: v.vorgangs_id }));
		} else if (ARBEITSLISTE.includes(v.status) && h > g.arbeitsliste_stunden) {
			const k = `${v.kunde_id}|${v.status}`;
			liste[k] = (liste[k] || 0) + 1;
		}
	}
	haengend.sort((a, b) => b.h - a.h);
	for (const { v, h } of haengend.slice(0, g.max_einzeln)) {
		befunde.push(befund('VORGANG_HAENGT', 'alarm', `Vorgang ${v.vorgangs_id} hängt seit ${Math.floor(h)} Stunden im Status "${v.status}".`, { kunde_id: v.kunde_id, vorgangs_id: v.vorgangs_id }));
	}
	if (haengend.length > g.max_einzeln) befunde.push(befund('VORGANG_HAENGT', 'alarm', `… und ${haengend.length - g.max_einzeln} weitere hängende Vorgänge.`));
	for (const [k, n] of Object.entries(liste)) {
		const [kunde, status] = k.split('|');
		befunde.push(befund('ARBEITSLISTE', 'info', `${n} Vorgang/Vorgänge von ${kunde} seit über ${g.arbeitsliste_stunden} Stunden im Status "${status}".`, { kunde_id: kunde }));
	}

	// 3. Ungewöhnliche Stille im Postfach (nur in Geschäftszeit und nur, wenn konfiguriert)
	for (const [kunde, c] of Object.entries(configs || {})) {
		const stunden = Number(c && c.stille_alarm_stunden);
		if (!c || !(stunden > 0)) continue;
		const letzte = (letzteMails || {})[kunde];
		if (!Number.isFinite(ms(letzte))) continue;
		if (!fristen.istGeschaeftszeit(jetzt, c)) continue;
		const grenze = fristen.berechneFrist(new Date(ms(letzte)).toISOString(), stunden, { ...c, frist_nur_geschaeftszeit: true });
		if (ms(grenze) <= ms(jetzt)) {
			befunde.push(befund('STILLE', 'warnung', `Postfach von ${kunde}: seit ${Math.floor(stundenSeit(letzte, jetzt))} Stunden keine neue Mail (Grenze ${stunden} Geschäftsstunden).`, { kunde_id: kunde }));
		}
	}

	// 4. Verbindungen (aktive Testaufrufe)
	for (const t of verbindungen || []) {
		if (t.ok) continue;
		const code = { teams: 'VERBINDUNG_TEAMS', llm: 'VERBINDUNG_LLM', postfach: 'VERBINDUNG_POSTFACH' }[t.art] || 'VERBINDUNG_TEAMS';
		const wer = t.art === 'postfach' ? `Postfach von ${t.kunde_id}` : t.art === 'llm' ? 'KI-Anbieter (OpenAI)' : t.kunde_id ? `Microsoft Teams von ${t.kunde_id}` : 'Microsoft Teams';
		befunde.push(befund(code, 'alarm', `${wer} nicht erreichbar${t.status ? ` (HTTP ${t.status})` : ''}${t.meldung ? `: ${String(t.meldung).slice(0, 160)}` : ''}.`, t.kunde_id ? { kunde_id: t.kunde_id } : {}));
	}

	// 5. Fehler, die nicht gemeldet werden konnten
	const fenster = (fehler || []).filter((f) => {
		const h = stundenSeit(f.createdAt, jetzt);
		return h !== null && h <= g.fehler_fenster_stunden;
	});
	const ohneAlarm = fenster.filter((f) => !f.alarmiert_am).length;
	if (ohneAlarm) befunde.push(befund('FEHLER_OHNE_ALARM', 'warnung', `${ohneAlarm} von ${fenster.length} Fehler(n) der letzten ${g.fehler_fenster_stunden} Stunden wurden nicht nach Teams gemeldet.`));

	const alarm = befunde.some((b) => b.schwere === 'alarm');
	const warnung = befunde.some((b) => b.schwere === 'warnung');
	return {
		gesamt: alarm ? 'alarm' : warnung ? 'warnung' : 'ok',
		befunde,
		zaehler: {
			offene_vorgaenge: (vorgaenge || []).length,
			fehler_24h: fenster.length,
			verbindungen_geprueft: (verbindungen || []).length,
		},
	};
}

/** Täglicher "Alles in Ordnung"-Heartbeat: einmal je Kalendertag (Zeitzone) bzw. immer bei Befunden. */
function meldenNoetig(ergebnis, letzteOkMeldung, jetzt, zeitzone, DT) {
	if (ergebnis.gesamt !== 'ok') return true;
	if (!letzteOkMeldung) return true;
	const tag = (t) => DT.fromISO(new Date(ms(t)).toISOString()).setZone(zeitzone).toISODate();
	return tag(letzteOkMeldung) !== tag(jetzt);
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Teams-Nachricht an den Entwickler-/Betriebskanal. */
function nachricht(ergebnis, zeitText) {
	const kopf = { ok: '✅ EPA Watchdog: Alles in Ordnung', warnung: '⚠️ EPA Watchdog: Hinweise', alarm: '🚨 EPA Watchdog: Handlungsbedarf' }[ergebnis.gesamt];
	const z = ergebnis.zaehler;
	const fuss = `<br><i>${esc(zeitText)} · offene Vorgänge: ${z.offene_vorgaenge} · Fehler (24 h): ${z.fehler_24h} · Verbindungstests: ${z.verbindungen_geprueft}</i>`;
	if (!ergebnis.befunde.length) return `<b>${kopf}</b>${fuss}`;
	const reihen = ['alarm', 'warnung', 'info'].flatMap((s) => ergebnis.befunde.filter((b) => b.schwere === s));
	const empfohlen = new Set();
	const li = reihen.map((b) => {
		const e = b.empfehlung && !empfohlen.has(b.code) ? `<br><i>→ ${esc(b.empfehlung)}</i>` : '';
		empfohlen.add(b.code);
		return `<li>${b.schwere === 'alarm' ? '<b>Alarm:</b> ' : b.schwere === 'warnung' ? 'Warnung: ' : 'Info: '}${esc(b.text)}${e}</li>`;
	}).join('');
	return `<b>${kopf}</b><ul>${li}</ul>${fuss}`;
}

module.exports = { SCHLUESSEL, GRENZEN, UEBERGANG, ARBEITSLISTE, EMPFEHLUNG, pruefen, meldenNoetig, nachricht };
