'use strict';
const { Workflow, codeDatei } = require('../../tools/lib/n8n');

module.exports = function () {
	const wf = new Workflow('EPA SW PLZ nachschlagen');
	wf.notiz('Notiz Zweck', [-80, -320], [
		'## EPA SW PLZ nachschlagen',
		'**Zweck:** Prüft bis zu drei fünfstellige Postleitzahlen gegen das deutsche PLZ-Verzeichnis (Data Table epa_plz_de: plz, ort, bundesland).',
		'**Trigger:** Aufruf durch EPA-01 und EPA-03 vor der Pflichtfeldprüfung.',
		'**Eingabe:** plz_liste (Liste). **Ausgabe:** { ok, plz_info: { "<plz>": { gefunden, ort, bundesland } } }.',
		'**Wirkung:** Bei Feldern mit validierungsregel { "laender": ["DE"] } gilt eine nicht gefundene PLZ als ungültig ("PLZ existiert in Deutschland nicht"). Bei Lesefehlern ok = false; dann wird nicht geprüft.',
	].join('\n'), { breite: 680, hoehe: 240 });
	const start = wf.trigger('Start', [0, 0], [['plz_liste', 'array']]);
	const norm = wf.code('PLZ normalisieren', [224, 0], [], codeDatei('plz-normalisieren.js'));
	const lesen = wf.tabelle('PLZ nachschlagen', [448, 0], 'get', 'epa_plz_de', {
		bedingungen: [['plz', 'eq', '={{ $json.p1 }}'], ['plz', 'eq', '={{ $json.p2 }}'], ['plz', 'eq', '={{ $json.p3 }}']],
		match: 'anyCondition',
		alle: true,
	}, { alwaysOutputData: true, onError: 'continueRegularOutput' });
	const ergebnis = wf.code('Ergebnis bauen', [672, 0], [], codeDatei('plz-ergebnis-bauen.js'));
	wf.kette(start, norm, lesen, ergebnis);
	return wf;
};
