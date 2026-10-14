'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DateTime } = require('luxon');
const w = require('../src/watchdog');
const l = require('../src/loeschen');
const fristen = require('../src/fristen');
const { validiereConfig } = require('../src/configValidator');

const beispiel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'datatables', 'beispiel-transport.json'), 'utf8'));
const CONFIG = validiereConfig({ ...beispiel.epa_config_allgemein[0], postfach: 'a@b.de', freigeber: '["c@b.de"]' }, beispiel.epa_config_pflichtfelder).config;
const JETZT = '2026-10-14T08:00:00.000Z'; // Mittwoch 10:00 Berlin
const vor = (h) => new Date(new Date(JETZT).getTime() - h * 3600000).toISOString();
const OK = { cron: { letzter_lauf: vor(0.5) }, vorgaenge: [], configs: {}, letzteMails: {}, fehler: [], verbindungen: [{ art: 'teams', ok: true }, { art: 'llm', ok: true }] };
const pruefe = (x) => w.pruefen({ jetzt: JETZT, fristen, ...OK, ...x });
const codes = (r) => r.befunde.map((b) => b.code);

test('Alles in Ordnung', () => {
	const r = pruefe({});
	assert.equal(r.gesamt, 'ok');
	assert.deepEqual(r.befunde, []);
	assert.match(w.nachricht(r, '14.10.2026 10:00'), /Alles in Ordnung/);
});

test('Cron-Heartbeat: nie gelaufen (Warnung), zu alt (Alarm)', () => {
	assert.deepEqual(codes(pruefe({ cron: null })), ['CRON_NIE']);
	assert.equal(pruefe({ cron: null }).gesamt, 'warnung');
	const r = pruefe({ cron: { letzter_lauf: vor(5) } });
	assert.deepEqual(codes(r), ['CRON_AUS']);
	assert.equal(r.gesamt, 'alarm');
	assert.match(r.befunde[0].text, /seit 5 Stunden/);
	assert.ok(r.befunde[0].empfehlung.length > 20);
});

test('Hängende Vorgänge: Übergangsstatus Alarm, Freigabe nach 72 h Warnung, Arbeitsliste gezählt', () => {
	const r = pruefe({ vorgaenge: [
		{ kunde_id: 'k', vorgangs_id: 'V-1', status: 'In Prüfung', updatedAt: vor(2) },
		{ kunde_id: 'k', vorgangs_id: 'V-2', status: 'In Prüfung', updatedAt: vor(0.2) },
		{ kunde_id: 'k', vorgangs_id: 'V-3', status: 'Freigabe ausstehend', updatedAt: vor(80) },
		{ kunde_id: 'k', vorgangs_id: 'V-4', status: 'Freigabe ausstehend', updatedAt: vor(10) },
		{ kunde_id: 'k', vorgangs_id: 'V-5', status: 'Zuordnung unklar', updatedAt: vor(30) },
		{ kunde_id: 'k', vorgangs_id: 'V-6', status: 'Zuordnung unklar', updatedAt: vor(40) },
		{ kunde_id: 'k', vorgangs_id: 'V-7', status: 'Warten auf Kunde', updatedAt: vor(500) },
	] });
	assert.deepEqual(r.befunde.map((b) => `${b.code}:${b.vorgangs_id || ''}`), ['FREIGABE_OFFEN:V-3', 'VORGANG_HAENGT:V-1', 'ARBEITSLISTE:']);
	assert.match(r.befunde[2].text, /^2 Vorgang/);
	// Begrenzung der Einzelmeldungen
	const viele = Array.from({ length: 25 }, (_, i) => ({ kunde_id: 'k', vorgangs_id: `V-${i}`, status: 'Neu', updatedAt: vor(3) }));
	const rv = pruefe({ vorgaenge: viele });
	assert.equal(rv.befunde.length, 21);
	assert.match(rv.befunde[20].text, /5 weitere/);
});

test('Stille im Postfach: nur in Geschäftszeit, nur wenn konfiguriert, in Geschäftsstunden gezählt', () => {
	const c = { ...CONFIG, stille_alarm_stunden: 8 };
	// letzte Mail Dienstag 10:00 -> 8 Geschäftsstunden bis Mittwoch 09:00 -> um 10:00 fällig
	assert.deepEqual(codes(pruefe({ configs: { k: c }, letzteMails: { k: '2026-10-13T08:00:00Z' } })), ['STILLE']);
	// letzte Mail Dienstag 15:00 -> erst Mittwoch 14:00
	assert.deepEqual(codes(pruefe({ configs: { k: c }, letzteMails: { k: '2026-10-13T13:00:00Z' } })), []);
	// aus (0), keine Mail bekannt, außerhalb der Geschäftszeit
	assert.deepEqual(codes(pruefe({ configs: { k: { ...c, stille_alarm_stunden: 0 } }, letzteMails: { k: '2026-10-01T08:00:00Z' } })), []);
	assert.deepEqual(codes(pruefe({ configs: { k: c }, letzteMails: {} })), []);
	assert.deepEqual(codes(w.pruefen({ ...OK, jetzt: '2026-10-17T10:00:00Z', fristen, cron: { letzter_lauf: '2026-10-17T09:30:00Z' }, configs: { k: c }, letzteMails: { k: '2026-10-01T08:00:00Z' } })), []);
});

