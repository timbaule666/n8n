'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

module.exports = function () {
	const wf = new Workflow('EPA-05 Error-Handler');

	wf.notiz('Notiz Zweck', [-80, -420], [
		'## EPA-05 Error-Handler',
		'**Zweck:** Fängt Abstürze aller EPA-Workflows. Bestimmt Fehlerklasse und Statuscode (src/fehlerklassen.js), schreibt die Data Table epa_fehler_log (nur IDs, Codes, bereinigte technische Meldung, keine Mail-Inhalte), sichert betroffene Vorgänge auf "Eskaliert / Manuell" (nicht bei Versionskonflikt, Sperre, Duplikat) und alarmiert den Entwickler-Kanal in Teams.',
		'**Trigger:** Error Trigger. In **jedem** EPA-Workflow unter Settings -> Error workflow eintragen (macht tools/deploy.js automatisch). Muss veröffentlicht sein.',
		'**Eingaben:** execution/workflow-Daten des fehlgeschlagenen Laufs.',
		'**Ausgabe:** Teams-Nachricht; epa_fehler_log.alarmiert_am wird gesetzt. Bleibt alarmiert_am leer, meldet der Watchdog (M6) den Fehler erneut.',
		'**Einrichten:** Im Node "Entwickler-Kanal alarmieren" Team (GUID) und Kanal auswählen bzw. eintragen und das Teams-Credential (Dienstkonto, OAuth2) zuweisen.',
	].join('\n'), { breite: 700, hoehe: 340 });

	const trigger = wf.node('Bei Workflow-Fehler', 'n8n-nodes-base.errorTrigger', [0, 0], {});

	const klassifizieren = wf.code('Fehler klassifizieren', [220, 0], ['fehlerklassen'], `
const eintrag = fehlerklassen.ausErrorTrigger($input.first().json);
return [{ json: eintrag }];
`);

	// Fällt der Speicher aus, soll der Alarm trotzdem rausgehen.
	const protokollieren = wf.tabelle('Fehler protokollieren', [440, 0], 'insert', 'epa_fehler_log', {},
		{ onError: 'continueRegularOutput', alwaysOutputData: true });

	const K = "$('Fehler klassifizieren').first().json";
	// Ein Eingang, dessen Verarbeitung abgebrochen ist, gilt nicht mehr als "in Arbeit": eine erneute Ausführung
	// derselben Mail wird dann nicht als Duplikat verworfen (src/eingang.js dedupeEntscheiden).
	const freigabeDaten = wf.code('Eingang-Freigabe vorbereiten', [440, 180], [], `
return [{ json: { status: 'fehler' } }];
`);
	const freigeben = wf.tabelle('Eingang freigeben', [660, 180], 'update', 'epa_verarbeitete_mails', {
		match: 'anyCondition',
		bedingungen: [
			['execution_id', 'eq', `={{ ${K}.execution_id || '__keine__' }}`],
			['aufrufer_execution_id', 'eq', `={{ ${K}.execution_id || '__keine__' }}`],
		],
	}, { onError: 'continueRegularOutput', alwaysOutputData: true });
	const noetig = wf.node('Vorgang sichern nötig?', 'n8n-nodes-base.if', [880, 0], {
		conditions: bedingungen([bedingung(`={{ ${K}.eskalieren }}`, { type: 'boolean', operation: 'true', singleValue: true })]),
		options: { looseTypeValidation: true },
	});

	const mandant = wf.tabelle('Mandant ermitteln', [880, -140], 'get', 'epa_vorgaenge', {
		bedingungen: [['vorgangs_id', 'eq', `={{ ${K}.vorgangs_id }}`]],
	}, { onError: 'continueRegularOutput', alwaysOutputData: true });

	const sichern = wf.aufruf('Vorgang sichern', [1100, -140], 'EPA SW Status setzen', [
		['kunde_id', 'string', '={{ $json.kunde_id }}'],
		['vorgangs_id', 'string', `={{ ${K}.vorgangs_id }}`],
		['neuer_status', 'string', 'Eskaliert / Manuell'],
		['ausloeser', 'string', 'System'],
		['details', 'object', `={{ { grund: 'Technischer Fehler', fehlercode: ${K}.fehlercode, execution_id: ${K}.execution_id } }}`],
		['referenz', 'string', `={{ 'fehler:' + (${K}.execution_id || '') }}`],
		['erwartete_version', 'number', '={{ null }}'],
		['nur_wenn_erlaubt', 'boolean', '={{ true }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });

	const eskDaten = wf.code('Eskalation vorbereiten', [1320, -140], [], `
return [{ json: { eskaliert: $input.first().json.ok === true } }];
`);
	const P = "$('Fehler protokollieren').first().json";
	const eskVermerken = wf.tabelle('Eskalation vermerken', [1540, -140], 'update', 'epa_fehler_log', {
		bedingungen: [['id', 'eq', `={{ ${P}.id ?? -1 }}`]],
	}, { onError: 'continueRegularOutput', alwaysOutputData: true });

	const vorbereiten = wf.code('Alarm vorbereiten', [1760, 0], ['fehlerklassen'], `
const e = ${K};
const protokoll = ${P};
let eskaliert = false;
let hinweis = '';
if (e.vorgangs_id && !e.eskalieren) {
	hinweis = 'Vorgang bewusst nicht eskaliert (Konflikt mit parallel laufender Verarbeitung).';
} else if ($('Vorgang sichern').isExecuted) {
	const s = $('Vorgang sichern').first().json;
	eskaliert = s.ok === true;
	if (s.error) hinweis = 'Vorgang konnte NICHT gesichert werden, bitte manuell prüfen.';
	else if (s.uebersprungen) hinweis = \`Vorgang nicht geändert (Status "\${s.alter_status}").\`;
	else if (eskaliert) hinweis = 'Vorgang wurde auf "Eskaliert / Manuell" gesetzt.';
}
const fehlerId = protokoll && protokoll.id !== undefined ? protokoll.id : null;
let html = fehlerklassen.alarmHtml(e);
if (hinweis) html += '<br>' + fehlerklassen.escapeHtml(hinweis);
if (!fehlerId) html += '<br><b>Achtung:</b> Eintrag im Fehlerlog fehlgeschlagen (Data Table prüfen).';
return [{ json: { fehler_id: fehlerId, eskaliert, alarm_html: html } }];
`);

	const teams = wf.node('Entwickler-Kanal alarmieren', 'n8n-nodes-base.microsoftTeams', [1980, 0], {
		resource: 'channelMessage',
		operation: 'create',
		teamId: { __rl: true, mode: 'id', value: '<TEAM_ID_ENTWICKLER>' },
		channelId: { __rl: true, mode: 'id', value: '<CHANNEL_ID_ENTWICKLER>' },
		contentType: 'html',
		message: '={{ $json.alarm_html }}',
		options: { includeLinkToWorkflow: false },
	}, Workflow.retry());

	const A = "$('Alarm vorbereiten').first().json";
	const vorhanden = wf.node('Fehler-ID vorhanden?', 'n8n-nodes-base.if', [2200, 0], {
		conditions: bedingungen([bedingung(`={{ ${A}.fehler_id }}`, { type: 'number', operation: 'exists', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	const alarmDaten = wf.code('Alarmzeit vorbereiten', [2420, -80], [], `
return [{ json: { alarmiert_am: new Date().toISOString() } }];
`);
	const alarmVermerken = wf.tabelle('Alarm vermerken', [2640, -80], 'update', 'epa_fehler_log', {
		bedingungen: [['id', 'eq', `={{ ${A}.fehler_id }}`]],
	});

	wf.kette(trigger, klassifizieren, protokollieren, freigabeDaten, freigeben, noetig);
	wf.verbinde(noetig, mandant, 0);
	wf.verbinde(noetig, vorbereiten, 1);
	wf.kette(mandant, sichern, eskDaten, eskVermerken, vorbereiten);
	wf.kette(vorbereiten, teams, vorhanden);
	wf.verbinde(vorhanden, alarmDaten, 0);
	wf.kette(alarmDaten, alarmVermerken);
	return wf;
};
