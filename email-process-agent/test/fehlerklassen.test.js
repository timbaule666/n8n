'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../src/fehlerklassen');

test('EPA-Fehler: formatieren und zurücklesen', () => {
	const t = f.formatEpaFehler('UNZULAESSIGER_STATUSWECHSEL', 'V-2026-0891', '"Neu" -> "Warten auf Kunde" ist nicht erlaubt');
	assert.equal(t, '[EPA:409:UNZULAESSIGER_STATUSWECHSEL:V-2026-0891] "Neu" -> "Warten auf Kunde" ist nicht erlaubt');
	assert.deepEqual(f.parseEpaFehler(t), {
		status: 409, code: 'UNZULAESSIGER_STATUSWECHSEL', vorgangsId: 'V-2026-0891', meldung: '"Neu" -> "Warten auf Kunde" ist nicht erlaubt',
	});
});

test('EPA-Fehler ohne Vorgang und mit n8n-Präfix/Suffix', () => {
	const t = `Error: ${f.formatEpaFehler('KONFIGURATIONSFEHLER', null, 'Baustein fehlt')} [line 12]`;
	const p = f.parseEpaFehler(t);
	assert.equal(p.status, 424);
	assert.equal(p.vorgangsId, null);
	assert.equal(p.meldung, 'Baustein fehlt [line 12]');
});

test('epaFehler wirft Error mit Code', () => {
	const e = f.epaFehler('VERSIONSKONFLIKT', 'V-2026-0001', 'x');
	assert.ok(e instanceof Error);
	assert.equal(e.epaCode, 'VERSIONSKONFLIKT');
	assert.match(e.message, /^\[EPA:409:VERSIONSKONFLIKT:V-2026-0001\]/);
});

test('unbekannter Code wird zu 500 UNBEKANNT', () => {
	assert.match(f.formatEpaFehler('GIBTSNICHT', null, 'x'), /^\[EPA:500:UNBEKANNT:-\]/);
});

test('Statuscode-Mapping nach Ursache statt generischem 500', () => {
	const faelle = [
		[{ httpCode: '401', message: 'Authorization failed' }, 401, 'AUTH_FEHLER'],
		[{ httpCode: '403', message: 'Forbidden' }, 403, 'KEINE_BERECHTIGUNG'],
		[{ httpCode: '404', message: 'The resource you are requesting could not be found' }, 404, 'NICHT_GEFUNDEN'],
		[{ httpCode: '429', message: 'Too many requests' }, 429, 'RATE_LIMIT'],
		[{ httpCode: '502', message: 'Bad gateway' }, 502, 'UPSTREAM_FEHLER'],
		[{ httpCode: '503', message: 'Service unavailable' }, 503, 'NICHT_ERREICHBAR'],
		[{ httpCode: '504' }, 504, 'ZEITUEBERSCHREITUNG'],
		[{ message: 'connect ECONNREFUSED 10.0.0.1:5432' }, 503, 'NICHT_ERREICHBAR'],
		[{ message: 'timeout of 30000ms exceeded' }, 504, 'ZEITUEBERSCHREITUNG'],
		[{ message: 'AADSTS70008: invalid_grant: The refresh token has expired' }, 401, 'AUTH_FEHLER'],
		[{ message: 'duplicate key value violates unique constraint "epa_verarbeitete_mails_pkey"' }, 409, 'DUPLIKAT'],
		[{ message: 'Rate limit reached for gpt-4o-mini' }, 429, 'RATE_LIMIT'],
		[{ message: 'Cannot read properties of undefined' }, 500, 'UNBEKANNT'],
	];
	for (const [eingabe, status, code] of faelle) {
		const k = f.klassifiziereFehler(eingabe);
		assert.equal(k.statuscode, status, JSON.stringify(eingabe));
		assert.equal(k.fehlercode, code, JSON.stringify(eingabe));
	}
});

test('retrybar nur für vorübergehende Fehler', () => {
	assert.equal(f.klassifiziereFehler({ httpCode: 429 }).retrybar, true);
	assert.equal(f.klassifiziereFehler({ httpCode: 503 }).retrybar, true);
	assert.equal(f.klassifiziereFehler({ httpCode: 400 }).retrybar, false);
	assert.equal(f.klassifiziereFehler({ httpCode: 401 }).retrybar, false);
	assert.equal(f.klassifiziereFehler({ message: f.formatEpaFehler('EXTRAKTION_UNGUELTIG', 'V-2026-0002', 'x') }).retrybar, false);
});

