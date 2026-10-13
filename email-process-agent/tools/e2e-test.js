#!/usr/bin/env node
'use strict';
// End-to-End-Test der M1-Workflows in einer echten n8n-Instanz gegen eine TEST-Datenbank.
// Voraussetzungen: tools/deploy.js gelaufen, Credentials zugewiesen, alle EPA-Workflows veröffentlicht,
// Beispiel-Config in der Test-DB mit gültigem Postfach/Freigeber.
// Legt Test-Workflows "EPA-TEST …" mit Webhook-Trigger an (werden am Ende wieder gelöscht).
//
// Aufruf:
//   N8N_URL=… N8N_API_KEY=… EPA_E2E_PG='postgres://user:pass@host:port/testdb' \
//   EPA_E2E_PG_CREDENTIAL_ID=<ID des Postgres-Credentials der Test-DB> node tools/e2e-test.js
// NIE gegen eine Produktivdatenbank ausführen.
// Hinweis: Der Webhook antwortet bei Fehlern nur mit "Error in workflow"; geprüft wird daher über epa_fehler_log.
const fs = require('node:fs');
const path = require('node:path');
const { Workflow, ROOT } = require('./lib/n8n');

const BASIS = (process.env.N8N_URL || '').replace(/\/+$/, '');
const KEY = process.env.N8N_API_KEY;
const PG_URL = process.env.EPA_E2E_PG;
const KUNDE = process.env.EPA_E2E_KUNDE || 'beispiel-transport';

