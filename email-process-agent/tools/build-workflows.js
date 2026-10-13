#!/usr/bin/env node
'use strict';
// Erzeugt die Workflow-JSONs aus workflows-src/<variante>/*.js (bettet src/-Module und SQL ein).
//   workflows/           Speicher: n8n Data Tables (Standard)
//   workflows-postgres/  Speicher: PostgreSQL
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./lib/n8n');

const M1 = [
	['sw-config-laden', 'EPA_SW_Config_laden.json'],
	['sw-audit-schreiben', 'EPA_SW_Audit_schreiben.json'],
	['sw-status-setzen', 'EPA_SW_Status_setzen.json'],
	['sw-vorgang-verwalten', 'EPA_SW_Vorgang_verwalten.json'],
	['epa-05-error-handler', 'EPA-05_Error-Handler.json'],
];
const M2 = [
	['sw-llm-aufrufen', 'EPA_SW_LLM_aufrufen.json'],
	['sw-benachrichtigen', 'EPA_SW_Benachrichtigen.json'],
	['epa-01-eingang-verarbeiten', 'EPA-01_Eingang_verarbeiten.json'],
	['epa-00-postfach', 'EPA-00_Postfach_Vorlage.json'],
];
// Die Postgres-Variante bleibt auf dem Stand von M1 (Speicher-Standard sind Data Tables).
const DATEIEN = { datatable: [...M1, ...M2], postgres: M1 };
const VARIANTEN = { datatable: 'workflows', postgres: 'workflows-postgres' };

function bauen() {
	const ergebnis = [];
	for (const [variante, ordner] of Object.entries(VARIANTEN)) {
		const ziel = path.join(ROOT, ordner);
		fs.mkdirSync(ziel, { recursive: true });
		for (const [quelle, datei] of DATEIEN[variante]) {
			const json = require(path.join(ROOT, 'workflows-src', variante, `${quelle}.js`))().json();
			fs.writeFileSync(path.join(ziel, datei), JSON.stringify(json, null, 2) + '\n');
			ergebnis.push({ ordner, datei, name: json.name, nodes: json.nodes.length });
		}
	}
	// Prompts als Datei für den Import in die Data Table epa_prompts (Quelle bleibt prompts/<version>/*.md)
	const { allePrompts } = require('./lib/prompts');
	fs.writeFileSync(path.join(ROOT, 'config', 'datatables', 'prompts.json'), JSON.stringify(allePrompts(), null, 1) + '\n');
	return ergebnis;
}

if (require.main === module) {
	for (const r of bauen()) console.log(`${(r.ordner + '/' + r.datei).padEnd(52)} ${String(r.nodes).padStart(3)} Nodes`);
}

module.exports = { bauen, DATEIEN, VARIANTEN };
