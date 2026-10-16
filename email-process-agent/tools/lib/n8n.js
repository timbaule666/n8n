'use strict';
// Hilfsfunktionen zum Erzeugen von n8n-Workflow-JSON (Node-Versionen geprüft gegen n8n-nodes-base 2.43.2,
// enthalten in n8n 2.43.4).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

const VERSIONEN = Object.freeze({
	'n8n-nodes-base.executeWorkflowTrigger': 1.1,
	'n8n-nodes-base.executeWorkflow': 1.3,
	'n8n-nodes-base.errorTrigger': 1,
	'n8n-nodes-base.code': 2,
	'n8n-nodes-base.postgres': 2.6,
	'n8n-nodes-base.if': 2.3,
	'n8n-nodes-base.switch': 3.4,
	'n8n-nodes-base.microsoftTeams': 2,
	'n8n-nodes-base.stickyNote': 1,
	'n8n-nodes-base.dataTable': 1.1,
	'n8n-nodes-base.webhook': 2,
	'n8n-nodes-base.respondToWebhook': 1.5,
	'n8n-nodes-base.httpRequest': 4.2,
	'n8n-nodes-base.wait': 1.1,
	'n8n-nodes-base.extractFromFile': 1.1,
	'n8n-nodes-base.microsoftOutlookTrigger': 1,
	'n8n-nodes-base.scheduleTrigger': 1.2,
	'n8n-nodes-base.manualTrigger': 1,
	'n8n-nodes-base.telegram': 1.2, // nur EPA-T2 (interne Tests)
	'n8n-nodes-base.gmail': 2.1, // nur EPA-11 (Prüfpostfach des Betreibers)
});

