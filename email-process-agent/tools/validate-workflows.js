#!/usr/bin/env node
'use strict';
// Strukturprüfung der erzeugten Workflows (ohne n8n-Instanz).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT, VERSIONEN } = require('./lib/n8n');

function pruefeWorkflow(json, alleNamen) {
	const fehler = [];
	const namen = new Set();
	for (const n of json.nodes) {
		if (namen.has(n.name)) fehler.push(`Node-Name doppelt: ${n.name}`);
		namen.add(n.name);
		if (VERSIONEN[n.type] !== n.typeVersion) fehler.push(`${n.name}: Version ${n.typeVersion} für ${n.type} nicht geprüft`);
		if (/^(Code|Postgres|If|Switch|Execute Workflow)\d*$/.test(n.name)) fehler.push(`${n.name}: Node-Name nicht sprechend`);
		if (n.credentials) fehler.push(`${n.name}: enthält Credentials (sollen beim Import zugewiesen werden)`);
		if (n.type === 'n8n-nodes-base.code') {
			try {
				new vm.Script(`(async function () {\n${n.parameters.jsCode}\n})`, { filename: n.name });
			} catch (e) {
				fehler.push(`${n.name}: Syntaxfehler im Code: ${e.message}`);
			}
		}
		if (n.type === 'n8n-nodes-base.postgres') {
			if (/--/.test(n.parameters.query)) fehler.push(`${n.name}: SQL enthält Kommentar (pg-promise-Risiko)`);
			if (/\{\{/.test(n.parameters.query)) fehler.push(`${n.name}: SQL enthält Ausdruck {{ }} (Injection-Risiko)`);
			const params = [...n.parameters.query.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
			const max = params.length ? Math.max(...params) : 0;
			const anzahl = (n.parameters.options.queryReplacement.match(/^=\{\{\s*\[([\s\S]*)\]\s*\}\}$/) || [, ''])[1];
			if (!anzahl && max > 0) fehler.push(`${n.name}: Parameter müssen als Array-Ausdruck übergeben werden`);
		}
		if (n.type === 'n8n-nodes-base.dataTable') {
			const t = n.parameters.dataTableId;
			if (!t || t.mode !== 'name' || !/^epa_[a-z_]+$/.test(t.value)) fehler.push(`${n.name}: Data Table muss per Name (epa_…) referenziert sein`);
			if (['update', 'upsert', 'deleteRows'].includes(n.parameters.operation) && !(n.parameters.filters && n.parameters.filters.conditions.length)) fehler.push(`${n.name}: ${n.parameters.operation} ohne Bedingung`);
			if (n.parameters.operation === 'deleteRows' && n.parameters.matchType !== 'allConditions') fehler.push(`${n.name}: Löschen nur mit "alle Bedingungen"`);
		}
		if (n.type === 'n8n-nodes-base.executeWorkflow') {
			const w = n.parameters.workflowId;
			const selbst = w.mode === 'id' && typeof w.value === 'string' && w.value.startsWith('={{');
			if (!selbst && !alleNamen.has(w.cachedResultName)) fehler.push(`${n.name}: ruft unbekannten Workflow "${w.cachedResultName}" auf`);
		}
		if (n.type === 'n8n-nodes-base.httpRequest') {
			const p = n.parameters;
			if (p.authentication !== 'predefinedCredentialType' || !p.nodeCredentialType) fehler.push(`${n.name}: HTTP-Aufruf ohne vordefiniertes Credential`);
			if (/[?&](api[_-]?key|token|access_token)=/i.test(String(p.url))) fehler.push(`${n.name}: Secret in der URL`);
			if (p.sendHeaders) fehler.push(`${n.name}: eigene Header (Secrets nur über Credentials)`);
		}
		if (n.type === 'n8n-nodes-base.microsoftTeams' && !(n.parameters.options && n.parameters.options.includeLinkToWorkflow === false)) {
			fehler.push(`${n.name}: Teams-Nachricht ohne includeLinkToWorkflow=false`);
		}
	}
	for (const [von, c] of Object.entries(json.connections)) {
		if (!namen.has(von)) fehler.push(`Verbindung von unbekanntem Node ${von}`);
		for (const ausgang of c.main) for (const z of ausgang) if (!namen.has(z.node)) fehler.push(`Verbindung zu unbekanntem Node ${z.node}`);
	}
	const verbunden = new Set(Object.keys(json.connections));
	for (const c of Object.values(json.connections)) for (const a of c.main) for (const z of a) verbunden.add(z.node);
	for (const n of json.nodes) {
		if (n.type !== 'n8n-nodes-base.stickyNote' && !verbunden.has(n.name)) fehler.push(`${n.name}: nicht verbunden`);
	}
	if (!json.nodes.some((n) => n.type === 'n8n-nodes-base.stickyNote')) fehler.push('Sticky Note mit Zweck fehlt');
	fehler.push(...haertung(json));
	return fehler;
}

// Härtung (M6)
// Öffentliche Seiten, jeweils mit geheimem Schlüssel in der Adresse (nur Hash gespeichert).
const WEBHOOK_ERLAUBT = new Set(['EPA-07 Freigabe-Endpunkt', 'EPA-12 Übersicht-Seite', 'EPA-14 Betrieb-Dashboard']);
const SECRET_MUSTER = [
	[/sk-(proj-)?[A-Za-z0-9_-]{20,}/, 'OpenAI-Schlüssel'],
	[/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\./, 'JWT/Access-Token'],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'privater Schlüssel'],
	[/\b(client_secret|password|passwort|api_key|apikey)"\s*:\s*"(?!<)[^"=][^"]{5,}"/i, 'Passwort/Secret-Feld'],
	[/https?:\/\/[^\s"'/]*:[^\s"'@/]+@/, 'Zugangsdaten in URL'],
];

function haertung(json) {
	const fehler = [];
	const text = JSON.stringify(json);
	for (const [re, was] of SECRET_MUSTER) if (re.test(text)) fehler.push(`möglicher Klartext-Secret (${was})`);
	if (json.settings.callerPolicy !== 'workflowsFromSameOwner') fehler.push('settings.callerPolicy muss workflowsFromSameOwner sein');
	for (const n of json.nodes) {
		if (n.type === 'n8n-nodes-base.webhook' && !WEBHOOK_ERLAUBT.has(json.name)) fehler.push(`${n.name}: öffentlicher Webhook außerhalb von EPA-07/EPA-12/EPA-14`);
	}
	// Wer Freigabe-Links erzeugt oder anzeigt, darf erfolgreiche Ausführungen nicht speichern (Klartext-Token).
	const token = json.nodes.some((n) => n.type === 'n8n-nodes-base.code' && /tokenErzeugen\(crypto\)/.test(n.parameters.jsCode)) || json.nodes.some((n) => n.type === 'n8n-nodes-base.webhook');
	if (token && json.settings.saveDataSuccessExecution !== 'none') fehler.push('erzeugt/verarbeitet Freigabe-Links: settings.saveDataSuccessExecution muss "none" sein');
	return fehler;
}

function pruefeAlle() {
	const ergebnis = [];
	for (const ordner of ['workflows', 'workflows-postgres']) {
		const dir = path.join(ROOT, ordner);
		const dateien = fs.readdirSync(dir).filter((d) => d.endsWith('.json'));
		const wfs = dateien.map((d) => [d, JSON.parse(fs.readFileSync(path.join(dir, d), 'utf8'))]);
		const alleNamen = new Set(wfs.map(([, w]) => w.name));
		ergebnis.push(...wfs.map(([d, w]) => ({ datei: `${ordner}/${d}`, fehler: pruefeWorkflow(w, alleNamen) })));
	}
	return ergebnis;
}

if (require.main === module) {
	let ok = true;
	for (const r of pruefeAlle()) {
		console.log(`${r.fehler.length ? 'FEHLER' : 'ok    '} ${r.datei}`);
		for (const f of r.fehler) console.log(`       - ${f}`);
		if (r.fehler.length) ok = false;
	}
	process.exit(ok ? 0 : 1);
}

module.exports = { pruefeWorkflow, pruefeAlle, haertung };
