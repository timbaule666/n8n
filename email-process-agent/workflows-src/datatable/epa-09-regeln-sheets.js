'use strict';
const { Workflow } = require('../../tools/lib/n8n');

module.exports = function () {
	const wf = new Workflow('EPA-09 Regeln aus Google Sheets');
	wf.settings.timezone = 'Europe/Berlin';

	wf.notiz('Notiz Zweck', [-80, -420], [
		'## EPA-09 Regeln aus Google Sheets',
		'**Zweck:** Kunden pflegen ihre Regeln (Signatur, Fristen, Geschäftszeiten, Pflichtfelder, Rückfrage-Texte …) selbst in einem Google Sheet. Einmal täglich um 06:20 Uhr (Europe/Berlin) werden Änderungen geprüft und übernommen; bei Bedarf manuell starten.',
		'**Welche Kunden:** alle mit `config_sheet` (Sheet-ID) in epa_config_allgemein, auch noch nicht aktive (Einrichtung).',
		'**Je Kunde:** "EPA SW Regeln abgleichen". Ein Fehler bei einem Kunden hält die anderen nicht auf.',
		'**Manuell:** Aufruf mit `kunde_id` gleicht nur diesen Kunden sofort ab.',
		'**Neues Sheet:** "EPA-10 Regel-Sheet anlegen".',
	].join('\n'), { breite: 680, hoehe: 280 });

	const zeitplan = wf.node('Täglich 06:20', 'n8n-nodes-base.scheduleTrigger', [0, -100], {
		rule: { interval: [{ field: 'cronExpression', expression: '20 6 * * *' }] },
	});
	const manuell = wf.trigger('Bei Aufruf (Test/manuell)', [0, 100], [['kunde_id', 'string']]);
	const configs = wf.tabelle('Configs lesen', [220, 0], 'get', 'epa_config_allgemein', { alle: true }, { alwaysOutputData: true, executeOnce: true });
	const auswahl = wf.code('Kunden mit Sheet', [440, 0], [], `
const nur = $('Bei Aufruf (Test/manuell)').isExecuted ? String($('Bei Aufruf (Test/manuell)').first().json.kunde_id || '').trim() : '';
return $input.all()
	.map((i) => i.json)
	.filter((c) => c && c.kunde_id && typeof c.config_sheet === 'string' && c.config_sheet.trim())
	.filter((c) => !nur || c.kunde_id === nur)
	.map((c) => ({ json: { kunde_id: c.kunde_id, sheet_id: c.config_sheet.trim() } }));
`);
	const abgleichen = wf.aufruf('Regeln abgleichen', [660, 0], 'EPA SW Regeln abgleichen', [
		['kunde_id', 'string', '={{ $json.kunde_id }}'],
		['sheet_id', 'string', '={{ $json.sheet_id }}'],
	], { onError: 'continueRegularOutput' }, 'each');
	const ergebnis = wf.code('Ergebnis', [880, 0], [], `
return [{ json: { kunden: $input.all().map((i) => i.json) } }];
`);

	wf.kette(zeitplan, configs);
	wf.kette(manuell, configs);
	wf.kette(configs, auswahl, abgleichen, ergebnis);
	return wf;
};
