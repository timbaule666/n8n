'use strict';
const { Workflow, bedingung, bedingungen } = require('../tools/lib/n8n');

module.exports = function () {
	const wf = new Workflow('EPA-05 Error-Handler');

	wf.notiz('Notiz Zweck', [-80, -400], [
		'## EPA-05 Error-Handler',
		'**Zweck:** Fängt Abstürze aller EPA-Workflows. Bestimmt Fehlerklasse und Statuscode (src/fehlerklassen.js), schreibt epa_fehler_log (nur IDs, Codes, bereinigte technische Meldung, keine Mail-Inhalte), sichert betroffene Vorgänge auf "Eskaliert / Manuell" und alarmiert den Entwickler-Kanal in Teams.',
		'**Trigger:** Error Trigger. In **jedem** EPA-Workflow unter Settings -> Error workflow eintragen (macht tools/deploy.js automatisch).',
		'**Eingaben:** execution/workflow-Daten des fehlgeschlagenen Laufs.',
		'**Ausgabe:** Teams-Nachricht; epa_fehler_log.alarmiert_am wird gesetzt. Bleibt alarmiert_am leer, meldet der Watchdog (M6) den Fehler erneut.',
		'**Einrichten:** Im Node "Entwickler-Kanal alarmieren" Team- und Kanal-ID eintragen und das Teams-Credential (Dienstkonto, OAuth2) zuweisen.',
	].join('\n'), { breite: 680, hoehe: 320 });

	const trigger = wf.node('Bei Workflow-Fehler', 'n8n-nodes-base.errorTrigger', [0, 0], {});

	const klassifizieren = wf.code('Fehler klassifizieren', [220, 0], ['fehlerklassen'], `
const eintrag = fehlerklassen.ausErrorTrigger($input.first().json);
return [{ json: eintrag }];
`);

	// Fällt die Datenbank aus, soll der Alarm trotzdem rausgehen.
	const protokollieren = wf.postgres('Fehler protokollieren', [440, 0], 'fehler_protokollieren', '[ $json ]',
		{ retryOnFail: false, onError: 'continueRegularOutput', alwaysOutputData: true });

	const betroffen = wf.node('Vorgang betroffen?', 'n8n-nodes-base.if', [660, 0], {
		conditions: bedingungen([
			bedingung("={{ $('Fehler klassifizieren').first().json.vorgangs_id }}", { type: 'string', operation: 'notEmpty', singleValue: true }),
		]),
		options: { looseTypeValidation: true },
	});

	const mandant = wf.postgres('Mandant ermitteln', [880, -120], 'fehler_vorgang_kunde',
		"[ $('Fehler klassifizieren').first().json.vorgangs_id ]",
		{ onError: 'continueRegularOutput', alwaysOutputData: true });

	const sichern = wf.aufruf('Vorgang sichern', [1100, -120], 'EPA SW Status setzen', [
		['kunde_id', 'string', '={{ $json.kunde_id }}'],
		['vorgangs_id', 'string', "={{ $('Fehler klassifizieren').first().json.vorgangs_id }}"],
		['neuer_status', 'string', 'Eskaliert / Manuell'],
		['ausloeser', 'string', 'System'],
		['details', 'object', "={{ { grund: 'Technischer Fehler', fehlercode: $('Fehler klassifizieren').first().json.fehlercode, execution_id: $('Fehler klassifizieren').first().json.execution_id } }}"],
		['referenz', 'string', "={{ 'fehler:' + ($('Fehler klassifizieren').first().json.execution_id || '') }}"],
		['erwartete_version', 'number', '={{ null }}'],
		['nur_wenn_erlaubt', 'boolean', '={{ true }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });

	const vorbereiten = wf.code('Alarm vorbereiten', [1320, 0], ['fehlerklassen'], `
const e = $('Fehler klassifizieren').first().json;
const protokoll = $('Fehler protokollieren').first().json;
let eskaliert = false;
let hinweis = '';
if ($('Vorgang sichern').isExecuted) {
	const s = $('Vorgang sichern').first().json;
	eskaliert = s.ok === true;
	if (s.error) hinweis = 'Vorgang konnte NICHT gesichert werden, bitte manuell prüfen.';
	else if (s.uebersprungen) hinweis = \`Vorgang nicht geändert (Status "\${s.alter_status}").\`;
	else if (eskaliert) hinweis = 'Vorgang wurde auf "Eskaliert / Manuell" gesetzt.';
}
const fehlerId = protokoll && protokoll.fehler_id ? protokoll.fehler_id : null;
let html = fehlerklassen.alarmHtml(e);
if (hinweis) html += '<br>' + fehlerklassen.escapeHtml(hinweis);
if (!fehlerId) html += '<br><b>Achtung:</b> Eintrag im Fehlerlog fehlgeschlagen (Datenbank prüfen).';
return [{ json: { fehler_id: fehlerId, eskaliert, alarm_html: html } }];
`);

	const teams = wf.node('Entwickler-Kanal alarmieren', 'n8n-nodes-base.microsoftTeams', [1540, 0], {
		resource: 'channelMessage',
		operation: 'create',
		teamId: { __rl: true, mode: 'id', value: '<TEAM_ID_ENTWICKLER>' },
		channelId: { __rl: true, mode: 'id', value: '<CHANNEL_ID_ENTWICKLER>' },
		contentType: 'html',
		message: '={{ $json.alarm_html }}',
		options: {},
	}, Workflow.retry());

	const kennzeichnen = wf.node('Fehler-ID vorhanden?', 'n8n-nodes-base.if', [1760, 0], {
		conditions: bedingungen([
			bedingung("={{ $('Alarm vorbereiten').first().json.fehler_id }}", { type: 'number', operation: 'exists', singleValue: true }),
		]),
		options: { looseTypeValidation: true },
	});

	const vermerken = wf.postgres('Alarm vermerken', [1980, -80], 'fehler_alarm_vermerken',
		"[ $('Alarm vorbereiten').first().json.fehler_id, $('Alarm vorbereiten').first().json.eskaliert ]");

	wf.kette(trigger, klassifizieren, protokollieren, betroffen);
	wf.verbinde(betroffen, mandant, 0);
	wf.verbinde(mandant, sichern);
	wf.verbinde(sichern, vorbereiten);
	wf.verbinde(betroffen, vorbereiten, 1);
	wf.kette(vorbereiten, teams, kennzeichnen);
	wf.verbinde(kennzeichnen, vermerken, 0);
	return wf;
};
