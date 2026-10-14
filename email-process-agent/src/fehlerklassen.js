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

function alarmHtml(eintrag) {
	const e = eintrag;
	const zeilen = [
		`<b>EPA-Fehler ${e.statuscode} ${escapeHtml(e.fehlercode)}</b> (${escapeHtml(e.klasse)})`,
		`Workflow: ${escapeHtml(e.workflow_name || e.workflow_id || '?')}`,
		`Node: ${escapeHtml(e.node || '?')}`,
		`Vorgang: ${escapeHtml(e.vorgangs_id || '–')}`,
		`Meldung: ${escapeHtml(e.meldung || '–')}`,
		e.retrybar ? 'Hinweis: vorübergehender Fehler, erneuter Versuch kann helfen.' : 'Hinweis: dauerhafter Fehler, bitte prüfen.',
	];
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
	escapeHtml,
};
