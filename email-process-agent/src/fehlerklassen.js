'use strict';
// Fehlerklassen und Statuscode-Mapping (Masterprompt 3, Bauplan 3).
// EPA-Fehler werden als Text "[EPA:<status>:<CODE>:<Vorgangs-ID|->] <Meldung>" geworfen,
// damit der Error-Handler (EPA-05) sie aus execution.error.message zurücklesen kann.

const FEHLERCODES = Object.freeze({
	UNGUELTIGES_FORMAT: { status: 400, klasse: 'Eingabe', retrybar: false },
	UNGUELTIGER_AUSLOESER: { status: 400, klasse: 'Eingabe', retrybar: false },
	UNBEKANNTER_STATUS: { status: 400, klasse: 'Eingabe', retrybar: false },
	AUTH_FEHLER: { status: 401, klasse: 'Authentifizierung', retrybar: false },
	KEINE_BERECHTIGUNG: { status: 403, klasse: 'Authentifizierung', retrybar: false },
	VORGANG_NICHT_GEFUNDEN: { status: 404, klasse: 'Nicht gefunden', retrybar: false },
	KONFIG_NICHT_GEFUNDEN: { status: 404, klasse: 'Konfiguration', retrybar: false },
	NICHT_GEFUNDEN: { status: 404, klasse: 'Nicht gefunden', retrybar: false },
	DUPLIKAT: { status: 409, klasse: 'Konflikt', retrybar: false },
	UNZULAESSIGER_STATUSWECHSEL: { status: 409, klasse: 'Konflikt', retrybar: false },
	UNZULAESSIGER_AUSLOESER: { status: 409, klasse: 'Konflikt', retrybar: false },
	VERSIONSKONFLIKT: { status: 409, klasse: 'Konflikt', retrybar: true },
	GESPERRT: { status: 409, klasse: 'Konflikt', retrybar: true },
	KONFIG_MEHRDEUTIG: { status: 409, klasse: 'Konfiguration', retrybar: false },
	FREIGABE_ABGELAUFEN: { status: 410, klasse: 'Freigabe', retrybar: false },
	EXTRAKTION_UNGUELTIG: { status: 422, klasse: 'LLM', retrybar: false },
	KONFIGURATIONSFEHLER: { status: 424, klasse: 'Konfiguration', retrybar: false },
	RATE_LIMIT: { status: 429, klasse: 'Upstream', retrybar: true },
	UPSTREAM_FEHLER: { status: 502, klasse: 'Upstream', retrybar: true },
	NICHT_ERREICHBAR: { status: 503, klasse: 'Upstream', retrybar: true },
	ZEITUEBERSCHREITUNG: { status: 504, klasse: 'Upstream', retrybar: true },
	UNBEKANNT: { status: 500, klasse: 'Unbekannt', retrybar: false },
});

// Bei diesen Codes bearbeitet eine andere Ausführung den Vorgang bzw. die Mail ist schon verarbeitet:
// der Vorgang wird NICHT auf "Eskaliert / Manuell" gesetzt (sonst würde ein Parallellauf gestört).
const OHNE_ESKALATION = Object.freeze(['VERSIONSKONFLIKT', 'GESPERRT', 'DUPLIKAT']);

// Fehler aus diesen Workflows werden gemeldet, aber nicht durch "Vorgang sichern" eskaliert: EPA-05 sichert Vorgänge
// selbst über "EPA SW Status setzen". Schlüge das fehl und würde erneut gesichert, entstünde eine Fehlerschleife.
const OHNE_SICHERUNG_AUS = Object.freeze(['EPA SW Status setzen']);

const EPA_MUSTER = /^\[EPA:(\d{3}):([A-Z_]+):([^\]]*)\]\s*([\s\S]*)$/;

function formatEpaFehler(code, vorgangsId, meldung) {
	const def = FEHLERCODES[code] || FEHLERCODES.UNBEKANNT;
	return `[EPA:${def.status}:${FEHLERCODES[code] ? code : 'UNBEKANNT'}:${vorgangsId || '-'}] ${meldung || ''}`.trim();
}

