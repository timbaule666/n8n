#!/usr/bin/env node
'use strict';
// Spielt workflows/*.json über die n8n Public API ein und verknüpft sie:
// - Execute-Workflow-Nodes bekommen die echte ID des Ziel-Workflows (Zuordnung über den Namen)
// - Jeder Workflow außer EPA-05 bekommt EPA-05 als Error Workflow (sobald EPA-05 veröffentlicht ist)
// - Alle Workflows werden veröffentlicht, soweit ihre Credentials zugewiesen sind
// - Bestehende Workflows (gleicher Name) werden aktualisiert; bereits zugewiesene Credentials und
//   eingetragene Teams-IDs bleiben erhalten; neue Nodes erhalten das Credential, das in den EPA-Workflows
//   für diesen Node-Typ bereits (eindeutig) genutzt wird
// Credentials werden nie angelegt und nie aus dem Repo gesetzt.
//
// Aufruf:  N8N_URL=https://timbaule.app.n8n.cloud N8N_API_KEY=... node tools/deploy.js [--dry-run] [--postgres]
// Standard ist die Data-Table-Variante (workflows/), --postgres nimmt workflows-postgres/.
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
	if (!res.ok) {
		const err = new Error(`${methode} ${pfad} -> ${res.status}: ${text.slice(0, 500)}`);
		try {
			err.meldung = JSON.parse(text).message;
		} catch {
			err.meldung = text.slice(0, 500);
		}
		throw err;
	}
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

function ladeLokal(ordner = 'workflows') {
	const dir = path.join(ROOT, ordner);
	return fs
		.readdirSync(dir)
		.filter((d) => d.endsWith('.json'))
		.map((d) => JSON.parse(fs.readFileSync(path.join(dir, d), 'utf8')));
}

/** Setzt Referenzen und übernimmt Credentials/IDs aus der bestehenden Fassung. */
/**
 * Sammelt die in den EPA-Workflows genutzten Credentials je Node-Typ. Eindeutig = genau ein Credential
 * pro Typ; nur dann wird es neuen Nodes desselben Typs automatisch zugewiesen.
 */
function eindeutigeCredentials(workflows) {
	const jeTyp = {};
	for (const wf of workflows) {
		for (const n of wf?.nodes || []) {
			if (!n.credentials) continue;
			const s = (jeTyp[n.type] = jeTyp[n.type] || new Map());
			s.set(JSON.stringify(n.credentials), n.credentials);
		}
	}
	return Object.fromEntries(Object.entries(jeTyp).filter(([, m]) => m.size === 1).map(([t, m]) => [t, [...m.values()][0]]));
}

function verknuepfen(wf, ids, bestehend, { errorWorkflowSetzen = true, credentialsJeTyp = {} } = {}) {
	const alt = new Map((bestehend?.nodes || []).map((n) => [n.name, n]));
	const nodes = wf.nodes.map((n) => {
		const kopie = JSON.parse(JSON.stringify(n));
		const vorher = alt.get(n.name);
		if (vorher?.credentials && vorher.type === n.type) kopie.credentials = vorher.credentials;
		else if (credentialsJeTyp[n.type]) kopie.credentials = credentialsJeTyp[n.type];
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
	if (wf.name !== ERROR_WORKFLOW && errorWorkflowSetzen) settings.errorWorkflow = ids[ERROR_WORKFLOW];
	return { name: wf.name, nodes, connections: wf.connections, settings };
}

async function deploy({ basis, schluessel, trocken = false, ordner = 'workflows', log = console.log }) {
	const lokal = ladeLokal(ordner);
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

	// 2. EPA-05 zuerst schreiben und veröffentlichen: n8n 2.x akzeptiert als Error Workflow nur
	//    veröffentlichte Workflows, und veröffentlichen geht erst mit zugewiesenen Credentials.
	const reihenfolge = [...lokal].sort((a, b) => (a.name === ERROR_WORKFLOW ? -1 : b.name === ERROR_WORKFLOW ? 1 : 0));
	let errorWorkflowVeroeffentlicht = false;
	const offen = [];
	const bestehende = {};
	for (const wf of reihenfolge) {
		if (!String(ids[wf.name]).startsWith('NEU:')) bestehende[wf.name] = await api(basis, schluessel, 'GET', `/workflows/${ids[wf.name]}`);
	}
	const credentialsJeTyp = eindeutigeCredentials(Object.values(bestehende));
	for (const wf of reihenfolge) {
		const body = verknuepfen(wf, ids, bestehende[wf.name] || null, { errorWorkflowSetzen: errorWorkflowVeroeffentlicht, credentialsJeTyp });
		if (trocken) {
			log(`[dry-run] würde aktualisieren und veröffentlichen: ${wf.name} (${body.nodes.length} Nodes)`);
			continue;
		}
		try {
			await api(basis, schluessel, 'PUT', `/workflows/${ids[wf.name]}`, body);
		} catch (e) {
			offen.push(`${wf.name}: nicht aktualisiert – ${String(e.meldung || e.message).replace(/\s*\n\s*/g, ' ')}`);
			log(`FEHLER beim Aktualisieren: ${wf.name}`);
			continue;
		}
		let status = 'aktualisiert und veröffentlicht';
		try {
			await api(basis, schluessel, 'POST', `/workflows/${ids[wf.name]}/activate`);
			if (wf.name === ERROR_WORKFLOW) errorWorkflowVeroeffentlicht = true;
		} catch (e) {
			status = 'aktualisiert, NICHT veröffentlicht';
			offen.push(`${wf.name}: ${String(e.meldung || e.message).replace(/\s*\n\s*/g, ' ')}`);
		}
		log(`${status}: ${wf.name} (${ids[wf.name]})`);
	}
	if (!trocken && !errorWorkflowVeroeffentlicht) {
		log(`\nHinweis: "${ERROR_WORKFLOW}" ist nicht veröffentlicht, daher wurde er noch nirgends als Error Workflow eingetragen.`);
	}
	if (offen.length) {
		log('\nNoch offen (Credentials in n8n zuweisen, Platzhalter ersetzen, dann Deploy erneut ausführen):');
		for (const o of offen) log(`  - ${o}`);
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
	deploy({ basis, schluessel, trocken: process.argv.includes('--dry-run'), ordner: process.argv.includes('--postgres') ? 'workflows-postgres' : 'workflows' }).catch((e) => {
		console.error(`Deploy fehlgeschlagen: ${e.message}`);
		process.exit(1);
	});
}

module.exports = { deploy, verknuepfen, eindeutigeCredentials };
