'use strict';
// Führt Nodes aus den gebauten Workflow-JSONs so aus, wie n8n sie ausführt:
// - Postgres: Query + Parameter-Array-Ausdruck, Formatierung über pg-promise (wie n8n-nodes-base 2.43.2)
// - Code: jsCode mit $input, $, $execution, DateTime
const fs = require('node:fs');
const path = require('node:path');
const { DateTime } = require('luxon');

const ROOT = path.resolve(__dirname, '..', '..');

function workflow(datei) {
	return JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', datei), 'utf8'));
}

function node(wf, name) {
	const n = wf.nodes.find((x) => x.name === name);
	if (!n) throw new Error(`Node "${name}" fehlt in ${wf.name}`);
	return n;
}

function nodeRef(daten) {
	return (name) => {
		if (!(name in daten)) return { isExecuted: false, first: () => { throw new Error(`$('${name}') nicht ausgeführt`); } };
		const items = Array.isArray(daten[name]) ? daten[name] : [daten[name]];
		return { isExecuted: true, first: () => ({ json: items[0] }), all: () => items.map((json) => ({ json })) };
	};
}

/** Wertet den queryReplacement-Ausdruck aus und wendet die n8n-Regeln an (Objekte -> JSON, undefined wird übersprungen). */
function parameter(n, json, daten = {}) {
	const ausdruck = n.parameters.options.queryReplacement;
	const m = /^=\{\{([\s\S]*)\}\}$/.exec(ausdruck);
	if (!m) throw new Error(`Unerwarteter Ausdruck: ${ausdruck}`);
	const werte = new Function('$json', '$', `return (${m[1]});`)(json, nodeRef(daten));
	if (!Array.isArray(werte)) throw new Error('Ausdruck liefert kein Array');
	const out = [];
	for (const w of werte) {
		if (w === undefined) continue;
		out.push(typeof w === 'object' && w !== null ? JSON.stringify(w) : w);
	}
	return out;
}

async function postgres(db, pgp, wf, name, json, daten = {}) {
	const n = node(wf, name);
	const werte = parameter(n, json, daten);
	const ergebnis = await db.multi(pgp.helpers.concat([{ query: n.parameters.query, values: werte }]));
	return ergebnis.flat();
}

async function code(wf, name, inputItems, daten = {}, executionId = 'test-exec') {
	const n = node(wf, name);
	const items = (Array.isArray(inputItems) ? inputItems : [inputItems]).map((json) => ({ json }));
	const $input = { first: () => items[0], all: () => items };
	const fn = new Function('$input', '$', '$execution', 'DateTime', `return (async () => {\n${n.parameters.jsCode}\n})();`);
	return fn($input, nodeRef(daten), { id: executionId }, DateTime);
}

module.exports = { workflow, node, parameter, postgres, code, ROOT };
