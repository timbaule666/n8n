'use strict';
const { Workflow } = require('../../tools/lib/n8n');

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

module.exports = function () {
	const wf = new Workflow('EPA-10 Regel-Sheet anlegen');

	wf.notiz('Notiz Zweck', [-80, -420], [
		'## EPA-10 Regel-Sheet anlegen',
		'**Zweck:** Legt für einen Kunden ein Google Sheet mit seinen aktuellen Regeln an (Reiter "Allgemein", "Pflichtfelder", "Status") und trägt die Sheet-ID in `config_sheet` ein. Danach übernimmt "EPA-09 Regeln aus Google Sheets" Änderungen automatisch.',
		'**Aufruf:** manuell mit `kunde_id`. Hat der Kunde schon ein Sheet, wird kein zweites angelegt.',
		'**Danach:** Sheet in Google Drive für den Kunden freigeben (Bearbeiten). Nur die Personen, die Regeln ändern dürfen.',
		'**Einrichten:** Google-Sheets-Credential in "Sheet anlegen" und "Spaltenbreite anpassen" zuweisen.',
	].join('\n'), { breite: 680, hoehe: 260 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [['kunde_id', 'string']]);
	const E = "$('Bei Aufruf').first().json";
	const config = wf.tabelle('Config-Zeile lesen', [220, 0], 'get', 'epa_config_allgemein', { bedingungen: [['kunde_id', 'eq', `={{ ${E}.kunde_id }}`]] }, { alwaysOutputData: true });
	const felder = wf.tabelle('Pflichtfelder lesen', [440, 0], 'get', 'epa_config_pflichtfelder', { bedingungen: [['kunde_id', 'eq', `={{ ${E}.kunde_id }}`]], alle: true }, { alwaysOutputData: true, executeOnce: true });
	const inhalt = wf.code('Inhalt bauen', [660, 0], ['configSheet'], `
const allg = $('Config-Zeile lesen').first().json || {};
if (!allg.kunde_id) throw new Error('Config für ' + ${E}.kunde_id + ' nicht gefunden');
if (typeof allg.config_sheet === 'string' && allg.config_sheet.trim()) throw new Error('Kunde hat schon ein Regel-Sheet: https://docs.google.com/spreadsheets/d/' + allg.config_sheet.trim());
const pf = $('Pflichtfelder lesen').all().map((i) => i.json).filter((z) => z && z.feldname);
return [{ json: { body: configSheet.anlegenBody('EPA Regeln – ' + allg.kunde_id, configSheet.sheetInhalt(allg, pf)) } }];
`);
	const anlegen = wf.node('Sheet anlegen', 'n8n-nodes-base.httpRequest', [880, 0], {
		method: 'POST', url: SHEETS, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleSheetsOAuth2Api',
		sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}', options: {},
	});
	const breite = wf.node('Spaltenbreite anpassen', 'n8n-nodes-base.httpRequest', [1100, 0], {
		method: 'POST', url: `=${SHEETS}/{{ $json.spreadsheetId }}:batchUpdate`, authentication: 'predefinedCredentialType', nodeCredentialType: 'googleSheetsOAuth2Api',
		sendBody: true, specifyBody: 'json',
		jsonBody: '={{ JSON.stringify({ requests: $json.sheets.map((s) => ({ autoResizeDimensions: { dimensions: { sheetId: s.properties.sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 14 } } })) }) }}',
		options: {},
	}, { onError: 'continueRegularOutput' });
	const vorb = wf.code('Sheet-ID vorbereiten', [1320, 0], [], `
return [{ json: { config_sheet: $('Sheet anlegen').first().json.spreadsheetId } }];
`);
	const speichern = wf.tabelle('Sheet-ID speichern', [1540, 0], 'update', 'epa_config_allgemein', { bedingungen: [['kunde_id', 'eq', `={{ ${E}.kunde_id }}`]] });
	const ergebnis = wf.code('Ergebnis', [1760, 0], [], `
const id = $('Sheet anlegen').first().json.spreadsheetId;
return [{ json: { kunde_id: ${E}.kunde_id, sheet_id: id, url: 'https://docs.google.com/spreadsheets/d/' + id + '/edit' } }];
`);

	wf.kette(trigger, config, felder, inhalt, anlegen, breite, vorb, speichern, ergebnis);
	return wf;
};
