'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const E = "$('Bei Aufruf').first().json";
const C = "$('Config laden').first().json.config";
const V = "$('Vorgang lesen').first().json.vorgang";
const Z = "$('Zusammenführen').first().json";

function weiche(wf, name, pos, ausdruck, werte) {
	return wf.node(name, 'n8n-nodes-base.switch', pos, {
		mode: 'rules',
		rules: {
			values: werte.map((w) => ({
				conditions: bedingungen([bedingung(ausdruck, { type: 'string', operation: 'equals' }, w)]),
				renameOutput: true,
				outputKey: w,
			})),
		},
		options: {},
	});
}

function wennWahr(wf, name, pos, ausdruck) {
	return wf.node(name, 'n8n-nodes-base.if', pos, {
		conditions: bedingungen([bedingung(ausdruck, { type: 'boolean', operation: 'true', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
}

const STATUS = (wf, name, pos, neu, details, version) => wf.aufruf(name, pos, 'EPA SW Status setzen', [
	['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
	['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
	['neuer_status', 'string', neu],
	['ausloeser', 'string', 'System'],
	['details', 'object', details],
	['referenz', 'string', `={{ ${E}.referenz }}`],
	['erwartete_version', 'number', version],
	['nur_wenn_erlaubt', 'boolean', '={{ false }}'],
]);

module.exports = function () {
	const wf = new Workflow('EPA-03 Antwort verarbeiten');

	wf.notiz('Notiz Zweck', [-80, -720], [
		'## EPA-03 Antwort verarbeiten (Phase D)',
		'**Zweck:** Wertet eine Mail aus, die EPA-01 eindeutig einem bestehenden Vorgang zugeordnet hat.',
		'**Automatisch** bei "Warten auf Kunde", "Freigabe ausstehend" (offene Freigabe wird ersetzt) und "Bereit zur Bearbeitung" (Nachtrag). In allen anderen Status wird die Mail nur angehängt und gemeldet.',
		'**Merge (src/antwort.js):** Gültige vorhandene Werte werden nie überschrieben. Abweichende neue Werte werden als Konflikt vermerkt und gemeldet; neue Werte füllen nur Lücken. Jede Übernahme und jeder Konflikt steht im Audit (MERGE: Feld, alt, neu, Quelle).',
		'**Danach:** Pflichtfeld-Prüfung → "Bereit zur Bearbeitung" oder "Lücken erkannt" mit neuer Rückfrage (EPA-02; bei erreichter Rundenzahl Eskalation).',
		'**Antwort ohne Angaben** (z. B. Vertröstung): Vorgang bleibt unverändert, Frist wird um leerantwort_fristverlaengerung_stunden verlängert (nie verkürzt), Mitarbeiter wird informiert.',
		'**Trigger:** Aufruf durch EPA-01. **Eingaben:** kunde_id, vorgangs_id, mail (normalisiert), referenz. **Ausgabe:** { ergebnis, vorgangs_id }',
	].join('\n'), { breite: 900, hoehe: 420 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['mail', 'object'],
		['referenz', 'string'],
	]);
	const config = wf.aufruf('Config laden', [220, 0], 'EPA SW Config laden', [
		['kunde_id', 'string', '={{ $json.kunde_id }}'],
		['postfach', 'string', ''],
	]);
	const vorgang = wf.aufruf('Vorgang lesen', [440, 0], 'EPA SW Vorgang verwalten', [
		['aktion', 'string', 'lesen'],
		['kunde_id', 'string', `={{ ${E}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${E}.vorgangs_id }}`],
		['daten', 'object', '={{ {} }}'],
		['erwartete_version', 'number', '={{ null }}'],
		['referenz', 'string', `={{ ${E}.referenz }}`],
		['lock_sekunden', 'number', '={{ null }}'],
	]);
	const weg = wf.code('Weg bestimmen', [660, 0], ['fehlerklassen', 'antwort'], `
const e = $('Bei Aufruf').first().json;
const v = $input.first().json.vorgang;
if (!e.mail || !e.mail.message_id) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', v.vorgangs_id, 'mail.message_id fehlt');
return [{ json: { weg: antwort.wegBestimmen(v.status), status: v.status } }];
`);
	const anhaengen = wf.aufruf('Nachricht anhängen', [880, 0], 'EPA SW Vorgang verwalten', [
		['aktion', 'string', 'aktualisieren'],
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['daten', 'object', `={{ { neue_message_ids: [${E}.mail.message_id], letzte_message_id: ${E}.mail.message_id } }}`],
		['erwartete_version', 'number', `={{ ${V}.version }}`],
		['referenz', 'string', `={{ ${E}.referenz }}`],
		['lock_sekunden', 'number', '={{ null }}'],
	]);
	const verarbeiten = wf.node('Automatisch verarbeiten?', 'n8n-nodes-base.if', [1100, 0], {
		conditions: bedingungen([bedingung("={{ $('Weg bestimmen').first().json.weg }}", { type: 'string', operation: 'equals' }, 'verarbeiten')]),
		options: {},
	});

	// ---------------------------------------------------------------- nur melden
	const mNur = wf.code('Meldung: nur zugeordnet', [1320, -320], ['antwort'], `
const v = $('Vorgang lesen').first().json.vorgang;
const mail = $('Bei Aufruf').first().json.mail;
return [{ json: { anlass: 'antwort_gemeldet', nachricht_html: antwort.meldungAntwort({ vorgangs_id: v.vorgangs_id, mail, entscheidung: { weg: 'nur_melden' }, alterStatus: v.status }), ergebnis: 'gemeldet' } }];
`);

	// ---------------------------------------------------------------- Extraktion und Merge
	const extrahieren = wf.aufruf('Daten extrahieren', [1320, 100], 'EPA SW LLM aufrufen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['aufgabe', 'string', 'extraktion'],
		['prompt_version', 'string', `={{ ${C}.prompt_versionen.extraktion }}`],
		['profil', 'object', `={{ ${C}.llm_profil.extraktion }}`],
		['kontext', 'object', `={{ { mail: ${E}.mail, felder: ${C}.vorgangstypen[${V}.vorgangstyp], heute: $now.setZone(${C}.zeitzone).toISODate(), hinweise: $('Hinweise vorbereiten').first().json.hinweise } }}`],
		['fehler_als_ergebnis', 'boolean', '={{ false }}'],
	]);
	const hinweise = wf.code('Hinweise vorbereiten', [1320, -60], ['antwort', 'eingang'], `
const config = $('Config laden').first().json.config;
const v = $('Vorgang lesen').first().json.vorgang;
const mail = $('Bei Aufruf').first().json.mail;
if (!config.vorgangstypen[v.vorgangstyp]) throw new Error('[EPA:424:KONFIGURATIONSFEHLER:' + v.vorgangs_id + '] Vorgangstyp "' + v.vorgangstyp + '" fehlt in der Config');
return [{ json: { hinweise: [...antwort.extraktionsHinweise(v, config.vorgangstypen[v.vorgangstyp]), ...eingang.extraktionsHinweise(mail)] } }];
`);
	const zusammen = wf.code('Zusammenführen', [1540, 100], ['antwort', 'pflichtfelder', 'fristen'], `
const config = $('Config laden').first().json.config;
const v = $('Vorgang lesen').first().json.vorgang;
const mail = $('Bei Aufruf').first().json.mail;
const llm = $input.first().json;
const felder = config.vorgangstypen[v.vorgangstyp];
if (!llm.ok) return [{ json: { weg: 'extraktion_fehlgeschlagen', fehlercode: llm.code, fehler: llm.fehler } }];
const heute = DateTime.now().setZone(config.zeitzone).toISODate();
const neu = pflichtfelder.pruefen(llm.ergebnis.felder, felder, { heute, quelltext: pflichtfelder.quelltextAus(mail) });
const m = antwort.zusammenfuehren(v.extrahierte_daten, neu, felder, {
	istPlatzhalter: pflichtfelder.istPlatzhalter, konflikteBisher: v.konflikte, message_id: mail.message_id, runde: Number(v.rundenzaehler || 0),
});
const ent = antwort.entscheiden(m, v);
let fristNeu = null;
if (ent.weg === 'keine_daten' && v.status === 'Warten auf Kunde' && Number(config.leerantwort_fristverlaengerung_stunden) > 0) {
	const kandidat = fristen.berechneFrist(new Date().toISOString(), config.leerantwort_fristverlaengerung_stunden, config);
	const f = antwort.fristVerlaengern(v.antwort_frist, kandidat);
	if (f !== v.antwort_frist) fristNeu = f;
}
const manipulation = llm.ergebnis.verdacht_manipulation === true;
return [{ json: {
	weg: ent.weg === 'keine_daten' ? 'keine_daten' : 'auswerten',
	ergebnis: ent.weg,
	zielstatus: ent.zielstatus,
	freigabe_ersetzen: ent.freigabe_ersetzen,
	merge: m,
	frist_neu: fristNeu,
	verdacht_manipulation: manipulation,
	speichern: { extrahierte_daten: m.daten, fehlende_felder: m.fehlende, konflikte: m.konflikte },
	details: {
		anlass: 'Kundenantwort', message_id: mail.message_id,
		uebernommen: m.uebernommen.map((u) => u.feldname), konflikte_neu: m.konflikte_neu.map((k) => k.feldname),
		fehlende: m.fehlende.map((f) => f.feldname), verdacht_manipulation: manipulation,
		llm: { modell: llm.modell, prompt_version: llm.prompt_version, versuche: llm.versuche, korrekturen: llm.korrekturen },
	},
} }];
`);
	const wWeg = weiche(wf, 'Nach Merge', [1760, 100], '={{ $json.weg }}', ['auswerten', 'keine_daten', 'extraktion_fehlgeschlagen']);

	// ---------------------------------------------------------------- keine Daten (Vertröstung)
	const fristFrage = wf.node('Frist verlängern?', 'n8n-nodes-base.if', [1980, 300], {
		conditions: bedingungen([bedingung(`={{ ${Z}.frist_neu }}`, { type: 'string', operation: 'exists', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	const fristSpeichern = wf.aufruf('Frist speichern', [2200, 240], 'EPA SW Vorgang verwalten', [
		['aktion', 'string', 'aktualisieren'],
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['daten', 'object', `={{ { antwort_frist: ${Z}.frist_neu } }}`],
		['erwartete_version', 'number', "={{ $('Nachricht anhängen').first().json.vorgang.version }}"],
		['referenz', 'string', `={{ ${E}.referenz }}`],
		['lock_sekunden', 'number', '={{ null }}'],
	]);
	const keineAudit = wf.aufruf('Antwort ohne Angaben protokollieren', [2420, 300], 'EPA SW Audit schreiben', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['typ', 'string', 'SYSTEM'],
		['alt', 'string', ''],
		['neu', 'string', 'Antwort ohne verwertbare Angaben'],
		['ausloeser', 'string', 'KI'],
		['details', 'object', `={{ { message_id: ${E}.mail.message_id, frist_neu: ${Z}.frist_neu, status: ${V}.status } }}`],
		['referenz', 'string', `={{ ${E}.referenz }}`],
	]);
	const mKeine = wf.code('Meldung: keine Angaben', [2640, 300], ['antwort'], `
const z = $('Zusammenführen').first().json;
const v = $('Vorgang lesen').first().json.vorgang;
const config = $('Config laden').first().json.config;
const mail = $('Bei Aufruf').first().json.mail;
const fristText = z.frist_neu ? DateTime.fromISO(z.frist_neu).setZone(config.zeitzone).toFormat('dd.LL.yyyy, HH:mm') : null;
return [{ json: { anlass: 'antwort_keine_daten', nachricht_html: antwort.meldungAntwort({ vorgangs_id: v.vorgangs_id, mail, merge: z.merge, entscheidung: { weg: 'keine_daten' }, fristNeu: fristText }), ergebnis: 'keine_daten' } }];
`);

	// ---------------------------------------------------------------- Extraktion fehlgeschlagen (422)
	const statusFehl = STATUS(wf, 'Status: Eskaliert (Extraktion)', [1980, 480], 'Eskaliert / Manuell',
		`={{ { grund: 'Extraktion der Antwort fehlgeschlagen', fehlercode: ${Z}.fehlercode, message_id: ${E}.mail.message_id } }}`,
		"={{ $('Nachricht anhängen').first().json.vorgang.version }}");
	const mFehl = wf.code('Meldung: Extraktion fehlgeschlagen', [2200, 480], ['eingang'], `
const v = $('Vorgang lesen').first().json.vorgang;
const mail = $('Bei Aufruf').first().json.mail;
return [{ json: { anlass: 'extraktion_fehlgeschlagen', nachricht_html: eingang.meldungExtraktionFehlgeschlagen(v.vorgangs_id, mail, $('Zusammenführen').first().json.fehlercode), ergebnis: 'extraktion_fehlgeschlagen' } }];
`);

	// ---------------------------------------------------------------- Auswerten
	const ersetzenFrage = wennWahr(wf, 'Freigabe ersetzen?', [1980, -40], `={{ ${Z}.freigabe_ersetzen }}`);
	const ersetzenDaten = wf.code('Ersetzung vorbereiten', [2200, -120], [], `
return [{ json: { status: 'ersetzt' } }];
`);
	const ersetzen = wf.tabelle('Offene Freigabe ersetzen', [2420, -120], 'update', 'epa_freigaben', {
		bedingungen: [['freigabe_id', 'eq', `={{ ${V}.freigabe_id_aktuell }}`], ['status', 'eq', 'offen']],
	}, { alwaysOutputData: true });
	const statusPruef = STATUS(wf, 'Status: In Prüfung', [2640, -40], 'In Prüfung',
		`={{ { anlass: 'Kundenantwort', message_id: ${E}.mail.message_id, vorher: ${V}.status, freigabe_ersetzt: ${Z}.freigabe_ersetzen ? ${V}.freigabe_id_aktuell : null } }}`,
		"={{ $('Nachricht anhängen').first().json.vorgang.version }}");
	const speichern = wf.aufruf('Daten speichern', [2860, -40], 'EPA SW Vorgang verwalten', [
		['aktion', 'string', 'aktualisieren'],
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['daten', 'object', `={{ ${Z}.speichern }}`],
		['erwartete_version', 'number', "={{ $('Status: In Prüfung').first().json.version }}"],
		['referenz', 'string', `={{ ${E}.referenz }}`],
		['lock_sekunden', 'number', '={{ null }}'],
	]);
	const mergeZeilen = wf.code('Merge-Audit vorbereiten', [3080, -40], [], `
const z = $('Zusammenführen').first().json;
const mail = $('Bei Aufruf').first().json.mail;
const zeilen = [
	...z.merge.uebernommen.map((u) => ({ alt: '', neu: String(u.neu), details: { feld: u.feldname, quelle: u.quelle, message_id: mail.message_id } })),
	...z.merge.konflikte_neu.map((k) => ({ alt: String(k.alt), neu: String(k.neu), details: { feld: k.feldname, quelle: k.quelle, message_id: mail.message_id, konflikt: true, uebernommen: false } })),
];
return zeilen.length ? zeilen.map((j) => ({ json: j })) : [{ json: { leer: true } }];
`);
	const mergeFrage = wf.node('Merge-Audit nötig?', 'n8n-nodes-base.if', [3300, -40], {
		conditions: bedingungen([bedingung('={{ $json.leer }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	const mergeAudit = wf.aufruf('Merge protokollieren', [3520, -120], 'EPA SW Audit schreiben', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['typ', 'string', 'MERGE'],
		['alt', 'string', '={{ $json.alt }}'],
		['neu', 'string', '={{ $json.neu }}'],
		['ausloeser', 'string', 'KI'],
		['details', 'object', '={{ $json.details }}'],
		['referenz', 'string', `={{ ${E}.referenz }}`],
	], {}, 'each');
	const statusZiel = STATUS(wf, 'Status nach Antwort', [3740, -40], `={{ ${Z}.zielstatus }}`, `={{ ${Z}.details }}`,
		"={{ $('Daten speichern').first().json.vorgang.version }}");
	const lueckenFrage = wf.node('Neue Rückfrage nötig?', 'n8n-nodes-base.if', [3960, -40], {
		conditions: bedingungen([bedingung(`={{ ${Z}.ergebnis }}`, { type: 'string', operation: 'equals' }, 'luecken')]),
		options: {},
	});
	const rueckfrage = wf.aufruf('Rückfrage anfordern', [4180, -120], 'EPA-02 Rückfrage anfordern', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['art', 'string', 'rueckfrage'],
		['referenz', 'string', `={{ ${E}.referenz }}`],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const mAusw = wf.code('Meldung: ausgewertet', [4400, -40], ['antwort'], `
const z = $('Zusammenführen').first().json;
const v = $('Vorgang lesen').first().json.vorgang;
const mail = $('Bei Aufruf').first().json.mail;
const r = $('Rückfrage anfordern').isExecuted ? $('Rückfrage anfordern').first().json : null;
let html = antwort.meldungAntwort({ vorgangs_id: v.vorgangs_id, mail, merge: z.merge, entscheidung: { weg: z.ergebnis, freigabe_ersetzen: z.freigabe_ersetzen }, rueckfrage: r });
if (z.verdacht_manipulation) html += '<br>⚠️ Die Mail enthält möglicherweise Anweisungen an die KI (Manipulationsversuch).';
return [{ json: { anlass: 'antwort_' + z.ergebnis, nachricht_html: html, ergebnis: z.ergebnis } }];
`);

	// ---------------------------------------------------------------- Meldung und Ergebnis
	const informieren = wf.aufruf('Mitarbeiter informieren', [4620, 100], 'EPA SW Benachrichtigen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['team_id', 'string', `={{ ${C}.benachrichtigung.team_id }}`],
		['channel_id', 'string', `={{ ${C}.benachrichtigung.channel_id }}`],
		['kanal', 'string', `={{ ${C}.benachrichtigung.kanal }}`],
		['chat_id', 'string', `={{ ${C}.benachrichtigung.chat_id || '' }}`],
		['telegram_workflow_id', 'string', `={{ ${C}.benachrichtigung.telegram_workflow_id || '' }}`],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
		['anlass', 'string', '={{ $json.anlass }}'],
	]);
	const MELDUNGEN = ['Meldung: nur zugeordnet', 'Meldung: keine Angaben', 'Meldung: Extraktion fehlgeschlagen', 'Meldung: ausgewertet'];
	const ergebnis = wf.code('Ergebnis melden', [4840, 100], [], `
const quelle = ${JSON.stringify(MELDUNGEN)}.find((n) => $(n).isExecuted);
return [{ json: { ergebnis: $(quelle).first().json.ergebnis, vorgangs_id: $('Vorgang lesen').first().json.vorgang.vorgangs_id, benachrichtigt: $input.first().json.gesendet === true } }];
`);

	wf.kette(trigger, config, vorgang, weg, anhaengen, verarbeiten);
	wf.verbinde(verarbeiten, hinweise, 0);
	wf.verbinde(verarbeiten, mNur, 1);
	wf.kette(hinweise, extrahieren, zusammen, wWeg);
	wf.verbinde(wWeg, ersetzenFrage, 0);
	wf.verbinde(wWeg, fristFrage, 1);
	wf.verbinde(wWeg, statusFehl, 2);
	wf.verbinde(fristFrage, fristSpeichern, 0);
	wf.verbinde(fristFrage, keineAudit, 1);
	wf.kette(fristSpeichern, keineAudit, mKeine, informieren);
	wf.kette(statusFehl, mFehl, informieren);
	wf.verbinde(ersetzenFrage, ersetzenDaten, 0);
	wf.verbinde(ersetzenFrage, statusPruef, 1);
	wf.kette(ersetzenDaten, ersetzen, statusPruef, speichern, mergeZeilen, mergeFrage);
	wf.verbinde(mergeFrage, statusZiel, 0);
	wf.verbinde(mergeFrage, mergeAudit, 1);
	wf.kette(mergeAudit, statusZiel, lueckenFrage);
	wf.verbinde(lueckenFrage, rueckfrage, 0);
	wf.verbinde(lueckenFrage, mAusw, 1);
	wf.kette(rueckfrage, mAusw, informieren);
	wf.kette(mNur, informieren, ergebnis);
	return wf;
};