test('bereinigeMeldung entfernt personenbezogene Daten und Tokens, kürzt', () => {
	const m = f.bereinigeMeldung('Fehler bei max.mustermann@kunde.de, Tel. +49 (0)211 123 456 78, Header Bearer eyJhbGciOi.abc.def');
	assert.ok(!m.includes('mustermann'));
	assert.ok(!m.includes('123 456'));
	assert.ok(!m.includes('eyJ'));
	assert.match(m, /<email>/);
	assert.equal(f.bereinigeMeldung('x'.repeat(1000)).length, 300);
	assert.equal(f.bereinigeMeldung(null), '');
});

test('ausErrorTrigger: Ausführungsfehler mit EPA-Code', () => {
	const e = f.ausErrorTrigger({
		execution: {
			id: '231',
			url: 'https://timbaule.app.n8n.cloud/execution/231',
			error: { message: f.formatEpaFehler('UNZULAESSIGER_STATUSWECHSEL', 'V-2026-0007', 'x'), node: { name: 'Übergang prüfen' } },
			lastNodeExecuted: 'Übergang prüfen',
			mode: 'integrated',
		},
		workflow: { id: 'abc', name: 'EPA SW Status setzen' },
	});
	assert.equal(e.statuscode, 409);
	assert.equal(e.vorgangs_id, 'V-2026-0007');
	assert.equal(e.node, 'Übergang prüfen');
	assert.equal(e.execution_id, '231');
	assert.equal(e.workflow_name, 'EPA SW Status setzen');
});

test('ausErrorTrigger: Trigger-Fehler (z. B. abgelaufenes Token)', () => {
	const e = f.ausErrorTrigger({
		trigger: { error: { message: 'invalid_grant', httpCode: '401' }, mode: 'trigger' },
		workflow: { id: 'w1', name: 'EPA-01 Eingang' },
	});
	assert.equal(e.statuscode, 401);
	assert.equal(e.execution_id, null);
	assert.equal(e.modus, 'trigger');
	assert.equal(e.vorgangs_id, null);
});

test('ausErrorTrigger toleriert leere Eingabe', () => {
	const e = f.ausErrorTrigger({});
	assert.equal(e.statuscode, 500);
});

test('alarmHtml escaped Inhalte', () => {
	const h = f.alarmHtml({ statuscode: 500, fehlercode: 'UNBEKANNT', klasse: 'Unbekannt', workflow_name: '<script>', node: 'n', vorgangs_id: null, meldung: 'a&b', retrybar: false, execution_url: null });
	assert.ok(!h.includes('<script>'));
	assert.ok(h.includes('a&amp;b'));
});

test('Eskalation nur, wenn ein Vorgang betroffen ist und kein Parallel-Konflikt vorliegt', () => {
	const mit = (code, vid) => f.ausErrorTrigger({ execution: { error: { message: f.formatEpaFehler(code, vid, 'x') } } }).eskalieren;
	assert.equal(mit('UNZULAESSIGER_STATUSWECHSEL', 'V-2026-0001'), true);
	assert.equal(mit('EXTRAKTION_UNGUELTIG', 'V-2026-0001'), true);
	assert.equal(mit('VERSIONSKONFLIKT', 'V-2026-0001'), false);
	assert.equal(mit('GESPERRT', 'V-2026-0001'), false);
	assert.equal(mit('DUPLIKAT', 'V-2026-0001'), false);
	assert.equal(mit('UNZULAESSIGER_STATUSWECHSEL', null), false);
	assert.equal(f.ausErrorTrigger({ execution: { error: { message: 'socket hang up' } } }).eskalieren, false);
});

test('ausErrorTrigger: Fehler aus "Status setzen" werden nicht erneut gesichert (keine Fehlerschleife)', () => {
	const fehler = (name) => f.ausErrorTrigger({ workflow: { id: 'w', name }, execution: { id: 1, error: { message: '[EPA:400:UNGUELTIGES_FORMAT:V-1] Eingabe "kunde_id" fehlt' } } });
	assert.equal(fehler('EPA SW Status setzen').eskalieren, false);
	assert.equal(fehler('EPA SW Status setzen *').eskalieren, false, 'Markierung " *" ändert nichts');
	assert.equal(fehler('EPA-01 Eingang verarbeiten').eskalieren, true);
	assert.deepEqual(f.OHNE_SICHERUNG_AUS, ['EPA SW Status setzen']);
});
