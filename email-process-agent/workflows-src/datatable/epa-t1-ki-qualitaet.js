'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const C = "$('Config laden').first().json.config";

module.exports = function () {
	const wf = new Workflow('EPA-T1 KI-Qualität prüfen');
	// Testmails sind synthetisch bzw. anonymisiert; trotzdem keine Erfolgsdaten mit Mailtexten aufbewahren.
	wf.settings.saveDataSuccessExecution = 'none';

	wf.notiz('Notiz Zweck', [-120, -560], [
		'## EPA-T1 KI-Qualität prüfen (Testphase)',
		'**Zweck:** Misst, wie gut die KI mit der echten Config eines Kunden arbeitet: Klassifizierung (Anfrage / keine Anfrage / unklar) und je Pflichtfeld richtig, falsch, fehlend oder zu viel. Verglichen wird, was ein Vorgang tatsächlich speichern würde (nach Prüfung durch src/pflichtfelder.js).',
		'**Daten:** Testfälle in epa_test_ki_faelle (synthetische Startmenge: tools/datatables-setup.js --testfaelle, eigene anonymisierte Mails mit fall_id R-…). Ergebnisse je Fall in epa_test_ki_ergebnisse (lauf_id).',
		'**Nebenwirkungen:** keine. Es werden keine Vorgänge angelegt, keine Mails gesendet und keine Meldungen verschickt. Kosten: 1–2 KI-Aufrufe je Testfall.',
		'**Start:** Im Node "Lauf vorbereiten" die kunde_id eintragen und manuell ausführen, oder per Aufruf mit kunde_id.',
		'**Ausgabe:** Bericht (Markdown) mit Trefferquote der Klassifizierung und je Feld.',
	].join('\n'), { breite: 900, hoehe: 340 });

	const start = wf.node('Testlauf starten', 'n8n-nodes-base.manualTrigger', [0, -100], {});
	const aufruf = wf.trigger('Bei Aufruf', [0, 100], [['kunde_id', 'string'], ['lauf_id', 'string']]);
	const vorbereiten = wf.code('Lauf vorbereiten', [220, 0], ['fehlerklassen'], `
// Für den manuellen Start hier den Kunden eintragen (muss in epa_config_allgemein stehen):
const KUNDE_STANDARD = '<kunde_id>';
const e = $input.first().json || {};
const kunde = String(e.kunde_id || KUNDE_STANDARD).trim();
if (!kunde || /^<.*>$/.test(kunde)) throw fehlerklassen.epaFehler('KONFIGURATIONSFEHLER', null, 'Im Node "Lauf vorbereiten" ist keine kunde_id eingetragen');
const lauf = String(e.lauf_id || ('KI-' + DateTime.now().setZone('Europe/Berlin').toFormat('yyyyLLdd-HHmm'))).slice(0, 40);
return [{ json: { kunde_id: kunde, lauf_id: lauf } }];
`);
	const config = wf.aufruf('Config laden', [440, 0], 'EPA SW Config laden', [
		['kunde_id', 'string', '={{ $json.kunde_id }}'],
		['postfach', 'string', ''],
	]);
	const faelle = wf.tabelle('Testfälle lesen', [660, 0], 'get', 'epa_test_ki_faelle', { bedingungen: [['aktiv', 'isTrue']], alle: true }, { alwaysOutputData: true, executeOnce: true });
	const mails = wf.code('Testmails vorbereiten', [880, 0], ['fehlerklassen', 'mailNormalisieren', 'eingang', 'kiQualitaet'], `
const config = $('Config laden').first().json.config;
const liste = $input.all().map((i) => i.json).filter((z) => z && z.id !== undefined).sort((a, b) => String(a.fall_id).localeCompare(String(b.fall_id)));
if (!liste.length) throw fehlerklassen.epaFehler('KONFIGURATIONSFEHLER', null, 'Keine aktiven Testfälle in epa_test_ki_faelle (tools/datatables-setup.js --testfaelle)');
const heute = DateTime.now().setZone(config.zeitzone).toISODate();
return liste.map((fall) => {
	const mail = mailNormalisieren.normalisieren(kiQualitaet.testMail(fall), config, []);
	return { json: { fall, mail, heute, hinweise_klassifizierung: eingang.klassifizierungsHinweise(mail), hinweise_extraktion: eingang.extraktionsHinweise(mail) } };
});
`);
	const klassifizieren = wf.aufruf('Klassifizieren', [1100, 0], 'EPA SW LLM aufrufen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', ''],
		['aufgabe', 'string', 'klassifizierung'],
		['prompt_version', 'string', `={{ ${C}.prompt_versionen.klassifizierung }}`],
		['profil', 'object', `={{ ${C}.llm_profil.klassifizierung }}`],
		['kontext', 'object', `={{ { mail: $json.mail, vorgangstypen: Object.keys(${C}.vorgangstypen), hinweise: $json.hinweise_klassifizierung } }}`],
		['fehler_als_ergebnis', 'boolean', '={{ true }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true }, 'each');
	const klasse = wf.code('Klasse auswerten', [1320, 0], ['eingang'], `
const config = $('Config laden').first().json.config;
const vorher = $('Testmails vorbereiten').all().map((i) => i.json);
const auftraege = $input.all().map((it, i) => {
	const llm = it.json || {};
	const v = vorher[i];
	const k = llm.ok === true ? eingang.klasseAuswerten(llm, config, v.mail) : null;
	return { ...v, klasse: k, llm_k: { ok: llm.ok === true, modell: llm.modell || null, prompt_version: llm.prompt_version || null, fehler: llm.ok === true ? null : (llm.code || (llm.error ? 'technischer Fehler' : 'keine Antwort')) } };
});
// Extrahiert wird wie im Betrieb nur, was als Anfrage erkannt wurde.
const extrahieren = auftraege.filter((a) => a.klasse && a.klasse.weg === 'pruefen');
return [{ json: { auftraege, extrahieren: extrahieren.map((a) => a.fall.fall_id) } }];
`);
	const aufteilen = wf.code('Extraktionen aufteilen', [1540, 0], [], `
const r = $input.first().json;
const liste = r.auftraege.filter((a) => r.extrahieren.includes(a.fall.fall_id));
return liste.length ? liste.map((a) => ({ json: { ...a, noetig: true } })) : [{ json: { noetig: false } }];
`);
	const noetig = wf.node('Extraktion nötig?', 'n8n-nodes-base.if', [1760, 0], {
		conditions: bedingungen([bedingung('={{ $json.noetig }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const extrahieren = wf.aufruf('Extrahieren', [1980, -80], 'EPA SW LLM aufrufen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', ''],
		['aufgabe', 'string', 'extraktion'],
		['prompt_version', 'string', `={{ ${C}.prompt_versionen.extraktion }}`],
		['profil', 'object', `={{ ${C}.llm_profil.extraktion }}`],
		['kontext', 'object', `={{ { mail: $json.mail, felder: ${C}.vorgangstypen[$json.klasse.vorgangstyp], heute: $json.heute, hinweise: $json.hinweise_extraktion } }}`],
		['fehler_als_ergebnis', 'boolean', '={{ true }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true }, 'each');

	const vergleichen = wf.code('Vergleichen', [2200, 0], ['pflichtfelder', 'kiQualitaet'], `
const config = $('Config laden').first().json.config;
const l = $('Lauf vorbereiten').first().json;
const r = $('Klasse auswerten').first().json;
const ext = {};
if ($('Extrahieren').isExecuted) {
	const auftraege = $('Extraktionen aufteilen').all().map((i) => i.json);
	$('Extrahieren').all().forEach((it, i) => { if (auftraege[i] && auftraege[i].fall) ext[auftraege[i].fall.fall_id] = it.json || {}; });
}
return r.auftraege.map((a) => {
	const typ = a.klasse && a.klasse.vorgangstyp;
	const felder = (typ && config.vorgangstypen[typ]) || Object.values(config.vorgangstypen)[0] || [];
	const e = ext[a.fall.fall_id];
	const pruefung = e && e.ok === true ? pflichtfelder.pruefen(e.ergebnis.felder, felder, { heute: a.heute }) : null;
	const v = kiQualitaet.vergleichen({ fall: a.fall, klasse: a.klasse, pruefung, felder, feldPruefen: pflichtfelder.feldPruefen, heute: a.heute });
	const fehler = a.llm_k.fehler || (e && e.ok !== true ? (e.code || 'Extraktion fehlgeschlagen') : null);
	return { json: {
		lauf_id: l.lauf_id, kunde_id: config.kunde_id, fall_id: a.fall.fall_id, klasse_soll: v.klasse_soll, klasse_ist: v.klasse_ist, klasse_ok: v.klasse_ok,
		felder: JSON.stringify(v.felder), modell: (e && e.modell) || a.llm_k.modell, prompt_version: [a.llm_k.prompt_version, e && e.prompt_version].filter(Boolean).join('/'), fehler,
	} };
});
`);
	const speichern = wf.tabelle('Ergebnisse speichern', [2420, 0], 'insert', 'epa_test_ki_ergebnisse', {}, { executeOnce: false });
	const auswertung = wf.code('Auswertung', [2640, 0], ['kiQualitaet'], `
const zeilen = $('Vergleichen').all().map((i) => i.json);
const ergebnisse = zeilen.map((z) => ({ fall_id: z.fall_id, klasse_soll: z.klasse_soll, klasse_ist: z.klasse_ist, klasse_ok: z.klasse_ok, felder: JSON.parse(z.felder) }));
const z = kiQualitaet.zusammenfassen(ergebnisse);
const fehler = zeilen.filter((x) => x.fehler).map((x) => x.fall_id + ': ' + x.fehler);
const bericht = kiQualitaet.bericht(z, { lauf: zeilen[0].lauf_id, modell: zeilen.find((x) => x.modell)?.modell, prompt_version: zeilen.find((x) => x.prompt_version)?.prompt_version })
	+ (fehler.length ? '\\n\\nTechnische Fehler: ' + fehler.join('; ') : '');
return [{ json: { lauf_id: zeilen[0].lauf_id, zusammenfassung: z, technische_fehler: fehler, bericht } }];
`);

	wf.kette(start, vorbereiten);
	wf.kette(aufruf, vorbereiten);
	wf.kette(vorbereiten, config, faelle, mails, klassifizieren, klasse, aufteilen, noetig);
	wf.verbinde(noetig, extrahieren, 0);
	wf.verbinde(noetig, vergleichen, 1);
	wf.kette(extrahieren, vergleichen, speichern, auswertung);
	return wf;
};
