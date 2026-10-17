'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');
const { LINK_TAGE, GRUPPEN } = require('../../src/uebersicht');

// Alle Status, die auf der Übersicht erscheinen (Abgeschlossen und Ignoriert nicht).
const OFFENE_STATUS = GRUPPEN.flatMap((g) => g.status);

module.exports = function () {
	const wf = new Workflow('EPA-13 Tagesübersicht');
	wf.settings.timezone = 'Europe/Berlin';
	// Die Meldungen enthalten den Klartext-Link: erfolgreiche Ausführungen nicht speichern.
	wf.settings.saveDataSuccessExecution = 'none';

	wf.notiz('Notiz Zweck', [-120, -520], [
		'## EPA-13 Tagesübersicht',
		'**Zweck:** Jeden Morgen je aktivem Kunden eine Zusammenfassung in seinen Kanal (Teams bzw. Testkanal): Anzahl Vorgänge je Gruppe, die ältesten Fälle "Klärung nötig" und "Wartet auf Freigabe" und ein neuer geheimer Link zur Übersichtsseite (EPA-12).',
		`**Link:** je Lauf und Kunde ein neuer Schlüssel, gespeichert nur als SHA-256-Hash in epa_uebersicht_zugaenge, gültig ${LINK_TAGE} Tage. Abgelaufene Zugänge werden am Ende gelöscht.`,
		'**Zeitplan:** täglich 08:05 (Europe/Berlin), gesendet wird nur an Geschäftstagen des Kunden innerhalb seiner Geschäftszeit. Manuell gestartet: immer (z. B. um sofort einen Link zu bekommen).',
		'**Trigger:** Zeitplan oder manuell. Keine Credentials nötig (Versand über EPA SW Benachrichtigen).',
	].join('\n'), { breite: 900, hoehe: 300 });

	const zeitplan = wf.node('Täglich 08:05', 'n8n-nodes-base.scheduleTrigger', [0, -100], {
		rule: { interval: [{ field: 'cronExpression', expression: '5 8 * * *' }] },
	});
	const manuell = wf.node('Manuell starten', 'n8n-nodes-base.manualTrigger', [0, 100], {});
	const vorbereiten = wf.code('Lauf vorbereiten', [220, 0], [], `
return [{ json: { jetzt: new Date().toISOString(), manuell: $('Manuell starten').isExecuted } }];
`);
	const einmal = { alwaysOutputData: true, executeOnce: true };
	const configs = wf.tabelle('Configs lesen', [440, 0], 'get', 'epa_config_allgemein', { bedingungen: [['aktiv', 'isTrue']], alle: true }, einmal);
	const felder = wf.tabelle('Pflichtfelder lesen', [660, 0], 'get', 'epa_config_pflichtfelder', { bedingungen: [['aktiv', 'isTrue']], alle: true }, einmal);
	const vorgaenge = wf.tabelle('Offene Vorgänge lesen', [880, 0], 'get', 'epa_vorgaenge', {
		bedingungen: OFFENE_STATUS.map((s) => ['status', 'eq', s]),
		match: 'anyCondition',
		alle: true,
	}, einmal);
	const freigaben = wf.tabelle('Offene Freigaben lesen', [1100, 0], 'get', 'epa_freigaben', { bedingungen: [['status', 'eq', 'offen']], alle: true }, einmal);
	const bauen = wf.code('Zusammenfassungen bauen', [1320, 0], ['configValidator', 'fristen', 'freigabe', 'uebersicht'], `
const crypto = require('crypto');
const l = $('Lauf vorbereiten').first().json;
const zeilen = (n) => $(n).all().map((i) => i.json).filter((z) => z && z.id !== undefined);
const pflicht = zeilen('Pflichtfelder lesen');
const vorgaenge = zeilen('Offene Vorgänge lesen');
const freigaben = zeilen('Offene Freigaben lesen');
const aus = [];
for (const a of zeilen('Configs lesen')) {
	const r = configValidator.validiereConfig(a, pflicht.filter((p) => p.kunde_id === a.kunde_id), { zeitzoneGueltig: (zone) => DateTime.now().setZone(zone).isValid });
	if (!r.gueltig) continue;
	const c = r.config;
	if (!l.manuell && !fristen.istGeschaeftszeit(l.jetzt, c)) continue;
	const gruppen = uebersicht.gruppieren({
		kunde_id: c.kunde_id,
		vorgaenge: vorgaenge.filter((v) => v.kunde_id === c.kunde_id),
		freigaben: freigaben.filter((f) => f.kunde_id === c.kunde_id),
		felder: pflicht.filter((p) => p.kunde_id === c.kunde_id),
		jetzt: l.jetzt,
	});
	const t = uebersicht.tokenErzeugen(crypto);
	const zugang = uebersicht.zugangZeile({ kunde_id: c.kunde_id, hash: t.hash, jetzt: l.jetzt });
	const url = uebersicht.link(freigabe.basisUrl($execution.resumeUrl, c.freigabe_basis_url), t.token);
	const b = c.benachrichtigung || {};
	aus.push({ json: {
		kunde_id: c.kunde_id,
		zugang,
		zahlen: uebersicht.zaehlen(gruppen),
		kanal: { kanal: b.kanal || 'teams', team_id: b.team_id || '', channel_id: b.channel_id || '', chat_id: b.chat_id || '', telegram_workflow_id: b.telegram_workflow_id || '' },
		nachricht_html: uebersicht.zusammenfassung({ gruppen, link: url, ablauf: zugang.ablauf, zone: c.zeitzone }),
	} });
}
return aus.length ? aus : [{ json: { leer: true } }];
`);
	const vorhanden = wf.node('Kunden vorhanden?', 'n8n-nodes-base.if', [1540, 0], {
		conditions: bedingungen([bedingung('={{ $json.leer }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	const zugangDaten = wf.code('Zugänge vorbereiten', [1760, 100], [], `
return $input.all().map((i) => ({ json: i.json.zugang }));
`);
	// Erst speichern, dann senden: Ein Link in Teams funktioniert immer.
	const zugangSpeichern = wf.tabelle('Zugänge speichern', [1980, 100], 'insert', 'epa_uebersicht_zugaenge');
	const meldungen = wf.code('Meldungen', [2200, 100], [], `
const gespeichert = $input.all().filter((i) => i.json && i.json.id !== undefined).length;
const alle = $('Zusammenfassungen bauen').all().map((i) => i.json);
if (gespeichert !== alle.length) throw new Error('Zugänge nicht gespeichert (' + gespeichert + ' von ' + alle.length + ')');
return alle.map((j) => ({ json: j }));
`);
	const senden = wf.aufruf('Zusammenfassung senden', [2420, 100], 'EPA SW Benachrichtigen', [
		['kunde_id', 'string', '={{ $json.kunde_id }}'],
		['vorgangs_id', 'string', ''],
		['team_id', 'string', '={{ $json.kanal.team_id }}'],
		['channel_id', 'string', '={{ $json.kanal.channel_id }}'],
		['kanal', 'string', '={{ $json.kanal.kanal }}'],
		['chat_id', 'string', '={{ $json.kanal.chat_id }}'],
		['telegram_workflow_id', 'string', '={{ $json.kanal.telegram_workflow_id }}'],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
		['anlass', 'string', 'tagesuebersicht'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true }, 'each');
	const aufraeumen = wf.tabelle('Abgelaufene Zugänge löschen', [2640, 0], 'deleteRows', 'epa_uebersicht_zugaenge', {
		bedingungen: [['ablauf', 'lt', "={{ $('Lauf vorbereiten').first().json.jetzt }}"]],
	}, { alwaysOutputData: true, executeOnce: true, onError: 'continueRegularOutput' });
	const ergebnis = wf.code('Ergebnis', [2860, 0], [], `
const gebaut = $('Zusammenfassungen bauen').all().map((i) => i.json).filter((j) => !j.leer);
const gesendet = $('Zusammenfassung senden').isExecuted ? $('Zusammenfassung senden').all().filter((i) => i.json && i.json.gesendet === true).length : 0;
return [{ json: { ergebnis: 'lauf_beendet', kunden: gebaut.map((j) => ({ kunde_id: j.kunde_id, zahlen: j.zahlen })), gesendet } }];
`, { executeOnce: true });

	wf.kette(zeitplan, vorbereiten);
	wf.kette(manuell, vorbereiten);
	wf.kette(vorbereiten, configs, felder, vorgaenge, freigaben, bauen, vorhanden);
	wf.verbinde(vorhanden, aufraeumen, 0);
	wf.verbinde(vorhanden, zugangDaten, 1);
	wf.kette(zugangDaten, zugangSpeichern, meldungen, senden, aufraeumen, ergebnis);
	return wf;
};