function uuid(...teile) {
	const h = crypto.createHash('sha256').update(teile.join('|')).digest('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Liest ein Modul aus src/ und kapselt es, damit es im Code-Node ohne require läuft. */
function modul(name) {
	const quelle = fs.readFileSync(path.join(ROOT, 'src', `${name}.js`), 'utf8').replace(/^'use strict';\n/, '');
	return [
		`// ===== eingebettet aus src/${name}.js – nicht hier bearbeiten, sondern im Repo (npm run build) =====`,
		`const ${name} = (() => {`,
		'const module = { exports: {} };',
		quelle.trim(),
		'return module.exports;',
		'})();',
		`// ===== Ende src/${name}.js =====`,
	].join('\n');
}

/** Code-Node-Quelltext aus Modulen und eigener Logik. */
function codeMit(module, logik) {
	return [...module.map(modul), '', '// ----- Node-Logik -----', logik.trim(), ''].join('\n');
}

/**
 * Liest eine SQL-Datei und entfernt Kommentarzeilen. Wichtig: Der Postgres-Node formatiert Parameter
 * clientseitig (pg-promise). Ein $n in einem Kommentar würde ersetzt; ein Wert mit Zeilenumbruch könnte
 * den Kommentar beenden. Deshalb dürfen Kommentare nie im ausgelieferten SQL stehen.
 */
function sql(name) {
	const roh = fs.readFileSync(path.join(ROOT, 'workflows-src', 'sql', `${name}.sql`), 'utf8');
	return roh
		.split('\n')
		.filter((z) => !z.trim().startsWith('--'))
		.join('\n')
		.trim();
}

function sqlKopf(name) {
	const roh = fs.readFileSync(path.join(ROOT, 'workflows-src', 'sql', `${name}.sql`), 'utf8');
	return roh
		.split('\n')
		.filter((z) => z.trim().startsWith('--'))
		.map((z) => z.replace(/^\s*--\s?/, ''))
		.join('\n');
}

class Workflow {
	constructor(name, { beschreibung } = {}) {
		this.name = name;
		this.beschreibung = beschreibung || '';
		this.nodes = [];
		this.connections = {};
		this.settings = { executionOrder: 'v1', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' };
	}

	node(name, type, position, parameters, extra = {}) {
		if (this.nodes.some((n) => n.name === name)) throw new Error(`Node-Name doppelt: ${name}`);
		if (!(type in VERSIONEN)) throw new Error(`Node-Typ ohne geprüfte Version: ${type}`);
		const n = {
			parameters,
			id: uuid(this.name, name),
			name,
			type,
			typeVersion: VERSIONEN[type],
			position,
			...extra,
		};
		this.nodes.push(n);
		return name;
	}

	/** Netzwerk-/DB-Node: Retries für transiente Fehler (Bauplan 3). */
	static retry(extra = {}) {
		return { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, ...extra };
	}

	code(name, position, module, logik, extra = {}) {
		return this.node(name, 'n8n-nodes-base.code', position, { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: codeMit(module, logik) }, extra);
	}

	postgres(name, position, sqlName, ersetzungen, extra = {}) {
		return this.node(
			name,
			'n8n-nodes-base.postgres',
			position,
			{
				operation: 'executeQuery',
				query: sql(sqlName),
				options: { queryReplacement: `={{ ${ersetzungen} }}` },
			},
			{ ...Workflow.retry(), notes: sqlKopf(sqlName), ...extra },
		);
	}

	/**
	 * Data-Table-Node. op: get | insert | update | upsert | deleteRows. bedingungen: [[spalte, bedingung, wert], ...]
	 * Schreibende Operationen übernehmen das Eingabe-Item 1:1 als Zeile (autoMapInputData).
	 */
	tabelle(name, position, op, tabelle, { bedingungen = [], match = 'allConditions', alle = false, limit = 1, sortierung } = {}, extra = {}) {
		const p = { resource: 'row', operation: op, dataTableId: { __rl: true, mode: 'name', value: tabelle } };
		if (op === 'get' || op === 'update' || op === 'upsert' || op === 'deleteRows') {
			p.matchType = match;
			p.filters = { conditions: bedingungen.map(([keyName, condition, keyValue]) => (keyValue === undefined ? { keyName, condition } : { keyName, condition, keyValue })) };
		}
		if (op === 'get') {
			if (alle) p.returnAll = true;
			else p.limit = limit;
			if (sortierung) {
				p.orderBy = true;
				p.orderByColumn = sortierung[0];
				p.orderByDirection = sortierung[1];
			}
		}
		if (op === 'insert' || op === 'update' || op === 'upsert') {
			p.columns = { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] };
			p.options = {};
		}
		const lesend = op === 'get';
		return this.node(name, 'n8n-nodes-base.dataTable', position, p, { ...(lesend ? Workflow.retry() : {}), ...extra });
	}

	trigger(name, position, eingaben) {
		return this.node(name, 'n8n-nodes-base.executeWorkflowTrigger', position, {
			inputSource: 'workflowInputs',
			workflowInputs: { values: eingaben.map(([n, t]) => ({ name: n, type: t })) },
		});
	}

	/** Aufruf eines Sub-Workflows. Die ID wird beim Deploy anhand des Namens gesetzt. */
	aufruf(name, position, zielWorkflow, eingaben, extra = {}, modus = 'once') {
		return this.node(
			name,
			'n8n-nodes-base.executeWorkflow',
			position,
			{
				workflowId: { __rl: true, mode: 'list', value: `EPA_REF:${zielWorkflow}`, cachedResultName: zielWorkflow },
				workflowInputs: {
					mappingMode: 'defineBelow',
					value: Object.fromEntries(eingaben.map(([n, , ausdruck]) => [n, ausdruck])),
					matchingColumns: [],
					schema: eingaben.map(([n, t]) => ({
						id: n,
						displayName: n,
						required: false,
						defaultMatch: false,
						display: true,
						canBeUsedToMatch: true,
						type: t,
						removed: false,
					})),
					attemptToConvertTypes: false,
					convertFieldsToString: false,
				},
				mode: modus,
				options: { waitForSubWorkflow: true },
			},
			extra,
		);
	}

	/**
	 * Aufruf eines Workflows, dessen ID erst zur Laufzeit feststeht (z. B. Postfach-Workflow aus der Config).
	 * Wird beim Deploy nicht umgeschrieben.
	 */
	aufrufDynamisch(name, position, idAusdruck, eingaben, extra = {}, modus = 'once') {
		return this.node(
			name,
			'n8n-nodes-base.executeWorkflow',
			position,
			{
				workflowId: { __rl: true, mode: 'id', value: idAusdruck },
				workflowInputs: {
					mappingMode: 'defineBelow',
					value: Object.fromEntries(eingaben.map(([n, , ausdruck]) => [n, ausdruck])),
					matchingColumns: [],
					schema: eingaben.map(([n, t]) => ({ id: n, displayName: n, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: t, removed: false })),
					attemptToConvertTypes: false,
					convertFieldsToString: false,
				},
				mode: modus,
				options: { waitForSubWorkflow: true },
			},
			extra,
		);
	}

	notiz(name, position, inhalt, { breite = 520, hoehe = 300, farbe = 7 } = {}) {
		return this.node(name, 'n8n-nodes-base.stickyNote', position, { content: inhalt, width: breite, height: hoehe, color: farbe });
	}

	verbinde(von, nach, ausgang = 0, eingang = 0) {
		for (const n of [von, nach]) if (!this.nodes.some((x) => x.name === n)) throw new Error(`Unbekannter Node in Verbindung: ${n}`);
		const c = (this.connections[von] = this.connections[von] || { main: [] });
		while (c.main.length <= ausgang) c.main.push([]);
		c.main[ausgang].push({ node: nach, type: 'main', index: eingang });
	}

	kette(...namen) {
		for (let i = 0; i < namen.length - 1; i++) this.verbinde(namen[i], namen[i + 1]);
	}

	json() {
		return {
			name: this.name,
			nodes: this.nodes,
			connections: this.connections,
			settings: this.settings,
			pinData: {},
			meta: { templateCredsSetupCompleted: false },
			tags: [],
		};
	}
}

/** Bedingung für If/Switch (Filter-Version 3 ab If 2.3 / Switch 3.4). */
function bedingung(leftValue, operator, rightValue) {
	const c = { id: uuid('bedingung', leftValue, JSON.stringify(operator), String(rightValue)), leftValue, operator };
	if (rightValue !== undefined) c.rightValue = rightValue;
	return c;
}

function bedingungen(liste, combinator = 'and') {
	return {
		options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
		conditions: liste,
		combinator,
	};
}

module.exports = { Workflow, VERSIONEN, modul, codeMit, sql, sqlKopf, uuid, bedingung, bedingungen, ROOT };