/** Wirft einen EPA-Fehler (für Code-Nodes). */
function epaFehler(code, vorgangsId, meldung) {
	const err = new Error(formatEpaFehler(code, vorgangsId, meldung));
	err.epaCode = code;
	return err;
}

function parseEpaFehler(text) {
	if (typeof text !== 'string') return null;
	// n8n stellt der Meldung manchmal Präfixe voran; das Muster darf irgendwo in der ersten Zeile beginnen.
	const start = text.indexOf('[EPA:');
	if (start < 0) return null;
	const m = text.slice(start).match(EPA_MUSTER);
	if (!m) return null;
	return {
		status: Number(m[1]),
		code: m[2],
		vorgangsId: m[3] === '-' ? null : m[3],
		meldung: m[4].trim(),
	};
}

/** Entfernt personenbezogene Daten und kürzt (keine Mail-Inhalte im Fehlerlog). */
function bereinigeMeldung(text, maxLaenge = 300) {
	if (text === undefined || text === null) return '';
	let s = String(text)
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
		.replace(/\+?\d[\d\s/().-]{7,}\d/g, '<nummer>')
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <token>')
		.replace(/\s+/g, ' ')
		.trim();
	if (s.length > maxLaenge) s = s.slice(0, maxLaenge - 1) + '…';
	return s;
}

function codeAusHttpStatus(status) {
	const n = Number(status);
	if (!Number.isFinite(n)) return null;
	if (n === 400 || n === 422) return 'UNGUELTIGES_FORMAT';
	if (n === 401) return 'AUTH_FEHLER';
	if (n === 403) return 'KEINE_BERECHTIGUNG';
	if (n === 404) return 'NICHT_GEFUNDEN';
	if (n === 408 || n === 504) return 'ZEITUEBERSCHREITUNG';
	if (n === 409) return 'DUPLIKAT';
	if (n === 429) return 'RATE_LIMIT';
	if (n === 503) return 'NICHT_ERREICHBAR';
	if (n >= 500 && n < 600) return 'UPSTREAM_FEHLER';
	return null;
}

function codeAusText(text) {
	const t = String(text || '');
	if (/timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT|timeout of \d+ms/i.test(t)) return 'ZEITUEBERSCHREITUNG';
	if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|service unavailable/i.test(t)) return 'NICHT_ERREICHBAR';
	if (/rate.?limit|too many requests/i.test(t)) return 'RATE_LIMIT';
	if (/invalid_grant|unauthori[sz]ed|token (has )?expired|invalid.?token|authentication failed|password authentication/i.test(t)) return 'AUTH_FEHLER';
	if (/forbidden|insufficient privileges|access denied|permission denied/i.test(t)) return 'KEINE_BERECHTIGUNG';
	if (/duplicate key|unique constraint/i.test(t)) return 'DUPLIKAT';
	return null;
}

/**
 * Klassifiziert einen Fehler.
 * @param {{message?: string, description?: string, httpCode?: string|number}} fehler
 */
function klassifiziereFehler(fehler) {
	const f = fehler || {};
	const epa = parseEpaFehler(f.message) || parseEpaFehler(f.description);
	let code;
	let vorgangsId = null;
	let meldung;
	if (epa) {
		code = FEHLERCODES[epa.code] ? epa.code : 'UNBEKANNT';
		vorgangsId = epa.vorgangsId;
		meldung = epa.meldung;
	} else {
		code = codeAusHttpStatus(f.httpCode) || codeAusText(`${f.message || ''} ${f.description || ''}`) || 'UNBEKANNT';
		meldung = f.message || f.description || '';
	}
	const def = FEHLERCODES[code];
	return {
		statuscode: def.status,
		fehlercode: code,
		klasse: def.klasse,
		retrybar: def.retrybar,
		eskalieren: !OHNE_ESKALATION.includes(code),
		vorgangsId,
		meldung: bereinigeMeldung(meldung),
	};
}

