'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');
const { WARTEN_MINUTEN, PRAEFIX } = require('../../src/zustelltest');

const V = "$('Testmails vorbereiten').all()";

module.exports = function () {
	const wf = new Workflow('EPA-11 Zustelltest');
	wf.settings.timezone = 'Europe/Berlin';

	wf.notiz('Notiz Zweck', [-80, -460], [
		'## EPA-11 Zustelltest',
		'**Zweck:** Erkennt, wenn ein Kundenpostfach Mails als "gesendet" führt, sie aber nicht zugestellt werden (z. B. Konto nach Sperre eingeschränkt). Dann erreichen Rückfragen keine Kunden.',
		`**Ablauf:** Jedes aktive Kundenpostfach schickt über seine EPA-00-Kopie (Aktion zustelltest_senden) eine Kontrollmail mit Betreff "${PRAEFIX} …" an das Prüfpostfach. Nach ${WARTEN_MINUTEN} Minuten wird das Prüfpostfach durchsucht.`,
		'**Nicht angekommen:** "🚫 Systemwarnung: Postfach versendet keine Mails" an den Kanal des Kunden, danach Fehler an EPA-05 (Alarm an den Betreiber). Ergebnis je Kunde in epa_system_status ("zustelltest:<kunde_id>").',
		'**Einrichten:** Im Node "Prüfadresse festlegen" die Adresse des Prüfpostfachs eintragen (externes Postfach des Betreibers, nicht beim selben Anbieter wie die Kundenpostfächer). Im Node "Prüfpostfach durchsuchen" das Gmail-Credential dieses Postfachs zuweisen.',
		'**Trigger:** täglich 07:40 (Europe/Berlin), zusätzlich manuell.',
	].join('\n'), { breite: 900, hoehe: 320 });

	const zeitplan = wf.node('Täglich 07:40', 'n8n-nodes-base.scheduleTrigger', [0, -100], {
		rule: { interval: [{ field: 'cronExpression', expression: '40 7 * * *' }] },
	});
	const manuell = wf.node('Manuell starten', 'n8n-nodes-base.manualTrigger', [0, 100], {});
	const adresse = wf.code('Prüfadresse festlegen', [220, 0], [], `
// Prüfpostfach des Betreibers (extern, z. B. Gmail). Muss zum Credential im Node "Prüfpostfach durchsuchen" passen.
const PRUEFADRESSE = '<pruefadresse@ihre-domain.de>';
if (!/^[^@<>\\s]+@[^@<>\\s]+\\.[A-Za-z]{2,}$/.test(PRUEFADRESSE)) throw new Error('[EPA:424:KONFIGURATIONSFEHLER:-] Im Node "Prüfadresse festlegen" ist keine gültige Adresse eingetragen');
return [{ json: { pruefadresse: PRUEFADRESSE.toLowerCase(), jetzt: new Date().toISOString() } }];
`);
	const einmal = { alwaysOutputData: true, executeOnce: true };
	const configs = wf.tabelle('Configs lesen', [440, 0], 'get', 'epa_config_allgemein', { bedingungen: [['aktiv', 'isTrue']], alle: true }, einmal);
	const felder = wf.tabelle('Pflichtfelder lesen', [660, 0], 'get', 'epa_config_pflichtfelder', { bedingungen: [['aktiv', 'isTrue']], alle: true }, einmal);
	const vorbereiten = wf.code('Testmails vorbereiten', [880, 0], ['configValidator', 'zustelltest'], `
const a = $('Prüfadresse festlegen').first().json;
const zeilen = (n) => $(n).all().map((i) => i.json).filter((z) => z && z.id !== undefined);
const pflicht = zeilen('Pflichtfelder lesen');
const gueltig = [];
for (const c of zeilen('Configs lesen')) {
	const r = configValidator.validiereConfig(c, pflicht.filter((p) => p.kunde_id === c.kunde_id), { zeitzoneGueltig: (zone) => DateTime.now().setZone(zone).isValid });
	if (r.gueltig) gueltig.push(r.config);
}
const zufall = Math.random().toString(36).slice(2, 6);
const liste = zustelltest.auftraege(gueltig, { jetzt: a.jetzt, zufall, pruefadresse: a.pruefadresse });
return liste.length ? liste.map((x) => ({ json: x })) : [{ json: { leer: true } }];
`);
	const vorhanden = wf.node('Postfächer vorhanden?', 'n8n-nodes-base.if', [1100, 0], {
		conditions: bedingungen([bedingung('={{ $json.leer }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	const senden = wf.aufrufDynamisch('Testmail senden', [1320, 100], '={{ $json.postfach_workflow_id }}', [
		['aktion', 'string', 'zustelltest_senden'],
		['postfach', 'string', '={{ $json.postfach }}'],
		['graph_id', 'string', ''],
		['internet_message_id', 'string', ''],
		['entwurf_id', 'string', ''],
		['freigabe_id', 'string', ''],
		['vorgangs_id', 'string', ''],
		['html', 'string', ''],
		['empfaenger', 'string', '={{ $json.empfaenger }}'],
		['betreff', 'string', '={{ $json.betreff }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true }, 'each');
	const warten = wf.node('Zustellung abwarten', 'n8n-nodes-base.wait', [1540, 100], { resume: 'timeInterval', amount: WARTEN_MINUTEN, unit: 'minutes' }, { executeOnce: true });
	const suchen = wf.node('Prüfpostfach durchsuchen', 'n8n-nodes-base.gmail', [1760, 100], {
		resource: 'message',
		operation: 'getAll',
		returnAll: false,
		limit: 100,
		simple: true,
		filters: { q: `in:anywhere subject:"${PRAEFIX}" newer_than:1d`, readStatus: 'both' },
	}, { alwaysOutputData: true, executeOnce: true, ...Workflow.retry() });
	const auswerten = wf.code('Auswerten', [1980, 100], ['zustelltest'], `
const liste = ${V}.map((i) => i.json);
const sendungen = $('Testmail senden').all().map((i) => i.json || {});
const gefunden = $('Prüfpostfach durchsuchen').all().map((i) => i.json && (i.json.Subject || i.json.subject)).filter(Boolean);
const jetzt = new Date().toISOString();
return zustelltest.auswerten(liste, sendungen, gefunden).map((e) => ({ json: { ...e, stand: zustelltest.stand(e, jetzt), nachricht_html: e.ok ? null : zustelltest.meldung(e) } }));
`);
	const standVorb = wf.code('Stand vorbereiten', [2200, 100], [], `
return $input.all().map((i) => ({ json: i.json.stand }));
`);
	const standSpeichern = wf.tabelle('Stand speichern', [2420, 100], 'upsert', 'epa_system_status', { bedingungen: [['schluessel', 'eq', '={{ $json.schluessel }}']] });
	const fehlgeschlagen = wf.code('Nicht zugestellt', [2640, 100], [], `
const f = $('Auswerten').all().map((i) => i.json).filter((e) => !e.ok);
return f.length ? f.map((e) => ({ json: e })) : [{ json: { alles_ok: true } }];
`, { executeOnce: true });
	const fehlerFrage = wf.node('Störung?', 'n8n-nodes-base.if', [2860, 100], {
		conditions: bedingungen([bedingung('={{ $json.alles_ok }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	const kanal = wf.aufruf('Kanal warnen', [3080, 200], 'EPA SW Benachrichtigen', [
		['kunde_id', 'string', '={{ $json.kunde_id }}'],
		['vorgangs_id', 'string', ''],
		['team_id', 'string', "={{ $json.kanal.team_id || '' }}"],
		['channel_id', 'string', "={{ $json.kanal.channel_id || '' }}"],
		['kanal', 'string', "={{ $json.kanal.kanal || 'teams' }}"],
		['chat_id', 'string', "={{ $json.kanal.chat_id || '' }}"],
		['telegram_workflow_id', 'string', "={{ $json.kanal.telegram_workflow_id || '' }}"],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
		['anlass', 'string', 'zustelltest_fehlgeschlagen'],
	], { onError: 'continueRegularOutput' }, 'each');
	const alarm = wf.code('Betreiber alarmieren', [3300, 200], ['fehlerklassen'], `
// Nach der Kanalmeldung: Fehler auslösen, damit EPA-05 protokolliert und den Betreiber alarmiert.
const f = $('Nicht zugestellt').all().map((i) => i.json);
throw fehlerklassen.epaFehler('UPSTREAM_FEHLER', null, 'Zustelltest fehlgeschlagen: Postfach versendet keine Mails (' + f.map((e) => e.kunde_id + ': ' + e.art).join(', ') + '). ' + f[0].grund);
`, { executeOnce: true });
	const ok = wf.code('Ergebnis', [3080, 0], [], `
return [{ json: { ergebnis: 'alle_zugestellt', kunden: $('Auswerten').all().length } }];
`);

	wf.kette(zeitplan, adresse);
	wf.kette(manuell, adresse);
	wf.kette(adresse, configs, felder, vorbereiten, vorhanden);
	wf.verbinde(vorhanden, senden, 1);
	wf.kette(senden, warten, suchen, auswerten, standVorb, standSpeichern, fehlgeschlagen, fehlerFrage);
	wf.verbinde(fehlerFrage, ok, 0);
	wf.verbinde(fehlerFrage, kanal, 1);
	wf.kette(kanal, alarm);
	return wf;
};
