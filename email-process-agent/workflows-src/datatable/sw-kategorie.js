'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

module.exports = function () {
	const wf = new Workflow('EPA SW Outlook-Kategorie');

	wf.notiz('Notiz Zweck', [-80, -420], [
		'## EPA SW Outlook-Kategorie',
		'**Zweck:** Markiert die Kundenmails eines Vorgangs in Outlook passend zum Status, z. B. grün "AI Geprüft" bei "Bereit zur Bearbeitung" und rot "AI Rückfragen", solange eine Rückfrage läuft (Config: outlook_kategorien, Regeln: src/kategorien.js).',
		'**Trigger:** Aufruf durch "EPA SW Status setzen" nach jedem Statuswechsel, ohne Warten (die Verarbeitung läuft unabhängig davon weiter).',
		'**Eingaben:** kunde_id, vorgangs_id, neuer_status.',
		'**Fehler:** Markierungen sind Komfort. Jeder Schritt läuft mit "weiter bei Fehler"; ein Fehler hier ändert nie den Vorgang.',
	].join('\n'), { breite: 700, hoehe: 260 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['neuer_status', 'string'],
	]);
	const weiter = { onError: 'continueRegularOutput', alwaysOutputData: true };
	const config = wf.aufruf('Config laden', [220, 0], 'EPA SW Config laden', [
		['kunde_id', 'string', '={{ $json.kunde_id }}'],
		['postfach', 'string', ''],
	], weiter);
	const planen = wf.code('Markierung planen', [440, 0], ['kategorien'], `
const e = $('Bei Aufruf').first().json;
const c = ($input.first().json || {}).config;
if (!c || !c.postfach_workflow_id) return [{ json: { aktion: null } }];
const plan = kategorien.plan(c.outlook_kategorien || {}, e.neuer_status);
return [{ json: { ...plan, postfach: c.postfach, postfach_workflow_id: c.postfach_workflow_id } }];
`, weiter);
	const noetig = wf.node('Markierung nötig?', 'n8n-nodes-base.if', [660, 0], {
		conditions: bedingungen([bedingung('={{ Boolean($json.aktion) }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const vorgang = wf.aufruf('Vorgang lesen', [880, -100], 'EPA SW Vorgang verwalten', [
		['aktion', 'string', 'lesen'],
		['kunde_id', 'string', "={{ $('Bei Aufruf').first().json.kunde_id }}"],
		['vorgangs_id', 'string', "={{ $('Bei Aufruf').first().json.vorgangs_id }}"],
		['daten', 'object', '={{ {} }}'],
		['erwartete_version', 'number', '={{ null }}'],
		['referenz', 'string', ''],
		['lock_sekunden', 'number', '={{ null }}'],
	], weiter);
	const auftrag = wf.code('Auftrag bauen', [1100, -100], ['kategorien'], `
const p = $('Markierung planen').first().json;
const v = ($input.first().json || {}).vorgang;
const ids = kategorien.messageIds(v);
if (!ids.length) return [];
return [{ json: { postfach: p.postfach, postfach_workflow_id: p.postfach_workflow_id, kategorien: JSON.stringify({ plan: { aktion: p.aktion, name: p.name, farbe: p.farbe, system_namen: p.system_namen }, ids }) } }];
`, weiter);
	const setzen = wf.aufrufDynamisch('Im Postfach markieren', [1320, -100], '={{ $json.postfach_workflow_id }}', [
		['aktion', 'string', 'kategorien_setzen'],
		['postfach', 'string', '={{ $json.postfach }}'],
		['graph_id', 'string', ''],
		['internet_message_id', 'string', ''],
		['entwurf_id', 'string', ''],
		['freigabe_id', 'string', ''],
		['vorgangs_id', 'string', "={{ $('Bei Aufruf').first().json.vorgangs_id }}"],
		['html', 'string', ''],
		['kategorien', 'string', '={{ $json.kategorien }}'],
	], weiter);

	wf.kette(trigger, config, planen, noetig);
	wf.verbinde(noetig, vorgang, 0);
	wf.kette(vorgang, auftrag, setzen);
	return wf;
};
