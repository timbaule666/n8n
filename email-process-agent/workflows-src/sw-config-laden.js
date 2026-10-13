'use strict';
const { Workflow } = require('../tools/lib/n8n');

module.exports = function () {
	const wf = new Workflow('EPA SW Config laden');

	wf.notiz('Notiz Zweck', [-80, -340], [
		'## EPA SW Config laden',
		'**Zweck:** Lädt die Kunden-Config (epa_config_allgemein + aktive Pflichtfelder) und prüft sie vollständig (src/configValidator.js).',
		'**Trigger:** Aufruf durch andere Workflows, **einmal pro Ausführung**. Der Aufrufer liest das Ergebnis danach über $(\'Config laden\').first().json.config (Cache für die Laufzeit der Ausführung).',
		'**Eingaben:** kunde_id oder postfach.',
		'**Ausgabe:** { config } mit vorgangstypen -> sortierte Feldliste.',
		'**Fehler (harter Abbruch, Alarm über EPA-05):** 404 keine Config, 409 mehrdeutig, 424 Config ungültig. Es wird nie mit Default-Annahmen weitergearbeitet.',
	].join('\n'), { breite: 620, hoehe: 280 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['postfach', 'string'],
	]);

	const eingabe = wf.code('Eingabe prüfen', [220, 0], ['fehlerklassen'], `
const e = $input.first().json;
const kunde = typeof e.kunde_id === 'string' ? e.kunde_id.trim() : '';
const postfach = typeof e.postfach === 'string' ? e.postfach.trim().toLowerCase() : '';
if (!kunde && !postfach) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', null, 'kunde_id oder postfach muss angegeben sein');
return [{ json: { kunde_id: kunde, postfach } }];
`);

	const lesen = wf.postgres('Config lesen', [440, 0], 'config_laden', '[ $json.kunde_id, $json.postfach ]');

	const validieren = wf.code('Config validieren', [660, 0], ['fehlerklassen', 'configValidator'], `
const e = $('Eingabe prüfen').first().json;
const treffer = $input.first().json.treffer || [];
const wer = e.kunde_id ? \`Kunde "\${e.kunde_id}"\` : 'das Postfach';
if (treffer.length === 0) throw fehlerklassen.epaFehler('KONFIG_NICHT_GEFUNDEN', null, \`Keine Config für \${wer} gefunden\`);
if (treffer.length > 1) throw fehlerklassen.epaFehler('KONFIG_MEHRDEUTIG', null, \`\${treffer.length} Configs passen auf \${wer}\`);
const ergebnis = configValidator.validiereConfig(treffer[0].allgemein, treffer[0].pflichtfelder, {
	zeitzoneGueltig: (zone) => DateTime.now().setZone(zone).isValid,
});
if (!ergebnis.gueltig) {
	throw fehlerklassen.epaFehler('KONFIGURATIONSFEHLER', null,
		\`Config "\${treffer[0].allgemein.kunde_id}" ungültig: \${ergebnis.fehler.slice(0, 10).join('; ')}\${ergebnis.fehler.length > 10 ? ' …' : ''}\`);
}
return [{ json: { config: ergebnis.config } }];
`);

	wf.kette(trigger, eingabe, lesen, validieren);
	return wf;
};
