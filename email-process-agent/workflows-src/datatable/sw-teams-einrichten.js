'use strict';
const { Workflow, codeDatei } = require('../../tools/lib/n8n');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const ANTWORT = { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } }, timeout: 20000 };

function teams(wf, name, pos, methode, url, body, extra = {}) {
	const p = { method: methode, url, authentication: 'predefinedCredentialType', nodeCredentialType: 'microsoftTeamsOAuth2Api', options: ANTWORT };
	if (body) Object.assign(p, { sendBody: true, specifyBody: 'json', jsonBody: body });
	return wf.node(name, 'n8n-nodes-base.httpRequest', pos, p, extra);
}

module.exports = function () {
	const wf = new Workflow('EPA SW Teams einrichten');
	wf.notiz('Notiz Zweck', [1056, 192], [
		'## EPA SW Teams einrichten',
		'**Zweck:** legt im Teams-Team des Kunden die vier Kanäle an (Vollständige Anfragen, Rückfragen, Systemmeldungen, Logs) und trägt die IDs in epa_config_allgemein ein (kanaele, log_channel_id, benachrichtigung.channel_id).',
		'**Einrichten pro Kunde:** im Knoten "Kunde eintragen" kunde_id und team_name setzen, dann ausführen. Mehrfaches Ausführen ist unschädlich: vorhandene Kanäle (gleicher Name) werden wiederverwendet.',
		'**Rechte:** Das Teams-Credential muss im Tenant des Kunden Kanäle anlegen dürfen. Team und Kanal umbenennen sind optional (Fehler wird ignoriert).',
	].join('\n'), { breite: 520, hoehe: 300 });
	const start = wf.node('Start', 'n8n-nodes-base.manualTrigger', [0, 0], {});
	const kunde = wf.node('Kunde eintragen', 'n8n-nodes-base.set', [224, 0], {
		mode: 'manual',
		assignments: { assignments: [
			{ id: 'a1', name: 'kunde_id', value: '<kunde_id>', type: 'string' },
			{ id: 'a2', name: 'team_name', value: '<Teamname>', type: 'string' },
		] },
		options: {},
	});
	const lesen = wf.tabelle('Kunde lesen', [448, 0], 'get', 'epa_config_allgemein', { bedingungen: [['kunde_id', 'eq', '={{ $json.kunde_id }}']] });
	const kanaele = teams(wf, 'Kanäle lesen', [672, 0], 'GET', `={{ "${GRAPH}/teams/" + JSON.parse($json.benachrichtigung).team_id + "/channels" }}`);
	const planen = wf.code('Kanäle planen', [896, 0], [], codeDatei('teams-kanaele-planen.js'));
	const anlegen = teams(wf, 'Kanal anlegen', [1120, 0], 'POST', `={{ "${GRAPH}/teams/" + $json.team_id + "/channels" }}`,
		'={{ JSON.stringify({ displayName: $json.kanal_id ? $json.alt_name : $json.name, description: $json.beschreibung, membershipType: "standard" }) }}');
	const sammeln = wf.code('Ergebnis sammeln', [1344, 0], [], codeDatei('teams-ergebnis-sammeln.js'));
	const speichern = wf.node('Config speichern', 'n8n-nodes-base.dataTable', [1568, 0], {
		resource: 'row', operation: 'update', dataTableId: { __rl: true, mode: 'name', value: 'epa_config_allgemein' },
		matchType: 'allConditions', filters: { conditions: [{ keyName: 'kunde_id', condition: 'eq', keyValue: '={{ $json.kunde_id }}' }] },
		columns: { mappingMode: 'defineBelow', value: { kanaele: '={{ $json.kanaele }}', log_channel_id: '={{ $json.log_channel_id }}', benachrichtigung: '={{ $json.benachrichtigung }}' }, matchingColumns: [], schema: [] },
		options: {},
	});
	const team = teams(wf, 'Team umbenennen', [1792, 0], 'PATCH', `={{ "${GRAPH}/teams/" + $("Ergebnis sammeln").first().json.team_id }}`,
		'={{ JSON.stringify({ displayName: $("Ergebnis sammeln").first().json.team_name }) }}', { onError: 'continueRegularOutput' });
	const namen = wf.code('Namen vorbereiten', [1700, 300], [], codeDatei('teams-namen-vorbereiten.js'));
	const umbenennen = teams(wf, 'Kanäle umbenennen', [1920, 300], 'PATCH', '={{ $json.url }}', '={{ JSON.stringify({ displayName: $json.name }) }}');
	const fertig = wf.node('Zusammenfassung', 'n8n-nodes-base.set', [2240, 0], {
		mode: 'manual',
		assignments: { assignments: [
			{ id: 'z1', name: 'kunde_id', value: '={{ $("Ergebnis sammeln").first().json.kunde_id }}', type: 'string' },
			{ id: 'z2', name: 'kanaele', value: '={{ $("Ergebnis sammeln").first().json.kanaele }}', type: 'string' },
			{ id: 'z3', name: 'team_umbenannt', value: '={{ $("Team umbenennen").first().json.statusCode }}', type: 'string' },
			{ id: 'z4', name: 'kanaele_umbenannt', type: 'string', value: "={{ $('Kanäle umbenennen').all().map(function (i) { return i.json.statusCode; }).join(',') }}" },
		] },
		options: {},
	});
	wf.kette(start, kunde, lesen, kanaele, planen, anlegen, sammeln, speichern, team, namen, umbenennen, fertig);
	return wf;
};