/**
 * Baut aus der Ausgabe des Error Trigger einen Fehlerlog-Eintrag (ohne Mail-Inhalte).
 * Error Trigger liefert entweder {execution, workflow} oder bei Trigger-Fehlern {trigger, workflow}.
 */
function ausErrorTrigger(json) {
	const j = json || {};
	const exec = j.execution || {};
	const err = exec.error || (j.trigger && j.trigger.error) || {};
	const k = klassifiziereFehler({
		message: err.message,
		description: err.description,
		httpCode: err.httpCode,
	});
	const node = (err.node && err.node.name) || exec.lastNodeExecuted || null;
	const workflow = j.workflow || {};
	// Markierung " *" (fehlende Credentials) gehört nicht zum Namen
	const ausSicherung = OHNE_SICHERUNG_AUS.includes(String(workflow.name || '').replace(/\s*\*$/, ''));
	return {
		statuscode: k.statuscode,
		fehlercode: k.fehlercode,
		klasse: k.klasse,
		retrybar: k.retrybar,
		eskalieren: k.eskalieren && Boolean(k.vorgangsId) && !ausSicherung,
		workflow_id: workflow.id || null,
		workflow_name: workflow.name || null,
		node,
		execution_id: exec.id !== undefined && exec.id !== null ? String(exec.id) : null,
		execution_url: exec.url || null,
		modus: exec.mode || (j.trigger && j.trigger.mode) || null,
		vorgangs_id: k.vorgangsId,
		meldung: k.meldung,
	};
}

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Klartext je Fehlerklasse für die Alarmmeldung (Mitarbeiter sollen verstehen, was passiert ist).
const KLASSE_TEXT = Object.freeze({
	Upstream: 'Ein externer Dienst (Outlook, KI oder Telegram) hat nicht wie erwartet geantwortet.',
	Konfiguration: 'Die Konfiguration ist unvollständig oder fehlerhaft.',
	Authentifizierung: 'Zugangsdaten sind ungültig oder abgelaufen.',
	Konflikt: 'Zwei Abläufe haben sich überschnitten.',
	Eingabe: 'Ein Ablauf hat ungültige Daten erhalten.',
	LLM: 'Die KI hat keine verwertbare Antwort geliefert.',
	Freigabe: 'Eine Freigabe ist abgelaufen.',
	'Nicht gefunden': 'Ein Datensatz wurde nicht gefunden.',
	Unbekannt: 'Ein unerwarteter Fehler ist aufgetreten.',
});

/** Konkrete Handlungsempfehlung aus Fehlercode und Meldung. */
function alarmEmpfehlung(e) {
	const m = String(e.meldung || '').toLowerCase();
	if (/suspend|gesperrt|blocked/.test(m)) return 'Das Postfach-Konto wurde vom Anbieter gesperrt. Im Postfach anmelden und die Bestätigung durchführen. Nicht gesendete Nachrichten kommen danach automatisch mit neuem Link erneut zur Freigabe (Prüfung stündlich).';
	if (/401|unauthori|token|anmeld/.test(m) || e.klasse === 'Authentifizierung') return 'Zugang (Credential) in n8n prüfen und neu verbinden.';
	if (e.klasse === 'Konfiguration') return 'Konfiguration bzw. Regel-Sheet des Kunden prüfen.';
	if (e.retrybar) return 'Meist vorübergehend. Tritt der Fehler wiederholt auf, die Ausführung öffnen und prüfen.';
	return 'Bitte die Ausführung öffnen und prüfen.';
}

