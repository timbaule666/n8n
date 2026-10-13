'use strict';
const { Workflow } = require('../../tools/lib/n8n');

module.exports = function () {
	const wf = new Workflow('EPA SW Config laden');

	wf.notiz('Notiz Zweck', [-80, -360], [
		'## EPA SW Config laden',
		'**Zweck:** Lädt die Kunden-Config (Data Tables epa_config_allgemein + aktive Zeilen aus epa_config_pflichtfelder) und prüft sie vollständig (src/configValidator.js).',
		'**Trigger:** Aufruf durch andere Workflows, **einmal pro Ausführung**. Der Aufrufer liest das Ergebnis danach über $(\'Config laden\').first().json.config (Cache für die Laufzeit der Ausführung).',
		'**Eingaben:** kunde_id oder postfach.',
		'**Ausgabe:** { config } mit vorgangstypen -> sortierte Feldliste.',
		'**Fehler (harter Abbruch, Alarm über EPA-05):** 404 keine Config, 409 mehrdeutig, 424 Config ungültig. Es wird nie mit Default-Annahmen weitergearbeitet.',
	].join('\n'), { breite: 660, hoehe: 300 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['postfach', 'string'],
	]);

	const eingabe = wf.code('Eingabe prüfen', [220, 0], ['fehlerklassen'], `
const e = $input.first().json;
const kunde = typeof e.kunde_id === 'string' ? e.kunde_id.trim() : '';
const postfach = typeof e.postfach === 'string' ? e.postfach.trim().toLowerCase() : '';
if (!kunde && !postfach) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', null, 'kunde_id oder postfach muss angegeben sein');
// Leere Suchwerte durch einen Wert ersetzen, der nie vorkommt (Filter "eq ''" würde leere Zellen treffen).
return [{ json: { kunde_id: kunde, postfach, suche_kunde: kunde || '__kein_kunde__', suche_postfach: postfach || '__kein_postfach__' } }];
`);

	const lesen = wf.tabelle('Config lesen', [440, 0], 'get', 'epa_config_allgemein', {
		match: 'anyCondition',
		bedingungen: [['kunde_id', 'eq', '={{ $json.suche_kunde }}'], ['postfach', 'ilike', '={{ $json.suche_postfach }}']],
		alle: true,
	}, { alwaysOutputData: true });

	const gefunden = wf.code('Config gefunden?', [660, 0], ['fehlerklassen'], `
const e = $('Eingabe prüfen').first().json;
// ilike ist case-insensitiv, behandelt aber _ und % als Platzhalter: deshalb hier exakt nachprüfen.
const treffer = $input.all().map((i) => i.json).filter((z) => z && z.id !== undefined)
	.filter((z) => (e.kunde_id && z.kunde_id === e.kunde_id) || (e.postfach && String(z.postfach || '').toLowerCase() === e.postfach));
const wer = e.kunde_id ? \`Kunde "\${e.kunde_id}"\` : 'das Postfach';
if (treffer.length === 0) throw fehlerklassen.epaFehler('KONFIG_NICHT_GEFUNDEN', null, \`Keine Config für \${wer} gefunden\`);
if (treffer.length > 1) throw fehlerklassen.epaFehler('KONFIG_MEHRDEUTIG', null, \`\${treffer.length} Configs passen auf \${wer}\`);
return [{ json: { kunde_id: treffer[0].kunde_id } }];
`);

	const felder = wf.tabelle('Pflichtfelder lesen', [880, 0], 'get', 'epa_config_pflichtfelder', {
		bedingungen: [['kunde_id', 'eq', '={{ $json.kunde_id }}'], ['aktiv', 'isTrue']],
		alle: true,
	}, { alwaysOutputData: true });

	const validieren = wf.code('Config validieren', [1100, 0], ['fehlerklassen', 'configValidator'], `
const kundeId = $('Config gefunden?').first().json.kunde_id;
const allgemein = $('Config lesen').all().map((i) => i.json).find((z) => z && z.kunde_id === kundeId);
const pflichtfelder = $input.all().map((i) => i.json).filter((z) => z && z.id !== undefined);
const ergebnis = configValidator.validiereConfig(allgemein, pflichtfelder, {
	zeitzoneGueltig: (zone) => DateTime.now().setZone(zone).isValid,
});
if (!ergebnis.gueltig) {
	throw fehlerklassen.epaFehler('KONFIGURATIONSFEHLER', null,
		\`Config "\${allgemein.kunde_id}" ungültig: \${ergebnis.fehler.slice(0, 10).join('; ')}\${ergebnis.fehler.length > 10 ? ' …' : ''}\`);
}
return [{ json: { config: ergebnis.config } }];
`);

	wf.kette(trigger, eingabe, lesen, gefunden, felder, validieren);
	return wf;
};
