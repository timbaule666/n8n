'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const C = "$('Config laden').first().json.config";
const V = "$('Vorgang lesen').first().json.vorgang";
const R = "$('Rückfrage vorbereiten').first().json";
const Z = "$('Entwurf zusammensetzen').first().json";

module.exports = function () {
	const wf = new Workflow('EPA-02 Rückfrage anfordern');
	// Härtung (M6): Erfolgreiche Ausführungen enthalten Klartext-Links bzw. Mail-Text und werden nicht gespeichert.
	wf.settings.saveDataSuccessExecution = 'none';

	wf.notiz('Notiz Zweck', [-80, -620], [
		'## EPA-02 Rückfrage anfordern (Phase C1–C3)',
		'**Zweck:** Erstellt zu einem Vorgang im Status "Lücken erkannt" eine Rückfrage-Mail und holt die Freigabe ein. Es wird **nie** ohne Freigabe gesendet.',
		'**Ablauf:** Bausteine der fehlenden Felder aus der Config (C1) → KI formuliert nur Anrede/Einleitung/Schluss, Code prüft, sonst Standardvorlage (C2) → Antwortentwurf im Thread im Kundenpostfach (über den Postfach-Workflow aus postfach_workflow_id) → Freigabe mit einmaligem Token je Freigeber (nur SHA-256-Hash gespeichert) → Status "Freigabe ausstehend" → persönlicher Link per Teams-1:1-Chat (C3).',
		'**Max. Runden:** Ist max_runden erreicht, wird nicht mehr gefragt: Status "Eskaliert / Manuell" und Meldung im Kanal.',
		'**Erinnerung (art = erinnerung, M5):** Aufruf durch EPA-04, wenn der Kunde die Frist verpasst hat (Status "Warten auf Kunde"). Text aus fester Vorlage ohne KI, gleiche Bausteine, gleicher Freigabeweg. Rundenzähler bleibt, nach dem Versand zählt EPA-07 die Erinnerung.',
		'**Trigger:** Aufruf durch EPA-01/EPA-03 (Lücken) bzw. EPA-04 über EPA SW Nachfassen (Erinnerung).',
		'**Eingaben:** kunde_id, vorgangs_id, art (rueckfrage | erinnerung), referenz. **Ausgabe:** { ergebnis, freigabe_id, zugestellt }',
		'**Hinweis Sicherheit:** Der Klartext-Link steht nur in den Ausführungsdaten dieses Laufs. Ausführungsdaten-Aufbewahrung in n8n begrenzen.',
	].join('\n'), { breite: 900, hoehe: 400 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['art', 'string'],
		['referenz', 'string'],
	]);
	const config = wf.aufruf('Config laden', [220, 0], 'EPA SW Config laden', [
		['kunde_id', 'string', '={{ $json.kunde_id }}'],
		['postfach', 'string', ''],
	]);
	const vorgang = wf.aufruf('Vorgang lesen', [440, 0], 'EPA SW Vorgang verwalten', [
		['aktion', 'string', 'lesen'],
		['kunde_id', 'string', "={{ $('Bei Aufruf').first().json.kunde_id }}"],
		['vorgangs_id', 'string', "={{ $('Bei Aufruf').first().json.vorgangs_id }}"],
		['daten', 'object', '={{ {} }}'],
		['erwartete_version', 'number', '={{ null }}'],
		['referenz', 'string', "={{ $('Bei Aufruf').first().json.referenz || '' }}"],
		['lock_sekunden', 'number', '={{ null }}'],
	]);

	const vorbereiten = wf.code('Rückfrage vorbereiten', [660, 0], ['fehlerklassen', 'entwurf'], `
const e = $('Bei Aufruf').first().json;
const config = $('Config laden').first().json.config;
const v = $input.first().json.vorgang;
const fehler = (code, text) => fehlerklassen.epaFehler(code, v.vorgangs_id, text);
const art = e.art || 'rueckfrage';
if (!['rueckfrage', 'erinnerung'].includes(art)) throw fehler('UNGUELTIGES_FORMAT', \`Unbekannte Art "\${art}"\`);
const statusSoll = art === 'erinnerung' ? 'Warten auf Kunde' : 'Lücken erkannt';
if (v.status !== statusSoll) throw fehler('UNZULAESSIGER_STATUSWECHSEL', \`\${art === 'erinnerung' ? 'Erinnerung' : 'Rückfrage'} nur im Status "\${statusSoll}" (ist "\${v.status}")\`);
if (!config.postfach_workflow_id) throw fehler('KONFIGURATIONSFEHLER', 'postfach_workflow_id fehlt in der Config (ID der EPA-00-Kopie für dieses Postfach)');
if (!config.freigeber.length) throw fehler('KONFIGURATIONSFEHLER', 'Keine Freigeber konfiguriert');
const felder = config.vorgangstypen[v.vorgangstyp];
if (!felder) throw fehler('KONFIGURATIONSFEHLER', \`Vorgangstyp "\${v.vorgangstyp}" fehlt in der Config\`);
const fehlende = (v.fehlende_felder || []).filter((f) => f && f.feldname);
if (!fehlende.length) throw fehler('UNGUELTIGES_FORMAT', 'Keine fehlenden Felder vermerkt');
let bs;
// Antwortsprache = Sprache der Kundenmail, wenn die Config dafür Übersetzungen hat (sonst Hauptsprache).
const cfg = entwurf.sprachConfig(config, v.sprache);
try { bs = entwurf.bausteine(fehlende, felder, cfg.textbausteine); } catch (err) { throw fehler('KONFIGURATIONSFEHLER', err.message); }
// Erinnerung: gleiche Runde (die Rückfrage dieser Runde ist schon gesendet); der Rundenzähler steigt nicht.
const runde = Number(v.rundenzaehler || 0) + (art === 'erinnerung' ? 0 : 1);
const max = Number(config.max_runden);
return [{ json: {
	weg: art === 'erinnerung' ? 'vorlage' : runde > max ? 'eskalieren' : 'entwurf',
	art,
	ausloeser: art === 'erinnerung' ? 'Cronjob' : 'System',
	erinnerung_nr: Number(v.erinnerungen_gesendet || 0) + 1,
	runde,
	max_runden: max,
	fehlende,
	name: entwurf.ansprechpartner(v.extrahierte_daten, felder),
	kontext: { anrede_stil: config.anrede_stil, sprache: cfg.sprache, name: entwurf.ansprechpartner(v.extrahierte_daten, felder), betreff: v.betreff || '', luecken: bs.map((b) => b.anzeigename), runde },
} }];
`);
	const eskalieren = wf.node('Max. Runden erreicht?', 'n8n-nodes-base.if', [880, 0], {
		conditions: bedingungen([bedingung('={{ $json.weg }}', { type: 'string', operation: 'equals' }, 'eskalieren')]),
		options: {},
	});

	// ---------------------------------------------------------------- Max. Runden: eskalieren
	const statusEsk = wf.aufruf('Status: Eskaliert (Runden)', [1100, -240], 'EPA SW Status setzen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['neuer_status', 'string', 'Eskaliert / Manuell'],
		['ausloeser', 'string', 'System'],
		['details', 'object', `={{ { grund: 'Maximale Anzahl Rückfragen erreicht', max_runden: ${R}.max_runden, fehlende: ${R}.fehlende.map((f) => f.feldname) } }}`],
		['referenz', 'string', "={{ $('Bei Aufruf').first().json.referenz || '' }}"],
		['erwartete_version', 'number', `={{ ${V}.version }}`],
		['nur_wenn_erlaubt', 'boolean', '={{ false }}'],
	]);
	const meldungEsk = wf.code('Meldung: Runden erreicht', [1320, -240], ['entwurf'], `
const v = $('Vorgang lesen').first().json.vorgang;
const r = $('Rückfrage vorbereiten').first().json;
const html = '<b>Maximale Anzahl Rückfragen erreicht – bitte manuell klären</b><br>Vorgang: <b>' + entwurf.esc(v.vorgangs_id) + '</b><br>Von: ' + entwurf.esc(v.absender_adresse) + '<br>Betreff: ' + entwurf.esc(v.betreff) +
	'<br>Nach ' + r.max_runden + ' Runde(n) fehlen noch: ' + r.fehlende.map((f) => entwurf.esc(f.anzeigename || f.feldname)).join(', ') + '<br>Der Vorgang steht auf "Eskaliert / Manuell".';
return [{ json: { nachricht_html: html, anlass: 'max_runden' } }];
`);
	const infoEsk = wf.aufruf('Kanal informieren (Runden)', [1540, -240], 'EPA SW Benachrichtigen', [
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
	const ergebnisEsk = wf.code('Ergebnis: eskaliert', [1760, -240], [], `
return [{ json: { ergebnis: 'eskaliert_max_runden', freigabe_id: null, zugestellt: 0 } }];
`);

	// ---------------------------------------------------------------- Entwurf (C2)
	const vorlage = wf.node('Erinnerung (Vorlage)?', 'n8n-nodes-base.if', [1100, 120], {
		conditions: bedingungen([bedingung('={{ $json.weg }}', { type: 'string', operation: 'equals' }, 'vorlage')]),
		options: {},
	});
	const llm = wf.aufruf('Entwurf formulieren', [1320, 280], 'EPA SW LLM aufrufen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['aufgabe', 'string', 'entwurf'],
		['prompt_version', 'string', `={{ ${C}.prompt_versionen.entwurf }}`],
		['profil', 'object', `={{ ${C}.llm_profil.entwurf }}`],
		['kontext', 'object', `={{ ${R}.kontext }}`],
		['fehler_als_ergebnis', 'boolean', '={{ true }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });

	const zusammensetzen = wf.code('Entwurf zusammensetzen', [1540, 120], ['entwurf', 'freigabe'], `
// Technischer LLM-Fehler oder ungültige Antwort: kein Abbruch, sondern Standardvorlage (Fallback).
const crypto = require('crypto');
const config = $('Config laden').first().json.config;
const v = $('Vorgang lesen').first().json.vorgang;
const r = $('Rückfrage vorbereiten').first().json;
const erinnerung = r.art === 'erinnerung';
const l = erinnerung ? {} : $input.first().json || {};
const huelle = l.ok === true ? l.ergebnis : null;
const felder = config.vorgangstypen[v.vorgangstyp];
const cfg = entwurf.sprachConfig(config, v.sprache);
const e = erinnerung
	? entwurf.erinnerungBauen({ config: cfg, felder, fehlende: r.fehlende, name: r.name })
	: entwurf.entwurfBauen(huelle, { config: cfg, felder, fehlende: r.fehlende, name: r.name });
const tokens = config.freigeber.map((f) => ({ freigeber: f, ...freigabe.tokenErzeugen(crypto) }));
return [{ json: {
	...e,
	freigabe_id: freigabe.freigabeIdErzeugen(crypto),
	tokens,
	ablauf: new Date(Date.now() + config.freigabe_ablauf_stunden * 3600000).toISOString(),
	llm_status: erinnerung ? 'vorlage' : l.ok === true ? 'ok' : (l.code || (l.error ? 'technischer Fehler' : 'keine Antwort')),
} }];
`);

	const anlegen = wf.aufrufDynamisch('Entwurf im Postfach anlegen', [1760, 120], `={{ ${C}.postfach_workflow_id }}`, [
		['aktion', 'string', 'entwurf_anlegen'],
		['postfach', 'string', `={{ ${C}.postfach }}`],
		['graph_id', 'string', ''],
		['internet_message_id', 'string', `={{ ${V}.letzte_message_id || ${V}.erste_message_id }}`],
		['entwurf_id', 'string', ''],
		['freigabe_id', 'string', `={{ ${Z}.freigabe_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['html', 'string', `={{ ${Z}.html }}`],
	]);

	const freigabeZeile = wf.code('Freigabe vorbereiten', [1980, 120], [], `
const config = $('Config laden').first().json.config;
const v = $('Vorgang lesen').first().json.vorgang;
const r = $('Rückfrage vorbereiten').first().json;
const z = $('Entwurf zusammensetzen').first().json;
const d = $input.first().json;
if (!d.entwurf_id) throw new Error('[EPA:502:UPSTREAM_FEHLER:' + v.vorgangs_id + '] Postfach-Workflow hat keinen Entwurf geliefert');
return [{ json: {
	freigabe_id: z.freigabe_id, kunde_id: config.kunde_id, vorgangs_id: v.vorgangs_id, art: r.art, runde: r.runde, status: 'offen',
	empfaenger: d.empfaenger || v.absender_adresse, betreff: d.betreff, entwurf_id: d.entwurf_id, entwurf_text: z.text, abschluss: z.abschluss,
	fehlende_felder: JSON.stringify(r.fehlende), fallback: z.fallback, ablauf: z.ablauf,
	entscheider: null, entscheidung: null, bearbeitet: false, grund: null, gesendet_am: null, gesendet_message_id: null,
} }];
`);
	const freigabeSpeichern = wf.tabelle('Freigabe speichern', [2200, 120], 'insert', 'epa_freigaben');
	const tokenZeilen = wf.code('Tokens vorbereiten', [2420, 120], [], `
const z = $('Entwurf zusammensetzen').first().json;
const config = $('Config laden').first().json.config;
return z.tokens.map((t) => ({ json: { freigabe_id: z.freigabe_id, kunde_id: config.kunde_id, freigeber: t.freigeber, token_hash: t.hash, verbraucht_am: null, ablauf: z.ablauf } }));
`);
	const tokensSpeichern = wf.tabelle('Tokens speichern', [2640, 120], 'insert', 'epa_freigabe_tokens');

	const vermerken = wf.aufruf('Freigabe am Vorgang vermerken', [2860, 120], 'EPA SW Vorgang verwalten', [
		['aktion', 'string', 'aktualisieren'],
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['daten', 'object', `={{ { freigabe_id_aktuell: ${Z}.freigabe_id } }}`],
		['erwartete_version', 'number', `={{ ${V}.version }}`],
		['referenz', 'string', `={{ ${Z}.freigabe_id }}`],
		['lock_sekunden', 'number', '={{ null }}'],
	], {}, 'once');
	const statusFreigabe = wf.aufruf('Status: Freigabe ausstehend', [3080, 120], 'EPA SW Status setzen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['neuer_status', 'string', 'Freigabe ausstehend'],
		['ausloeser', 'string', `={{ ${R}.ausloeser }}`],
		['details', 'object', `={{ { freigabe_id: ${Z}.freigabe_id, art: ${R}.art, erinnerung_nr: ${R}.art === 'erinnerung' ? ${R}.erinnerung_nr : null, runde: ${R}.runde, fallback: ${Z}.fallback, pruefung: ${Z}.pruefung, llm: ${Z}.llm_status, freigeber: ${C}.freigeber } }}`],
		['referenz', 'string', `={{ ${Z}.freigabe_id }}`],
		['erwartete_version', 'number', "={{ $('Freigabe am Vorgang vermerken').first().json.vorgang.version }}"],
		['nur_wenn_erlaubt', 'boolean', '={{ false }}'],
	]);

	// ---------------------------------------------------------------- Freigeber benachrichtigen (C3)
	const nachrichten = wf.code('Freigabe-Nachrichten vorbereiten', [3300, 120], ['freigabe'], `
const config = $('Config laden').first().json.config;
const v = $('Vorgang lesen').first().json.vorgang;
const r = $('Rückfrage vorbereiten').first().json;
const z = $('Entwurf zusammensetzen').first().json;
const fg = $('Freigabe vorbereiten').first().json;
const basis = freigabe.basisUrl($execution.resumeUrl, config.freigabe_basis_url);
const ablaufText = DateTime.fromISO(z.ablauf).setZone(config.zeitzone).toFormat('dd.LL.yyyy, HH:mm');
return z.tokens.map((t) => ({ json: {
	freigeber: t.freigeber,
	nachricht_html: freigabe.nachrichtFreigeber({ vorgang: v, freigabe: fg, fehlende: r.fehlende.map((f) => ({ anzeigename: f.anzeigename || f.feldname })), link: freigabe.link(basis, t.token), ablaufText, art: r.art }),
} }));
`);
	const senden = wf.aufruf('Freigeber benachrichtigen', [3520, 120], 'EPA SW Freigabe senden', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['freigeber', 'string', '={{ $json.freigeber }}'],
		['kanal', 'string', `={{ ${C}.benachrichtigung.kanal }}`],
		['chat_id', 'string', `={{ (${C}.benachrichtigung.freigeber_chat_ids || {})[String($json.freigeber).toLowerCase()] || ${C}.benachrichtigung.chat_id || '' }}`],
		['telegram_workflow_id', 'string', `={{ ${C}.benachrichtigung.telegram_workflow_id || '' }}`],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
	], {}, 'each');
	const zustellung = wf.code('Zustellung auswerten', [3740, 120], ['entwurf'], `
const v = $('Vorgang lesen').first().json.vorgang;
const z = $('Entwurf zusammensetzen').first().json;
const zugestellt = $input.all().filter((i) => i.json && i.json.gesendet === true).length;
const html = zugestellt ? null : '<b>Freigabe-Link konnte niemandem zugestellt werden</b><br>Vorgang: <b>' + entwurf.esc(v.vorgangs_id) + '</b><br>Die ' + ($('Rückfrage vorbereiten').first().json.art === 'erinnerung' ? 'Erinnerung' : 'Rückfrage') + ' liegt als Entwurf im Postfach und wartet auf Freigabe (' + entwurf.esc(z.freigabe_id) + '). Bitte Teams-Zugang prüfen; der Fehler steht im Fehlerlog.';
return [{ json: { zugestellt, nachricht_html: html } }];
`);
	const niemand = wf.node('Niemand erreicht?', 'n8n-nodes-base.if', [3960, 120], {
		conditions: bedingungen([bedingung('={{ $json.zugestellt }}', { type: 'number', operation: 'equals' }, 0)]),
		options: {},
	});
	const kanal = wf.aufruf('Kanal warnen', [4180, 40], 'EPA SW Benachrichtigen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${V}.vorgangs_id }}`],
		['team_id', 'string', `={{ ${C}.benachrichtigung.team_id }}`],
		['channel_id', 'string', `={{ ${C}.benachrichtigung.channel_id }}`],
		['kanal', 'string', `={{ ${C}.benachrichtigung.kanal }}`],
		['chat_id', 'string', `={{ ${C}.benachrichtigung.chat_id || '' }}`],
		['telegram_workflow_id', 'string', `={{ ${C}.benachrichtigung.telegram_workflow_id || '' }}`],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
		['anlass', 'string', 'freigabe_nicht_zugestellt'],
	]);
	const ergebnis = wf.code('Ergebnis melden', [4400, 120], [], `
const z = $('Entwurf zusammensetzen').first().json;
return [{ json: { ergebnis: 'freigabe_angefordert', art: $('Rückfrage vorbereiten').first().json.art, freigabe_id: z.freigabe_id, zugestellt: $('Zustellung auswerten').first().json.zugestellt, fallback: z.fallback } }];
`);

	wf.kette(trigger, config, vorgang, vorbereiten, eskalieren);
	wf.verbinde(eskalieren, statusEsk, 0);
	wf.verbinde(eskalieren, vorlage, 1);
	wf.verbinde(vorlage, zusammensetzen, 0);
	wf.verbinde(vorlage, llm, 1);
	wf.kette(statusEsk, meldungEsk, infoEsk, ergebnisEsk);
	wf.kette(llm, zusammensetzen);
	wf.kette(zusammensetzen, anlegen, freigabeZeile, freigabeSpeichern, tokenZeilen, tokensSpeichern, vermerken, statusFreigabe, nachrichten, senden, zustellung, niemand);
	wf.verbinde(niemand, kanal, 0);
	wf.verbinde(niemand, ergebnis, 1);
	wf.kette(kanal, ergebnis);
	return wf;
};