// ---------------------------------------------------------------- Fehlernummern (E-xxx) für Alarme
// Eindeutige Nummer je Fehlerart, nachzuschlagen im Dokument "Fehlercodes Email Process Agent" (docs/Fehlercodes.md).
// 1xx KI (OpenAI) · 2xx Postfach (Outlook) · 3xx Teams · 4xx Daten/Config · 5xx Betrieb (Watchdog, src/watchdog.js) · 999 unbekannt.
const FEHLERNUMMERN = Object.freeze({
	'E-101': 'OpenAI nicht erreichbar',
	'E-102': 'OpenAI überlastet (Limit)',
	'E-103': 'OpenAI lehnt ab: Schlüssel oder Guthaben',
	'E-104': 'KI-Antwort unbrauchbar',
	'E-105': 'Prompt fehlt oder inaktiv',
	'E-201': 'Anmeldung am Postfach abgelaufen',
	'E-202': 'Postfach nicht erreichbar',
	'E-203': 'Senden fehlgeschlagen',
	'E-204': 'Zustelltest fehlgeschlagen',
	'E-205': 'Rückfrage unzustellbar',
	'E-206': 'Entwurf nicht gefunden',
	'E-207': 'Outlook-Kategorie nicht gesetzt',
	'E-301': 'Anmeldung an Teams abgelaufen',
	'E-302': 'Teams-Karte nicht zugestellt',
	'E-303': 'Freigabe-Link niemandem zugestellt',
	'E-304': 'Teams überlastet (Limit)',
	'E-305': 'Teams-Karte nicht änderbar',
	'E-401': 'Kunden-Config ungültig',
	'E-402': 'Kunden-Config fehlt',
	'E-403': 'Vorgang nicht gefunden',
	'E-404': 'Unzulässiger Statuswechsel',
	'E-405': 'Vorgang gerade in Bearbeitung',
	'E-406': 'Regeln aus Google Sheets fehlerhaft',
	'E-407': 'Ungültige Eingabe an einen Baustein',
	'E-999': 'Unbekannter Fehler',
});

/** Bereich des Fehlers aus Workflow, Knoten und Meldung: ki | postfach | teams | null. */
function fehlerBereich(e) {
	const ort = `${e.workflow_name || ''} ${e.node || ''}`.toLowerCase();
	const m = String(e.meldung || '').toLowerCase();
	if (/llm|openai|klassifizier|extrahier|entwurf formulieren|\bki\b/.test(ort) || /openai|llm-|prompt|ki-antwort/.test(m)) return 'ki';
	if (/teams|kanal|karte|chat|freigeber benachrichtigen|mitarbeiter informieren|alarm/.test(ort) || /teams|kanal|channel|karte/.test(m)) return 'teams';
	if (/postfach|outlook|entwurf|mail|zustelltest|kategorie|epa-00/.test(ort) || /postfach|outlook|mailbox|entwurf|zustell/.test(m)) return 'postfach';
	return null;
}

