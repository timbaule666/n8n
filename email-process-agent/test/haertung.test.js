'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { haertung } = require('../tools/validate-workflows');

const wf = (x = {}) => ({ name: 'EPA Test', nodes: [], connections: {}, settings: { callerPolicy: 'workflowsFromSameOwner' }, ...x });
const code = (jsCode) => ({ name: 'Code', type: 'n8n-nodes-base.code', parameters: { jsCode } });

test('Härtung: sauberer Workflow ohne Befund', () => {
	assert.deepEqual(haertung(wf()), []);
});

test('Härtung: Klartext-Secrets werden erkannt', () => {
	for (const s of ['const k = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";', 'const t = "eyJhbGciOiJIUzI1NiJ9xyz.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc";', 'fetch("https://user:geheim@host.de/x")', '-----BEGIN RSA PRIVATE KEY-----']) {
		assert.match(haertung(wf({ nodes: [code(s)] })).join(), /Klartext-Secret/, s);
	}
	assert.deepEqual(haertung(wf({ nodes: [{ name: 'x', type: 't', parameters: { password: '<PASSWORT>' } }] })), []);
	assert.match(haertung(wf({ nodes: [{ name: 'x', type: 't', parameters: { password: 'hunter2hunter2' } }] })).join(), /Passwort/);
});

test('Härtung: Webhook nur in EPA-07, Token-Workflows ohne gespeicherte Erfolgsdaten, Aufrufer-Richtlinie', () => {
	const hook = { name: 'Hook', type: 'n8n-nodes-base.webhook', parameters: {} };
	assert.match(haertung(wf({ nodes: [hook] })).join(), /öffentlicher Webhook/);
	assert.match(haertung(wf({ name: 'EPA-07 Freigabe-Endpunkt', nodes: [hook] })).join(), /saveDataSuccessExecution/);
	assert.deepEqual(haertung(wf({ name: 'EPA-07 Freigabe-Endpunkt', nodes: [hook], settings: { callerPolicy: 'workflowsFromSameOwner', saveDataSuccessExecution: 'none' } })), []);
	assert.match(haertung(wf({ nodes: [code('freigabe.tokenErzeugen(crypto)')] })).join(), /saveDataSuccessExecution/);
	assert.match(haertung(wf({ settings: { callerPolicy: 'any' } })).join(), /callerPolicy/);
});
