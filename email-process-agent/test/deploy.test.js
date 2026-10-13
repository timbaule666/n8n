'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verknuepfen, eindeutigeCredentials } = require('../tools/deploy');
const h = require('./helpers/n8nNodes');
const { pruefeAlle } = require('../tools/validate-workflows');

const IDS = {
	'EPA-05 Error-Handler': 'err05',
	'EPA SW Status setzen': 'status1',
	'EPA SW Config laden': 'cfg1',
	'EPA SW Audit schreiben': 'aud1',
	'EPA SW Vorgang verwalten': 'vg1',
};

test('Strukturprüfung aller gebauten Workflows ist fehlerfrei', () => {
	for (const r of pruefeAlle()) assert.deepEqual(r.fehler, [], r.datei);
});

test('Sub-Workflow-Referenz und Error Workflow werden gesetzt', () => {
	const wf = h.workflow('EPA-05_Error-Handler.json');
	const body = verknuepfen(wf, IDS, null);
	const aufruf = body.nodes.find((n) => n.name === 'Vorgang sichern');
	assert.equal(aufruf.parameters.workflowId.value, 'status1');
	assert.equal(body.settings.errorWorkflow, undefined, 'EPA-05 ist nicht sein eigener Error Workflow');
	const sw = verknuepfen(h.workflow('EPA_SW_Status_setzen.json'), IDS, null);
	assert.equal(sw.settings.errorWorkflow, 'err05');
	assert.deepEqual(Object.keys(sw).sort(), ['connections', 'name', 'nodes', 'settings']);
});

test('bestehende Credentials und eingetragene Teams-IDs bleiben erhalten, Platzhalter nicht', () => {
	const wf = h.workflow('EPA-05_Error-Handler.json', 'workflows-postgres');
	const bestehend = {
		nodes: [
			{ name: 'Fehler protokollieren', type: 'n8n-nodes-base.postgres', parameters: {}, credentials: { postgres: { id: '7', name: 'EPA – Postgres' } } },
			{ name: 'Entwickler-Kanal alarmieren', type: 'n8n-nodes-base.microsoftTeams', parameters: { teamId: { __rl: true, mode: 'id', value: 'echtes-team' }, channelId: { __rl: true, mode: 'id', value: '<CHANNEL_ID_ENTWICKLER>' } }, credentials: { microsoftTeamsOAuth2Api: { id: '9', name: 'EPA – Teams' } } },
		],
	};
	const body = verknuepfen(wf, IDS, bestehend);
	const pg = body.nodes.find((n) => n.name === 'Fehler protokollieren');
	assert.deepEqual(pg.credentials, { postgres: { id: '7', name: 'EPA – Postgres' } });
	const teams = body.nodes.find((n) => n.name === 'Entwickler-Kanal alarmieren');
	assert.equal(teams.parameters.teamId.value, 'echtes-team');
	assert.equal(teams.parameters.channelId.value, '<CHANNEL_ID_ENTWICKLER>');
	assert.ok(teams.credentials);
	assert.equal(wf.nodes.find((n) => n.name === 'Fehler protokollieren').credentials, undefined, 'Quelle bleibt unverändert');
});

test('fehlender Ziel-Workflow bricht ab', () => {
	const ids = { ...IDS };
	delete ids['EPA SW Status setzen'];
	assert.throws(() => verknuepfen(h.workflow('EPA-05_Error-Handler.json'), ids, null), /nicht gefunden/);
});

test('neue Nodes erhalten das eindeutig genutzte Credential ihres Typs', () => {
	const pg = { postgres: { id: '7', name: 'EPA – Postgres' } };
	const andere = { postgres: { id: '8', name: 'Andere DB' } };
	assert.deepEqual(eindeutigeCredentials([{ nodes: [{ type: 'n8n-nodes-base.postgres', credentials: pg }, { type: 'n8n-nodes-base.postgres', credentials: pg }] }]), { 'n8n-nodes-base.postgres': pg });
	assert.deepEqual(eindeutigeCredentials([{ nodes: [{ type: 'n8n-nodes-base.postgres', credentials: pg }] }, { nodes: [{ type: 'n8n-nodes-base.postgres', credentials: andere }] }]), {}, 'mehrdeutig -> nichts zuweisen');
	const body = verknuepfen(h.workflow('EPA-05_Error-Handler.json', 'workflows-postgres'), IDS, { nodes: [] }, { credentialsJeTyp: { 'n8n-nodes-base.postgres': pg } });
	const pgNodes = body.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres');
	assert.ok(pgNodes.length >= 4 && pgNodes.every((n) => n.credentials === pg));
	assert.equal(body.nodes.find((n) => n.type === 'n8n-nodes-base.microsoftTeams').credentials, undefined);
});

test('Data-Table-Variante kommt ohne Datenbank-Credentials aus', () => {
	for (const datei of ['EPA_SW_Config_laden.json', 'EPA_SW_Audit_schreiben.json', 'EPA_SW_Status_setzen.json', 'EPA_SW_Vorgang_verwalten.json', 'EPA-05_Error-Handler.json']) {
		const wf = h.workflow(datei);
		assert.equal(wf.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres').length, 0, datei);
		assert.ok(wf.nodes.some((n) => n.type === 'n8n-nodes-base.dataTable'), datei);
	}
});

test('Credentials werden nur bei gleichem Node-Typ übernommen', () => {
	const bestehend = { nodes: [{ name: 'Fehler protokollieren', type: 'n8n-nodes-base.postgres', parameters: {}, credentials: { postgres: { id: '7', name: 'PG' } } }] };
	const body = verknuepfen(h.workflow('EPA-05_Error-Handler.json'), IDS, bestehend);
	const n = body.nodes.find((x) => x.name === 'Fehler protokollieren');
	assert.equal(n.type, 'n8n-nodes-base.dataTable');
	assert.equal(n.credentials, undefined);
});
