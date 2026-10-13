#!/usr/bin/env node
'use strict';
// Spielt workflows/*.json über die n8n Public API ein und verknüpft sie:
// - Execute-Workflow-Nodes bekommen die echte ID des Ziel-Workflows (Zuordnung über den Namen)
// - Jeder Workflow außer EPA-05 bekommt EPA-05 als Error Workflow
// - Bestehende Workflows (gleicher Name) werden aktualisiert; bereits zugewiesene Credentials und
//   eingetragene Teams-IDs bleiben erhalten
// Credentials werden nie angelegt und nie aus dem Repo gesetzt.
//
// Aufruf:  N8N_URL=https://timbaule.app.n8n.cloud N8N_API_KEY=... node tools/deploy.js [--dry-run]
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ERROR_WORKFLOW = 'EPA-05 Error-Handler';
const BEHALTEN_WENN_GESETZT = ['teamId', 'channelId'];

function istPlatzhalter(wert) {
	const v = wert && typeof wert === 'object' ? wert.value : wert;
	return typeof v !== 'string' || v === '' || /^<.*>$/.test(v);
}

async function api(basis, schluessel, methode, pfad, body) {
	const res = await fetch(`${basis}/api/v1${pfad}`, {
		method: methode,
		headers: { 'X-N8N-API-KEY': schluessel, 'Content-Type': 'application/json', Accept: 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${methode} ${pfad} -> ${res.status}: ${text.slice(0, 500)}`);
	return text ? JSON.parse(text) : {};
}

async function alleWorkflows(basis, schluessel) {
	const liste = [];
	let cursor;
	do {
		const q = new URLSearchParams({ limit: '250' });
		if (cursor) q.set('cursor', cursor);
		const r = await api(basis, schluessel, 'GET', `/workflows?${q}`);
		liste.push(...r.data);
		cursor = r.nextCursor;
	} while (cursor);
	return liste;
}

function ladeLokal() {
	const dir = path.join(ROOT, 'workflows');
	return fs
		.readdirSync(dir)
		.filter((d) => d.endsWith('.json'))
		.map((d) => JSON.parse(fs.readFileSync(path.join(dir, d), 'utf8')));
}

/** Setzt Referenzen und übernimmt Credentials/IDs aus der bestehenden Fassung. */
function verknuepfen(wf, ids, bestehend) {
	const alt = new Map((bestehend?.nodes || []).map((n) => [n.name, n]));
	const nodes = wf.nodes.map((n) => {
		const kopie = JSON.parse(JSON.stringify(n));
		const vorher = alt.get(n.name);
		if (vorher?.credentials) kopie.credentials = vorher.credentials;
		if (vorher && vorher.type === n.type) {
			for (const p of BEHALTEN_WENN_GESETZT) {
				if (p in kopie.parameters && istPlatzhalter(kopie.parameters[p]) && !istPlatzhalter(vorher.parameters?.[p])) {
					kopie.parameters[p] = vorher.parameters[p];
				}
			}
		}
		if (n.type === 'n8n-nodes-base.executeWorkflow') {
			const ziel = n.parameters.workflowId.cachedResultName;
			if (!ids[ziel]) throw new Error(`${wf.name}/${n.name}: Ziel-Workflow "${ziel}" nicht gefunden`);
			kopie.parameters.workflowId = { __rl: true, mode: 'list', value: ids[ziel], cachedResultName: ziel, cachedResultUrl: `/workflow/${ids[ziel]}` };
		}
		return kopie;
	});
	const settings = { ...wf.settings };
	if (wf.name !== ERROR_WORKFLOW) settings.errorWorkflow = ids[ERROR_WORKFLOW];
	return { name: wf.name, nodes, connections: wf.connections, settings };
}

async function deploy({ basis, schluessel, trocken = false, log = console.log }) {
	const lokal = ladeLokal();
	const remote = await alleWorkflows(basis, schluessel);
	const doppelt = remote.filter((w, i) => remote.findIndex((x) => x.name === w.name) !== i).map((w) => w.name);
	const betroffen = doppelt.filter((n) => lokal.some((w) => w.name === n));
	if (betroffen.length) throw new Error(`Mehrere Workflows mit gleichem Namen in n8n: ${betroffen.join(', ')}. Bitte bereinigen.`);

	const ids = Object.fromEntries(remote.filter((w) => lokal.some((l) => l.name === w.name)).map((w) => [w.name, w.id]));

	// 1. Fehlende Workflows anlegen (zunächst ohne Verknüpfungen), damit alle IDs bekannt sind
	for (const wf of lokal) {
		if (ids[wf.name]) continue;
		if (trocken) {
			log(`[dry-run] würde anlegen: ${wf.name}`);
			ids[wf.name] = `NEU:${wf.name}`;
			continue;
		}
		const angelegt = await api(basis, schluessel, 'POST', '/workflows', { name: wf.name, nodes: [], connections: {}, settings: { executionOrder: 'v1' } });
		ids[wf.name] = angelegt.id;
		log(`angelegt: ${wf.name} (${angelegt.id})`);
	}

	// 2. Inhalte schreiben und verknüpfen
	for (const wf of lokal) {
		const bestehend = trocken && String(ids[wf.name]).startsWith('NEU:') ? null : await api(basis, schluessel, 'GET', `/workflows/${ids[wf.name]}`);
		const body = verknuepfen(wf, ids, bestehend);
		if (trocken) {
			log(`[dry-run] würde aktualisieren: ${wf.name} (${body.nodes.length} Nodes)`);
			continue;
		}
		await api(basis, schluessel, 'PUT', `/workflows/${ids[wf.name]}`, body);
		const ohneCredentials = body.nodes.filter((n) => ['n8n-nodes-base.postgres', 'n8n-nodes-base.microsoftTeams'].includes(n.type) && !n.credentials).map((n) => n.name);
		log(`aktualisiert: ${wf.name} (${ids[wf.name]})${ohneCredentials.length ? ` – Credential fehlt noch in: ${ohneCredentials.join(', ')}` : ''}`);
	}
	return ids;
}

if (require.main === module) {
	const basis = (process.env.N8N_URL || '').replace(/\/+$/, '');
	const schluessel = process.env.N8N_API_KEY;
	if (!basis || !schluessel) {
		console.error('N8N_URL und N8N_API_KEY setzen (API-Key in n8n unter Settings -> n8n API).');
		process.exit(2);
	}
	deploy({ basis, schluessel, trocken: process.argv.includes('--dry-run') }).catch((e) => {
		console.error(`Deploy fehlgeschlagen: ${e.message}`);
		process.exit(1);
	});
}

module.exports = { deploy, verknuepfen };