test('Verbindungen und Fehler ohne Alarm', () => {
	const r = pruefe({
		verbindungen: [{ art: 'teams', ok: false, status: 401, meldung: 'Unauthorized' }, { art: 'llm', ok: false, status: 429 }, { art: 'postfach', kunde_id: 'k', ok: false, status: 403 }, { art: 'llm', ok: true }],
		fehler: [{ createdAt: vor(2), alarmiert_am: null }, { createdAt: vor(3), alarmiert_am: vor(3) }, { createdAt: vor(48), alarmiert_am: null }],
	});
	assert.deepEqual(codes(r), ['VERBINDUNG_TEAMS', 'VERBINDUNG_LLM', 'VERBINDUNG_POSTFACH', 'FEHLER_OHNE_ALARM']);
	assert.match(r.befunde[0].text, /HTTP 401/);
	assert.match(r.befunde[2].text, /Postfach von k/);
	assert.match(r.befunde[3].text, /^1 von 2 Fehler/);
	const html = w.nachricht(r, 'x');
	assert.match(html, /Handlungsbedarf/);
	assert.equal((html.match(/→/g) || []).length, 4);
});

test('Nachricht escaped Inhalte, keine doppelten Empfehlungen', () => {
	const r = pruefe({ verbindungen: [{ art: 'llm', ok: false, meldung: '<script>x</script>' }, { art: 'llm', ok: false, status: 500 }] });
	const html = w.nachricht(r, 'x');
	assert.ok(!html.includes('<script>'));
	assert.equal((html.match(/→/g) || []).length, 1);
});

test('Täglicher OK-Heartbeat: einmal je Tag, Befunde immer', () => {
	const ok = { gesamt: 'ok' };
	assert.equal(w.meldenNoetig(ok, null, JETZT, 'Europe/Berlin', DateTime), true);
	assert.equal(w.meldenNoetig(ok, '2026-10-14T05:00:00Z', JETZT, 'Europe/Berlin', DateTime), false);
	assert.equal(w.meldenNoetig(ok, '2026-10-13T21:59:00Z', JETZT, 'Europe/Berlin', DateTime), true); // 23:59 Berlin am Vortag
	assert.equal(w.meldenNoetig({ gesamt: 'warnung' }, '2026-10-14T07:00:00Z', JETZT, 'Europe/Berlin', DateTime), true);
});

// ---------------------------------------------------------------- Löschjob

const CFG = { k: { aufbewahrung_tage: 30, postfach: 'p@k.de', postfach_workflow_id: 'Abcdef123456' } };
const tageVor = (d) => new Date(new Date(JETZT).getTime() - d * 86400000).toISOString();

test('Löschplan: nur Endstatus nach Aufbewahrung, mit Freigaben; nie offene/eskalierte', () => {
	const vorgaenge = [
		{ kunde_id: 'k', vorgangs_id: 'V-1', status: 'Abgeschlossen', updatedAt: tageVor(31) },
		{ kunde_id: 'k', vorgangs_id: 'V-2', status: 'Ignoriert', updatedAt: tageVor(40) },
		{ kunde_id: 'k', vorgangs_id: 'V-3', status: 'Abgeschlossen', updatedAt: tageVor(29) },
		{ kunde_id: 'k', vorgangs_id: 'V-4', status: 'Eskaliert / Manuell', updatedAt: tageVor(400) },
		{ kunde_id: 'k', vorgangs_id: 'V-5', status: 'Warten auf Kunde', updatedAt: tageVor(400) },
		{ kunde_id: 'x', vorgangs_id: 'V-6', status: 'Abgeschlossen', updatedAt: tageVor(400) },
	];
	const freigaben = [
		{ kunde_id: 'k', vorgangs_id: 'V-1', freigabe_id: 'F-1', status: 'gesendet' },
		{ kunde_id: 'k', vorgangs_id: 'V-4', freigabe_id: 'F-4', status: 'abgelehnt' },
	];
	const p = l.planen({ jetzt: JETZT, vorgaenge, freigaben, configs: CFG });
	assert.deepEqual(p.vorgaenge.map((v) => v.vorgangs_id), ['V-1', 'V-2']);
	assert.deepEqual(p.freigaben.map((f) => f.freigabe_id), ['F-1']);
	assert.deepEqual(p.ohne_config, ['x']);
	assert.deepEqual(p.mail_grenzen, [{ kunde_id: 'k', grenze: tageVor(30) }]);
	assert.equal(p.fehler_grenze, tageVor(90));
});

