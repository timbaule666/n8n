'use strict';
const { Workflow, bedingung, bedingungen, codeDatei } = require('../../tools/lib/n8n');

const S = "$('Status prüfen').first().json";

module.exports = function () {
	const wf = new Workflow('EPA SW Log-Karte');
	wf.notiz('Notiz Zweck', [-80, -360], [
		'## EPA SW Log-Karte',
		'**Zweck:** Schickt bei "Bereit zur Bearbeitung" oder "Abgeschlossen" eine Abschlusskarte (Adaptive Card) mit erfassten Daten und Zeitleiste aus dem Audit-Log in den Teams-Kanal "Logs" des Kunden.',
		'**Trigger:** Aufruf durch "EPA SW Status setzen" (wartet nicht auf das Ende).',
		'**Eingaben:** kunde_id, vorgangs_id, neuer_status.',
		'**Config:** epa_config_allgemein.log_channel_id (leer = keine Karte), benachrichtigung.team_id.',
		'**Fehler:** Wirft nie nach außen; ohne Kanal oder bei Fehlern wird nichts gesendet.',
	].join('\n'), { breite: 680, hoehe: 260 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['neuer_status', 'string'],
	]);
	const pruefen = wf.code('Status prüfen', [224, 0], [], codeDatei('log-karte-status-pruefen.js'));
	const frage = wf.node('Abschluss-Status?', 'n8n-nodes-base.if', [448, 0], {
		conditions: bedingungen([bedingung('={{ $json.weiter }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const opt = { alwaysOutputData: true, onError: 'continueRegularOutput' };
	const kunde = wf.tabelle('Kunde lesen', [672, 0], 'get', 'epa_config_allgemein', { bedingungen: [['kunde_id', 'eq', `={{ ${S}.kunde_id }}`]] }, opt);
	const vorgang = wf.tabelle('Vorgang lesen', [896, 0], 'get', 'epa_vorgaenge', { bedingungen: [['vorgangs_id', 'eq', `={{ ${S}.vorgangs_id }}`]] }, opt);
	const audit = wf.tabelle('Audit lesen', [1120, 0], 'get', 'epa_audit_log', { bedingungen: [['vorgangs_id', 'eq', `={{ ${S}.vorgangs_id }}`]], alle: true }, opt);
	const karte = wf.code('Karte bauen', [1344, 0], [], codeDatei('log-karte-karte-bauen.js'));
	const bereit = wf.node('Karte bereit?', 'n8n-nodes-base.if', [1568, 0], {
		conditions: bedingungen([bedingung('={{ $json.ok }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const senden = wf.aufrufDynamisch('Log-Karte senden', [1792, 0], "={{ /^[A-Za-z0-9]{8,32}$/.test(String($json.postfach_workflow_id || '')) ? $json.postfach_workflow_id : 'keineId0' }}", [
		['aktion', 'string', 'teams_kanal'],
		['postfach', 'string', '={{ $json.postfach }}'],
		['vorgangs_id', 'string', '={{ $json.vorgangs_id }}'],
		['html', 'string', '={{ $json.html }}'],
		['team_id', 'string', '={{ $json.team_id }}'],
		['channel_id', 'string', '={{ $json.channel_id }}'],
	], opt);

	wf.kette(trigger, pruefen, frage);
	wf.verbinde(frage, kunde, 0);
	wf.kette(kunde, vorgang, audit, karte, bereit);
	wf.verbinde(bereit, senden, 0);
	return wf;
};
