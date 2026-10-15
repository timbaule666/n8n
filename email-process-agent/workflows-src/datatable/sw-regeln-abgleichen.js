'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/** HTTP-Aufruf der Google-Sheets-API mit dem Google-Sheets-Credential. */
function sheets(wf, name, pos, methode, url, body, extra = {}) {
	const p = { method: methode, url, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleSheetsOAuth2Api', options: {} };
	if (body) {
		p.sendBody = true;
		p.specifyBody = 'json';
		p.jsonBody = body;
	}
	return wf.node(name, 'n8n-nodes-base.httpRequest', pos, p, { ...Workflow.retry(), ...extra });
}

/** Spalten von epa_config_pflichtfelder für die Zuordnung "defineBelow" (nur diese werden geschrieben). */
const PFLICHT = [
	['kunde_id', 'string'], ['vorgangstyp', 'string'], ['feldname', 'string'], ['anzeigename', 'string'], ['typ', 'string'],
	['pflicht', 'boolean'], ['validierungsregel', 'string'], ['resolution_textbaustein', 'string'], ['extraktions_hinweis', 'string'],
	['platzhalter_muster', 'string'], ['reihenfolge', 'number'], ['aktiv', 'boolean'],
];
const spalten = () => ({
	mappingMode: 'defineBelow',
	value: Object.fromEntries(PFLICHT.map(([n]) => [n, `={{ $json.zeile.${n} }}`])),
	matchingColumns: [],
	schema: PFLICHT.map(([n, t]) => ({ id: n, displayName: n, required: false, defaultMatch: false, display: true, type: t, canBeUsedToMatch: true, removed: false })),
});

module.exports = function () {
	const wf = new Workflow('EPA SW Regeln abgleichen');

	wf.notiz('Notiz Zweck', [-80, -560], [
		'## EPA SW Regeln abgleichen',
		'**Zweck:** Übernimmt die Regeln eines Kunden aus seinem Google Sheet (Reiter "Allgemein" und "Pflichtfelder") in epa_config_allgemein und epa_config_pflichtfelder. Regeln und Prüfung: src/configSheet.js und src/configValidator.js.',
		'**Sicherheit:** Nur fachliche Einstellungen sind im Sheet. Postfach, Kanal, Freigeber, KI-Profil usw. ändert nur der Betreiber. Die komplette neue Config wird vorher geprüft. Bei einem Fehler wird nichts übernommen; der Agent arbeitet mit den bisherigen Regeln weiter.',
		'**Nie löschen:** Pflichtfelder, die im Sheet fehlen, werden nur deaktiviert.',
		'**Rückmeldung:** Reiter "Status" im Sheet (letzte Prüfung, Ergebnis, Meldungen). Meldung an den Kanal, wenn Regeln übernommen wurden oder ein neuer Fehler auftritt (gleiche Fehler nur einmal).',
		'**Trigger:** Aufruf durch "EPA-09 Regeln aus Google Sheets" je Kunde.',
		'**Eingaben:** kunde_id, sheet_id.',
		'**Einrichten:** Google-Sheets-Credential in "Sheet lesen" und "Status ins Sheet schreiben" zuweisen. Das Sheet muss für dieses Google-Konto freigegeben sein.',
	].join('\n'), { breite: 760, hoehe: 380 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [['kunde_id', 'string'], ['sheet_id', 'string']]);
	const E = "$('Bei Aufruf').first().json";

	const config = wf.tabelle('Config-Zeile lesen', [220, 0], 'get', 'epa_config_allgemein', { bedingungen: [['kunde_id', 'eq', `={{ ${E}.kunde_id }}`]] }, { alwaysOutputData: true });
	const felder = wf.tabelle('Pflichtfelder lesen', [440, 0], 'get', 'epa_config_pflichtfelder', { bedingungen: [['kunde_id', 'eq', `={{ ${E}.kunde_id }}`]], alle: true }, { alwaysOutputData: true, executeOnce: true });
	const lesen = sheets(wf, 'Sheet lesen', [660, 0], 'GET',
		`=${SHEETS}/{{ encodeURIComponent(${E}.sheet_id) }}/values:batchGet?ranges=Allgemein!A1:C300&ranges=Pflichtfelder!A1:Z500&valueRenderOption=FORMATTED_VALUE`,
		null, { executeOnce: true, onError: 'continueRegularOutput', alwaysOutputData: true });
	const stand = wf.tabelle('Letzten Stand lesen', [880, 0], 'get', 'epa_system_status', { bedingungen: [['schluessel', 'eq', `=config_sheet:{{ ${E}.kunde_id }}`]] }, { alwaysOutputData: true, executeOnce: true });

	const abgleichen = wf.code('Abgleichen', [1100, 0], ['configSheet', 'configValidator'], `
const e = ${E};
const allg = $('Config-Zeile lesen').first().json || {};
if (!allg.kunde_id) throw new Error('Config für ' + e.kunde_id + ' nicht gefunden');
const pf = $('Pflichtfelder lesen').all().map((i) => i.json).filter((z) => z && z.feldname);
const sheet = $('Sheet lesen').first().json || {};
const stand = $('Letzten Stand lesen').first().json || {};
let r;
if (sheet.error || !Array.isArray(sheet.valueRanges) || sheet.valueRanges.length < 2) {
	const grund = sheet.error ? String(sheet.error.message || sheet.error).slice(0, 200) : 'Antwort ohne Reiter';
	r = { fehler: ['Sheet nicht lesbar (Freigabe für das Google-Konto und Reiter "Allgemein"/"Pflichtfelder" prüfen): ' + grund], hinweise: [], allgemein_update: {}, pflicht_ops: [], aenderungen: [], lesefehler: true };
} else {
	r = configSheet.abgleichen({
		allgemein: allg,
		pflichtfelder: pf,
		reiterAllgemein: sheet.valueRanges[0].values || [],
		reiterPflicht: sheet.valueRanges[1].values || [],
		// Auch Kunden, die noch nicht aktiv sind (Einrichtung), sollen ihre Regeln pflegen können.
		validieren: (a, p) => configValidator.validiereConfig({ ...a, aktiv: true }, p),
	});
}
const ok = r.fehler.length === 0;
const geaendert = ok && r.aenderungen.length > 0;
const ergebnis = !ok ? 'Fehler – nichts übernommen, es gelten die bisherigen Regeln' : geaendert ? 'Übernommen' : 'Keine Änderung';
const zeit = new Date().toLocaleString('de-DE', { timeZone: allg.zeitzone || 'Europe/Berlin' });
const meldungen = ok ? [...r.aenderungen, ...r.hinweise] : r.fehler;
const kennung = ok ? 'ok' : configSheet.fingerabdruck(JSON.stringify(r.fehler));
const melden = geaendert || (!ok && kennung !== stand.letztes_ergebnis);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nachricht_html = '<b>Regeln aus Google Sheets: ' + esc(ergebnis) + '</b><br>Kunde: ' + esc(allg.kunde_id) + '<ul>' + meldungen.slice(0, 15).map((m) => '<li>' + esc(m) + '</li>').join('') + '</ul>' + (ok ? '' : 'Bitte im Sheet korrigieren. Details im Reiter "Status".');
let kanal = {};
try { kanal = JSON.parse(allg.benachrichtigung || '{}'); } catch { kanal = {}; }
return [{ json: {
	kunde_id: allg.kunde_id,
	uebernehmen: geaendert,
	allgemein_update: r.allgemein_update,
	pflicht_ops: r.pflicht_ops,
	aenderungen: r.aenderungen,
	status_werte: configSheet.statusZeilen({ zeit, ergebnis, meldungen }),
	melden,
	nachricht_html,
	kennung,
	kanal,
	ergebnis: ok ? (geaendert ? 'uebernommen' : 'unveraendert') : 'fehler',
	anzahl_aenderungen: r.aenderungen.length,
} }];
`);

	// Zweig 1: übernehmen (nur wenn fehlerfrei und geändert)
	const uebernehmen = wf.node('Übernehmen?', 'n8n-nodes-base.if', [1320, -300], {
		conditions: bedingungen([bedingung('={{ $json.uebernehmen }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const allgVorb = wf.code('Allgemein vorbereiten', [1540, -480], [], `
const u = $input.first().json.allgemein_update || {};
return Object.keys(u).length ? [{ json: u }] : [];
`);
	const allgSchreiben = wf.tabelle('Allgemein schreiben', [1760, -480], 'update', 'epa_config_allgemein', { bedingungen: [['kunde_id', 'eq', `={{ ${E}.kunde_id }}`]] });
	const felderVorb = wf.code('Felder vorbereiten', [1540, -300], [], `
const a = $input.first().json;
const alt = new Map($('Pflichtfelder lesen').all().map((i) => [i.json.id, i.json]));
return (a.pflicht_ops || []).map((op) => {
	if (op.aktion === 'insert') return { json: { aktion: 'insert', id: null, zeile: op.zeile } };
	const { id, createdAt, updatedAt, ...vorher } = alt.get(op.id) || {};
	return { json: { aktion: 'update', id: op.id, zeile: { ...vorher, ...op.zeile } } };
});
`);
	const neuFrage = wf.node('Feld neu?', 'n8n-nodes-base.if', [1760, -300], {
		conditions: bedingungen([bedingung('={{ $json.aktion }}', { type: 'string', operation: 'equals' }, 'insert')]),
		options: {},
	});
	const anlegen = wf.node('Feld anlegen', 'n8n-nodes-base.dataTable', [1980, -380], {
		resource: 'row', operation: 'insert', dataTableId: { __rl: true, mode: 'name', value: 'epa_config_pflichtfelder' }, columns: spalten(), options: {},
	});
	const aendern = wf.node('Feld ändern', 'n8n-nodes-base.dataTable', [1980, -220], {
		resource: 'row', operation: 'update', dataTableId: { __rl: true, mode: 'name', value: 'epa_config_pflichtfelder' },
		matchType: 'allConditions', filters: { conditions: [{ keyName: 'id', condition: 'eq', keyValue: '={{ $json.id }}' }] }, columns: spalten(), options: {},
	});
	const audit = wf.aufruf('Änderung protokollieren', [1540, -120], 'EPA SW Audit schreiben', [
		['kunde_id', 'string', '={{ $json.kunde_id }}'],
		['vorgangs_id', 'string', ''],
		['typ', 'string', 'SYSTEM'],
		['alt', 'string', ''],
		['neu', 'string', 'Regeln aus Google Sheets übernommen'],
		['ausloeser', 'string', 'System'],
		['details', 'object', "={{ { quelle: 'Google Sheet des Kunden', aenderungen: $json.aenderungen } }}"],
		['referenz', 'string', `={{ ${E}.sheet_id }}`],
	], { onError: 'continueRegularOutput' });

	// Zweig 2: Rückmeldung im Sheet und im Kanal
	const statusSchreiben = sheets(wf, 'Status ins Sheet schreiben', [1320, 100], 'PUT',
		`=${SHEETS}/{{ encodeURIComponent(${E}.sheet_id) }}/values/Status!A1:B30?valueInputOption=RAW`,
		'={{ JSON.stringify({ range: "Status!A1:B30", majorDimension: "ROWS", values: $json.status_werte }) }}',
		{ onError: 'continueRegularOutput' });
	const meldenFrage = wf.node('Meldung nötig?', 'n8n-nodes-base.if', [1540, 100], {
		conditions: bedingungen([bedingung("={{ $('Abgleichen').first().json.melden }}", { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const A = "$('Abgleichen').first().json";
	const melden = wf.aufruf('Kanal informieren', [1760, 100], 'EPA SW Benachrichtigen', [
		['kunde_id', 'string', `={{ ${A}.kunde_id }}`],
		['vorgangs_id', 'string', ''],
		['team_id', 'string', `={{ ${A}.kanal.team_id || '' }}`],
		['channel_id', 'string', `={{ ${A}.kanal.channel_id || '' }}`],
		['kanal', 'string', `={{ ${A}.kanal.kanal || 'teams' }}`],
		['chat_id', 'string', `={{ ${A}.kanal.chat_id || '' }}`],
		['telegram_workflow_id', 'string', `={{ ${A}.kanal.telegram_workflow_id || '' }}`],
		['nachricht_html', 'string', `={{ ${A}.nachricht_html }}`],
		['anlass', 'string', 'regeln_google_sheet'],
	], { onError: 'continueRegularOutput' });

	// Zweig 3: Stand merken (gleiche Fehler nur einmal melden)
	const standVorb = wf.code('Stand vorbereiten', [1320, 300], [], `
const a = $input.first().json;
return [{ json: { schluessel: 'config_sheet:' + a.kunde_id, letzter_lauf: new Date().toISOString(), letztes_ergebnis: a.kennung } }];
`);
	const standSpeichern = wf.tabelle('Stand speichern', [1540, 300], 'upsert', 'epa_system_status', { bedingungen: [['schluessel', 'eq', '={{ $json.schluessel }}']] });
	const ergebnis = wf.code('Ergebnis melden', [1760, 300], [], `
const a = $('Abgleichen').first().json;
return [{ json: { kunde_id: a.kunde_id, ergebnis: a.ergebnis, aenderungen: a.anzahl_aenderungen, gemeldet: a.melden } }];
`);

	wf.kette(trigger, config, felder, lesen, stand, abgleichen);
	wf.verbinde(abgleichen, uebernehmen);
	wf.verbinde(uebernehmen, allgVorb, 0);
	wf.verbinde(uebernehmen, felderVorb, 0);
	wf.verbinde(uebernehmen, audit, 0);
	wf.kette(allgVorb, allgSchreiben);
	wf.kette(felderVorb, neuFrage);
	wf.verbinde(neuFrage, anlegen, 0);
	wf.verbinde(neuFrage, aendern, 1);
	wf.verbinde(abgleichen, statusSchreiben);
	wf.kette(statusSchreiben, meldenFrage);
	wf.verbinde(meldenFrage, melden, 0);
	wf.verbinde(abgleichen, standVorb);
	wf.kette(standVorb, standSpeichern, ergebnis);
	return wf;
};