test('Löschplan: ersetzte Entwürfe zuerst; Vorgang wartet, bis der Entwurf weg ist; Limits', () => {
	const vorgaenge = [{ kunde_id: 'k', vorgangs_id: 'V-1', status: 'Abgeschlossen', updatedAt: tageVor(60) }];
	const freigaben = [
		{ kunde_id: 'k', vorgangs_id: 'V-1', freigabe_id: 'F-1', status: 'ersetzt', entwurf_id: 'd1' },
		{ kunde_id: 'k', vorgangs_id: 'V-1', freigabe_id: 'F-2', status: 'gesendet', entwurf_id: 'd2' },
		{ kunde_id: 'k', vorgangs_id: 'V-9', freigabe_id: 'F-3', status: 'ersetzt', entwurf_id: 'd3', entwurf_entfernt_am: tageVor(1) },
	];
	const p = l.planen({ jetzt: JETZT, vorgaenge, freigaben, configs: CFG });
	assert.deepEqual(p.entwuerfe.map((e) => e.entwurf_id), ['d1']);
	assert.equal(p.entwuerfe[0].postfach_workflow_id, 'Abcdef123456');
	assert.equal(p.vorgaenge.length, 0);
	assert.equal(p.zurueckgestellt, 1);
	const danach = l.planen({ jetzt: JETZT, vorgaenge, freigaben: freigaben.map((f) => ({ ...f, entwurf_entfernt_am: tageVor(0) })), configs: CFG });
	assert.deepEqual(danach.vorgaenge.map((v) => v.vorgangs_id), ['V-1']);
	assert.deepEqual(danach.freigaben.map((f) => f.freigabe_id), ['F-1', 'F-2']);
	const viel = l.planen({ jetzt: JETZT, vorgaenge: Array.from({ length: 5 }, (_, i) => ({ kunde_id: 'k', vorgangs_id: `V-${i}`, status: 'Ignoriert', updatedAt: tageVor(99) })), freigaben: [], configs: CFG, maxVorgaenge: 3 });
	assert.equal(viel.vorgaenge.length, 3);
	assert.equal(viel.verschoben, 2);
});

test('Entwurf nur löschen, wenn er nachweislich der ersetzte Entwurf ist', () => {
	const PROP = 'String {00020329-0000-0000-C000-000000000046} Name EPA-Freigabe-ID';
	const antw = (body, statusCode = 200) => ({ statusCode, body });
	assert.deepEqual(l.entwurfPruefen(antw({ isDraft: true, singleValueExtendedProperties: [{ id: PROP.replace('C000', 'c000'), value: 'F-1' }] }), 'F-1', PROP), { loeschen: true, erledigt: true, grund: 'entwurf_geloescht' });
	assert.equal(l.entwurfPruefen(antw({ isDraft: false, singleValueExtendedProperties: [{ id: PROP, value: 'F-1' }] }), 'F-1', PROP).grund, 'kein_entwurf');
	assert.equal(l.entwurfPruefen(antw({ isDraft: true, singleValueExtendedProperties: [{ id: PROP, value: 'F-2' }] }), 'F-1', PROP).grund, 'kennung_passt_nicht');
	assert.equal(l.entwurfPruefen(antw({ isDraft: true }), 'F-1', PROP).loeschen, false);
	assert.deepEqual(l.entwurfPruefen(antw({}, 404), 'F-1', PROP), { loeschen: false, erledigt: true, grund: 'nicht_mehr_vorhanden' });
	assert.deepEqual(l.entwurfPruefen(antw({}, 401), 'F-1', PROP), { loeschen: false, erledigt: false, grund: 'http_401' });
});

test('Config: stille_alarm_stunden optional (Standard aus)', () => {
	const a = { ...beispiel.epa_config_allgemein[0], postfach: 'a@b.de', freigeber: '["c@b.de"]' };
	delete a.stille_alarm_stunden;
	assert.equal(validiereConfig(a, beispiel.epa_config_pflichtfelder).config.stille_alarm_stunden, 0);
	assert.equal(CONFIG.stille_alarm_stunden, 24);
	assert.equal(validiereConfig({ ...a, stille_alarm_stunden: -1 }, beispiel.epa_config_pflichtfelder).gueltig, false);
});