async function api(methode, pfad, body) {
	const res = await fetch(`${BASIS}/api/v1${pfad}`, {
		method: methode,
		headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${methode} ${pfad} -> ${res.status}: ${text.slice(0, 400)}`);
	return text ? JSON.parse(text) : {};
}

function harness(subName, slug, eingaben, ids) {
	const wf = new Workflow(`EPA-TEST ${subName}`);
	const hook = wf.node('Testaufruf', 'n8n-nodes-base.webhook', [0, 0], {
		httpMethod: 'POST',
		path: `epa-test-${slug}`,
		responseMode: 'lastNode',
		responseData: 'firstEntryJson',
		options: {},
	}, { webhookId: `epa-test-${slug}` });
	const aufruf = wf.aufruf('Sub-Workflow aufrufen', [240, 0], subName, eingaben.map(([n, t]) => [n, t, `={{ $json.body.${n} }}`]));
	wf.verbinde(hook, aufruf);
	const json = wf.json();
	const node = json.nodes.find((n) => n.name === 'Sub-Workflow aufrufen');
	node.parameters.workflowId.value = ids[subName];
	return { name: json.name, nodes: json.nodes, connections: json.connections, settings: { executionOrder: 'v1' } };
}

async function entfernen(id) {
	// n8n 2.x: veröffentlichte Workflows müssen vor dem Löschen deaktiviert werden
	await api('POST', `/workflows/${id}/deactivate`).catch(() => {});
	for (let versuch = 1; ; versuch++) {
		try {
			return await api('DELETE', `/workflows/${id}`);
		} catch (e) {
			// Deaktivieren läuft asynchron ("still being unpublished")
			if (versuch >= 20 || !/409/.test(e.message)) throw e;
			await new Promise((s) => setTimeout(s, 500));
		}
	}
}

async function aufrufen(slug, body) {
	const res = await fetch(`${BASIS}/webhook/epa-test-${slug}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = { roh: text };
	}
	return { status: res.status, json };
}

async function warte(bedingung, ms = 20000) {
	const ende = Date.now() + ms;
	while (Date.now() < ende) {
		const r = await bedingung();
		if (r) return r;
		await new Promise((s) => setTimeout(s, 500));
	}
	return null;
}

async function main() {
	if (!BASIS || !KEY || !PG_URL) throw new Error('N8N_URL, N8N_API_KEY und EPA_E2E_PG setzen');
	const pgp = require('pg-promise')();
	const db = pgp(PG_URL);
	const ergebnisse = [];
	const fall = async (name, erwartet, fn) => {
		try {
			const tatsaechlich = await fn();
			ergebnisse.push({ name, erwartet, tatsaechlich, ok: true });
		} catch (e) {
			ergebnisse.push({ name, erwartet, tatsaechlich: e.message, ok: false });
		}
	};
	const pruefe = (bedingung, text) => {
		if (!bedingung) throw new Error(text);
	};

	const { data } = await api('GET', '/workflows?limit=250');
	const ids = Object.fromEntries(data.map((w) => [w.name, w.id]));
	const lokal = fs.readdirSync(path.join(ROOT, 'workflows')).map((d) => JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', d), 'utf8')));
	const eingabenVon = (name) => lokal.find((w) => w.name === name).nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger').parameters.workflowInputs.values.map((v) => [v.name, v.type]);

	const subs = [
		['EPA SW Config laden', 'config'],
		['EPA SW Vorgang verwalten', 'vorgang'],
		['EPA SW Status setzen', 'status'],
		['EPA SW Audit schreiben', 'audit'],
	];
	const angelegt = [];
	try {
		for (const [name, slug] of subs) {
			if (!ids[name]) throw new Error(`Workflow "${name}" fehlt in n8n (erst tools/deploy.js ausführen)`);
			const alt = data.find((w) => w.name === `EPA-TEST ${name}`);
			if (alt) await entfernen(alt.id);
			const wf = await api('POST', '/workflows', harness(name, slug, eingabenVon(name), ids));
			angelegt.push(wf.id);
			await api('POST', `/workflows/${wf.id}/activate`);
		}

		await fall('Config laden (gültige Config)', 'config mit Vorgangstyp transport', async () => {
			const r = await aufrufen('config', { kunde_id: KUNDE });
			pruefe(r.status === 200, `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
			const felder = r.json.config.vorgangstypen.transport;
			pruefe(felder.length >= 1, 'keine Felder');
			return `${felder.length} Felder, Frist ${r.json.config.frist_stunden} h`;
		});

		const startFehler = (await db.one('SELECT coalesce(max(id), 0)::int AS id FROM epa_fehler_log')).id;
		await fall('Config laden (unbekannter Kunde)', 'Abbruch 404 + Fehlerlog-Eintrag', async () => {
			const r = await aufrufen('config', { kunde_id: 'gibt-es-nicht' });
			pruefe(r.status >= 500, `HTTP ${r.status}`);
			const f = await warte(() => db.oneOrNone("SELECT * FROM epa_fehler_log WHERE id > $1 AND fehlercode = 'KONFIG_NICHT_GEFUNDEN' ORDER BY id LIMIT 1", [startFehler]));
			pruefe(f, 'kein Fehlerlog-Eintrag durch EPA-05');
			pruefe(!/gibt-es-nicht@/.test(f.meldung), 'Meldung enthält Personendaten');
			return `HTTP ${r.status}, Fehlerlog ${f.statuscode} ${f.fehlercode} (Node ${f.node})`;
		});

		let vorgang;
		await fall('Vorgang anlegen', 'Status Neu, ID V-JJJJ-NNNN', async () => {
			const r = await aufrufen('vorgang', { aktion: 'anlegen', kunde_id: KUNDE, daten: { erste_message_id: `<e2e-${Date.now()}@test>`, absender_adresse: 'e2e@test.local', betreff: 'E2E', betreff_normalisiert: 'e2e' } });
			pruefe(r.status === 200, `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
			vorgang = r.json.vorgang;
			pruefe(/^V-\d{4}-\d{4,}$/.test(vorgang.vorgangs_id) && vorgang.status === 'Neu', JSON.stringify(vorgang));
			return `${vorgang.vorgangs_id} (${vorgang.status})`;
		});

		await fall('Status setzen erlaubt (Neu -> In Prüfung, KI)', 'ok, Version 2, Audit', async () => {
			const r = await aufrufen('status', { kunde_id: KUNDE, vorgangs_id: vorgang.vorgangs_id, neuer_status: 'In Prüfung', ausloeser: 'KI', details: { test: 'e2e' } });
			pruefe(r.status === 200 && r.json.ok === true && r.json.version === 2, JSON.stringify(r.json));
			const a = await db.one('SELECT * FROM epa_audit_log WHERE id = $1', [r.json.audit_id]);
			pruefe(a.alt === 'Neu' && a.neu === 'In Prüfung', 'Audit falsch');
			return `ok, Version ${r.json.version}, Audit ${r.json.audit_id}`;
		});

		await fall('Vorgang aktualisieren mit falscher Version', '409 VERSIONSKONFLIKT', async () => {
			const r = await aufrufen('vorgang', { aktion: 'aktualisieren', kunde_id: KUNDE, vorgangs_id: vorgang.vorgangs_id, erwartete_version: 1, daten: { bearbeiter: 'x' } });
			pruefe(r.status >= 500, `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
			const f = await warte(() => db.oneOrNone("SELECT * FROM epa_fehler_log WHERE fehlercode = 'VERSIONSKONFLIKT' AND vorgangs_id = $1 ORDER BY id DESC LIMIT 1", [vorgang.vorgangs_id]));
			pruefe(f && f.statuscode === 409, 'kein Fehlerlog-Eintrag 409 VERSIONSKONFLIKT');
			await new Promise((s) => setTimeout(s, 2000));
			const v = await db.one('SELECT status, version FROM epa_vorgaenge WHERE vorgangs_id = $1', [vorgang.vorgangs_id]);
			pruefe(v.status === 'In Prüfung' && v.version === 2, `Vorgang darf nicht eskaliert werden (ist "${v.status}", Version ${v.version})`);
			return `HTTP ${r.status}, Fehlerlog 409 VERSIONSKONFLIKT, Vorgang unverändert ("${v.status}")`;
		});

		await fall('Vorgang aktualisieren korrekt', 'Version 3, Status unverändert', async () => {
			const r = await aufrufen('vorgang', { aktion: 'aktualisieren', kunde_id: KUNDE, vorgangs_id: vorgang.vorgangs_id, erwartete_version: 2, daten: { rundenzaehler: 1, neue_message_ids: ['<e2e-out@test>'] } });
			pruefe(r.status === 200 && r.json.vorgang.version === 3 && r.json.vorgang.status === 'In Prüfung', JSON.stringify(r.json).slice(0, 300));
			return `Version ${r.json.vorgang.version}, ${r.json.vorgang.bekannte_message_ids.length} Message-IDs`;
		});

		await fall('Kandidaten suchen', 'Vorgang wird über Message-ID gefunden', async () => {
			const r = await aufrufen('vorgang', { aktion: 'kandidaten_suchen', kunde_id: KUNDE, daten: { message_ids: ['<e2e-out@test>'] } });
			pruefe(r.status === 200 && r.json.kandidaten.some((k) => k.vorgangs_id === vorgang.vorgangs_id), JSON.stringify(r.json).slice(0, 300));
			return `${r.json.kandidaten.length} Kandidat(en)`;
		});

		await fall('Sperren', 'zweiter Inhaber bekommt keine Sperre', async () => {
			const a = await aufrufen('vorgang', { aktion: 'sperren', kunde_id: KUNDE, vorgangs_id: vorgang.vorgangs_id, referenz: 'A', lock_sekunden: 60 });
			const b = await aufrufen('vorgang', { aktion: 'sperren', kunde_id: KUNDE, vorgangs_id: vorgang.vorgangs_id, referenz: 'B', lock_sekunden: 60 });
			const e = await aufrufen('vorgang', { aktion: 'entsperren', kunde_id: KUNDE, vorgangs_id: vorgang.vorgangs_id, referenz: 'A' });
			pruefe(a.json.gesperrt === true && b.json.gesperrt === false && b.json.gesperrt_durch === 'A' && e.json.entsperrt === true, JSON.stringify([a.json, b.json, e.json]).slice(0, 300));
			return 'A gesperrt, B abgewiesen, A entsperrt';
		});

		await fall('Audit schreiben', 'Eintrag angelegt', async () => {
			const r = await aufrufen('audit', { kunde_id: KUNDE, vorgangs_id: vorgang.vorgangs_id, typ: 'MERGE', alt: null, neu: '40210', ausloeser: 'KI', details: { feld: 'Start_PLZ' } });
			pruefe(r.status === 200 && r.json.audit_id, JSON.stringify(r.json));
			return `Audit ${r.json.audit_id}`;
		});

		const vorFehler = (await db.one('SELECT coalesce(max(id), 0)::int AS id FROM epa_fehler_log')).id;
		await fall('Unzulässiger Statuswechsel (In Prüfung -> Abgeschlossen)', '409, Fehlerlog, Vorgang auf Eskaliert / Manuell', async () => {
			const r = await aufrufen('status', { kunde_id: KUNDE, vorgangs_id: vorgang.vorgangs_id, neuer_status: 'Abgeschlossen', ausloeser: 'System' });
			pruefe(r.status >= 500, `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
			const f = await warte(() => db.oneOrNone("SELECT * FROM epa_fehler_log WHERE id > $1 AND fehlercode = 'UNZULAESSIGER_STATUSWECHSEL' AND vorgangs_id = $2 ORDER BY id LIMIT 1", [vorFehler, vorgang.vorgangs_id]));
			pruefe(f && f.statuscode === 409, 'kein Fehlerlog-Eintrag 409');
			const v = await warte(async () => {
				const x = await db.one('SELECT status FROM epa_vorgaenge WHERE vorgangs_id = $1', [vorgang.vorgangs_id]);
				return x.status === 'Eskaliert / Manuell' ? x : null;
			});
			pruefe(v, 'Vorgang wurde nicht eskaliert');
			const a = await db.one("SELECT * FROM epa_audit_log WHERE vorgangs_id = $1 AND neu = 'Eskaliert / Manuell' ORDER BY id DESC LIMIT 1", [vorgang.vorgangs_id]);
			const esk = await warte(() => db.oneOrNone('SELECT eskaliert FROM epa_fehler_log WHERE id = $1 AND eskaliert', [f.id]));
			pruefe(esk, 'Eskalation nicht im Fehlerlog vermerkt');
			return `HTTP ${r.status}, Fehlerlog ${f.statuscode}, Status "${v.status}", Audit-Auslöser ${a.ausloeser}`;
		});

		await fall('Status setzen nur_wenn_erlaubt bei unzulässigem Übergang', 'übersprungen, kein Fehler', async () => {
			const r = await aufrufen('status', { kunde_id: KUNDE, vorgangs_id: vorgang.vorgangs_id, neuer_status: 'Warten auf Kunde', ausloeser: 'System', nur_wenn_erlaubt: true });
			pruefe(r.status === 200 && r.json.uebersprungen === true, JSON.stringify(r.json));
			return `übersprungen (${r.json.code})`;
		});

		await fall('Fehlerlog ohne Mail-Inhalte, Alarmstatus', 'nur IDs/Codes; alarmiert_am gesetzt, wenn Teams erreichbar', async () => {
			const zeilen = await db.any('SELECT meldung, alarmiert_am, eskaliert FROM epa_fehler_log WHERE id > $1', [startFehler]);
			pruefe(zeilen.every((z) => !/@/.test(z.meldung || '')), 'E-Mail-Adresse im Fehlerlog');
			const alarmiert = zeilen.filter((z) => z.alarmiert_am).length;
			return `${zeilen.length} Einträge, ${alarmiert} alarmiert, ${zeilen.filter((z) => z.eskaliert).length} mit Eskalation`;
		});
	} finally {
		for (const id of angelegt) await entfernen(id).catch((e) => console.error(`Aufräumen fehlgeschlagen: ${e.message}`));
		await db.$pool.end();
	}

	console.log('| Szenario | erwartet | tatsächlich | bestanden |');
	console.log('|---|---|---|---|');
	for (const e of ergebnisse) console.log(`| ${e.name} | ${e.erwartet} | ${String(e.tatsaechlich).replace(/\|/g, '/')} | ${e.ok ? 'ja' : '**nein**'} |`);
	if (ergebnisse.some((e) => !e.ok)) process.exit(1);
}

main().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