/** Eindeutige Fehlernummer (E-xxx) für einen Fehlerlog-Eintrag bzw. Alarm. */
function fehlernummer(e) {
	const code = String(e.fehlercode || '');
	const status = Number(e.statuscode);
	const m = String(e.meldung || '').toLowerCase();
	const ort = `${e.workflow_name || ''} ${e.node || ''}`.toLowerCase();
	const bereich = fehlerBereich(e);
	const auth = code === 'AUTH_FEHLER' || code === 'KEINE_BERECHTIGUNG' || status === 401 || status === 403 || /\b401\b|unauthori|invalid_api_key|token (ist )?abgelaufen|anmeld/.test(m);
	const limit = code === 'RATE_LIMIT' || status === 429 || /\b429\b|rate.?limit|too many requests/.test(m);
	const weg = ['UPSTREAM_FEHLER', 'NICHT_ERREICHBAR', 'ZEITUEBERSCHREITUNG'].includes(code) || [502, 503, 504].includes(status);
	if (bereich === 'ki') {
		if (/prompt/.test(m) && code === 'KONFIGURATIONSFEHLER') return 'E-105';
		if (auth || /quota|guthaben|insufficient/.test(m)) return 'E-103';
		if (limit) return 'E-102';
		if (code === 'EXTRAKTION_UNGUELTIG' || /ungültig|schema/.test(m)) return 'E-104';
		if (weg) return 'E-101';
	}
	if (bereich === 'postfach') {
		if (/zustelltest/.test(ort) || /zustelltest/.test(m)) return 'E-204';
		if (/unzustellbar|nicht zugestellt beim kunden|ndr/.test(m)) return 'E-205';
		if (auth || /suspended|gesperrt|verify your account/.test(m)) return 'E-201';
		if (/kategorie/.test(ort)) return 'E-207';
		if (/entwurf/.test(m) && /nicht gefunden|existiert nicht|not ?found|404/.test(m)) return 'E-206';
		if (/550|senden|gesendet|send/.test(m)) return 'E-203';
		if (weg || limit) return 'E-202';
	}
	if (bereich === 'teams') {
		if (auth) return 'E-301';
		if (limit) return 'E-304';
		if (/freigabe-link|freigeber/.test(m) || /freigeber benachrichtigen/.test(ort)) return 'E-303';
		if (/ändern|aendern|löschen|loeschen|entfernen/.test(m)) return 'E-305';
		if (weg || /nicht zugestellt|zugestellt/.test(m)) return 'E-302';
	}
	if (code === 'KONFIG_NICHT_GEFUNDEN') return 'E-402';
	if (code === 'KONFIGURATIONSFEHLER' || code === 'KONFIG_MEHRDEUTIG') return /sheet|regel/.test(ort + ' ' + m) ? 'E-406' : 'E-401';
	if (code === 'VORGANG_NICHT_GEFUNDEN' || code === 'NICHT_GEFUNDEN') return 'E-403';
	if (code === 'UNZULAESSIGER_STATUSWECHSEL' || code === 'UNZULAESSIGER_AUSLOESER') return 'E-404';
	if (code === 'VERSIONSKONFLIKT' || code === 'GESPERRT') return 'E-405';
	if (['UNGUELTIGES_FORMAT', 'UNGUELTIGER_AUSLOESER', 'UNBEKANNTER_STATUS'].includes(code)) return 'E-407';
	if (bereich === 'ki') return 'E-101';
	if (bereich === 'postfach') return 'E-202';
	if (bereich === 'teams') return 'E-302';
	return 'E-999';
}

function alarmHtml(eintrag) {
	const e = eintrag;
	const meldung = String(e.meldung || '');
	// Titel: erster Satzteil der Meldung ("Rückfrage nicht gesendet: …"), sonst die Fehlerklasse
	const kopf = meldung.split(/[:.]/)[0].trim();
	const titel = kopf && kopf.length <= 70 ? kopf : (KLASSE_TEXT[e.klasse] || 'Systemfehler');
	const zeilen = [
		`🚨 <b>${fehlernummer(e)} ${escapeHtml(FEHLERNUMMERN[fehlernummer(e)] || 'Systemfehler')}</b>`,
		escapeHtml(titel),
		escapeHtml(KLASSE_TEXT[e.klasse] || KLASSE_TEXT.Unbekannt),
	];
	if (e.vorgangs_id) zeilen.push(`Vorgang: <b>${escapeHtml(e.vorgangs_id)}</b>`);
	zeilen.push(`Grund: ${escapeHtml(meldung || '–')}`);
	zeilen.push(`Was tun: ${escapeHtml(alarmEmpfehlung(e))}`);
	zeilen.push('');
	zeilen.push(`Technik: ${escapeHtml(e.workflow_name || e.workflow_id || '?')} · ${escapeHtml(e.node || '?')} · EPA-Fehler ${e.statuscode} ${escapeHtml(e.fehlercode)} (${escapeHtml(e.klasse)})`);
	if (e.execution_url) zeilen.push(`<a href="${escapeHtml(e.execution_url)}">Ausführung ${escapeHtml(e.execution_id)} öffnen</a>`);
	return zeilen.join('<br>');
}

module.exports = {
	FEHLERCODES,
	OHNE_ESKALATION,
	OHNE_SICHERUNG_AUS,
	formatEpaFehler,
	epaFehler,
	parseEpaFehler,
	bereinigeMeldung,
	klassifiziereFehler,
	ausErrorTrigger,
	alarmHtml,
	alarmEmpfehlung,
	FEHLERNUMMERN,
	fehlerBereich,
	fehlernummer,
	escapeHtml,
};
