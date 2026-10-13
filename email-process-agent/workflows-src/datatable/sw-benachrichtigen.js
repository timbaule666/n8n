'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

module.exports = function () {
	const wf = new Workflow('EPA SW Benachrichtigen');

	wf.notiz('Notiz Zweck', [-80, -400], [
		'## EPA SW Benachrichtigen',
		'**Zweck:** Info-Meldungen an Mitarbeiter (Teams-Kanal aus der Kunden-Config). Kanal-Adapter: ein Wechsel auf Slack betrifft nur diesen Workflow.',
		'**Trigger:** Aufruf durch andere Workflows.',
		'**Eingaben:** kunde_id, vorgangs_id, team_id, channel_id, nachricht_html, anlass.',
		'**Ausgabe:** { gesendet, fehler_id }',
		'**Fehler:** Ein Versandfehler bricht die Verarbeitung NICHT ab. Er wird in epa_fehler_log eingetragen (alarmiert_am leer), der Watchdog (M6) meldet ihn an den Entwickler-Kanal.',
		'**Einrichten:** Im Node "Teams-Nachricht senden" das Teams-Credential (OAuth2, delegiert) zuweisen.',
	].join('\n'), { breite: 680, hoehe: 320 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['team_id', 'string'],
		['channel_id', 'string'],
		['nachricht_html', 'string'],
		['anlass', 'string'],
	]);

	const eingabe = wf.code('Eingabe prüfen', [220, 0], ['fehlerklassen'], `
const e = $input.first().json;
const vid = e.vorgangs_id || null;
if (!e.team_id || !e.channel_id) throw fehlerklassen.epaFehler('KONFIGURATIONSFEHLER', vid, 'Teams-Ziel (team_id/channel_id) fehlt in der Config');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.team_id)) throw fehlerklassen.epaFehler('KONFIGURATIONSFEHLER', vid, 'team_id muss eine GUID sein');
if (typeof e.nachricht_html !== 'string' || !e.nachricht_html.trim()) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', vid, 'Nachricht fehlt');
return [{ json: { ...e, vorgangs_id: vid } }];
`);

	const senden = wf.node('Teams-Nachricht senden', 'n8n-nodes-base.microsoftTeams', [440, 0], {
		resource: 'channelMessage',
		operation: 'create',
		teamId: { __rl: true, mode: 'id', value: '={{ $json.team_id }}' },
		channelId: { __rl: true, mode: 'id', value: '={{ $json.channel_id }}' },
		contentType: 'html',
		message: '={{ $json.nachricht_html }}',
		options: { includeLinkToWorkflow: false },
	}, Workflow.retry({ onError: 'continueRegularOutput', alwaysOutputData: true }));

	const pruefen = wf.code('Versand prüfen', [660, 0], ['fehlerklassen'], `
const e = $('Eingabe prüfen').first().json;
const r = $input.first().json || {};
if (!r.error) return [{ json: { gesendet: true } }];
const meldung = typeof r.error === 'string' ? r.error : (r.error.message || 'Teams-Versand fehlgeschlagen');
return [{ json: {
	gesendet: false,
	fehler: {
		statuscode: 502, fehlercode: 'UPSTREAM_FEHLER', klasse: 'Upstream', retrybar: true, eskalieren: false,
		workflow_id: String($workflow.id), workflow_name: $workflow.name, node: 'Teams-Nachricht senden',
		execution_id: String($execution.id), execution_url: null, modus: $execution.mode,
		vorgangs_id: e.vorgangs_id, kunde_id: e.kunde_id || null,
		meldung: fehlerklassen.bereinigeMeldung(\`Meldung "\${e.anlass || '-'}" nicht zugestellt: \${meldung}\`),
		eskaliert: false, alarmiert_am: null,
	},
} }];
`);

	const fehlgeschlagen = wf.node('Versand fehlgeschlagen?', 'n8n-nodes-base.if', [880, 0], {
		conditions: bedingungen([bedingung('={{ $json.gesendet }}', { type: 'boolean', operation: 'false', singleValue: true })]),
		options: {},
	});
	const fehlerZeile = wf.code('Fehlerlog vorbereiten', [1100, -100], [], `
return [{ json: $input.first().json.fehler }];
`);
	const protokoll = wf.tabelle('Fehler protokollieren', [1320, -100], 'insert', 'epa_fehler_log', {}, { onError: 'continueRegularOutput' });
	const melden = wf.code('Ergebnis melden', [1540, 0], [], `
const v = $('Versand prüfen').first().json;
const p = $('Fehler protokollieren').isExecuted ? $('Fehler protokollieren').first().json : null;
return [{ json: { gesendet: v.gesendet, fehler_id: p && p.id !== undefined ? p.id : null } }];
`);

	wf.kette(trigger, eingabe, senden, pruefen, fehlgeschlagen);
	wf.verbinde(fehlgeschlagen, fehlerZeile, 0);
	wf.verbinde(fehlgeschlagen, melden, 1);
	wf.kette(fehlerZeile, protokoll, melden);
	return wf;
};
