#!/usr/bin/env node
'use strict';
// Erzeugt workflows/*.json aus workflows-src/*.js (bettet src/-Module und SQL-Dateien ein).
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./lib/n8n');

const QUELLEN = [
	['sw-config-laden', 'EPA_SW_Config_laden.json'],
	['sw-audit-schreiben', 'EPA_SW_Audit_schreiben.json'],
	['sw-status-setzen', 'EPA_SW_Status_setzen.json'],
	['sw-vorgang-verwalten', 'EPA_SW_Vorgang_verwalten.json'],
	['epa-05-error-handler', 'EPA-05_Error-Handler.json'],
];

function bauen() {
	const ziel = path.join(ROOT, 'workflows');
	fs.mkdirSync(ziel, { recursive: true });
	const ergebnis = [];
	for (const [quelle, datei] of QUELLEN) {
		const wf = require(path.join(ROOT, 'workflows-src', `${quelle}.js`))();
		const json = wf.json();
		fs.writeFileSync(path.join(ziel, datei), JSON.stringify(json, null, 2) + '\n');
		ergebnis.push({ datei, name: json.name, nodes: json.nodes.length });
	}
	return ergebnis;
}

if (require.main === module) {
	for (const r of bauen()) console.log(`${r.datei.padEnd(34)} ${String(r.nodes).padStart(3)} Nodes  (${r.name})`);
}

module.exports = { bauen, QUELLEN };
