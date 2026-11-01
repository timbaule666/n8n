'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const C = "$('Config laden').first().json.config";

module.exports = function () {
	const wf = new Workflow('EPA SW Kalender prüfen');
	// Erzeugt Links mit Token: erfolgreiche Ausführungen nicht speichern.
	wf.settings.saveDataSuccessExecution = 'none';

	wf.notiz('Notiz Zweck', [-80, -420], [
		'## EPA SW Kalender prüfen',
		'**Zweck:** Ist eine Terminanfrage vollständig, prüft dieser Workflow im Outlook-Kalender des Postfachs, ob der Wunschtermin frei ist, und schickt dem Team eine Meldung mit Link "Termin in den Kalender eintragen" (EPA-15). Eingetragen wird erst nach dem Klick; der Kunde bekommt keine Nachricht.',
		'**Trigger:** Aufruf durch EPA-01 und EPA-03, wenn ein Vorgang "Bereit zur Bearbeitung" ist.',
		'**Eingaben:** kunde_id, vorgangs_id.',
		'**Config:** epa_config_allgemein.kalender (aktiv, vorgangstyp, datum_feld, uhrzeit_feld, titel_feld, ort_feld, dauer_minuten, gueltig_stunden). Leer = nichts passiert.',
		'**Datenschutz:** Aus dem Kalender werden nur Zeiten und Status gelesen, keine Betreffe oder Teilnehmer. In epa_kalender_termine stehen nur Zeiten und der Hash des Links.',
		'**Fehler:** Kann der Kalender nicht gelesen werden, kommt eine Meldung ohne Link ("bitte selbst prüfen"). Die Mailverarbeitung wird nie gestört.',
	].join('\n'), { breite: 760, hoehe: 340 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
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
		['referenz', 'string', 'kalender'],
		['lock_sekunden', 'number', '={{ null }}'],
	]);
	const plan = wf.code('Plan erstellen', [660, 0], ['kalender'], `
const config = ${C};
const v = $input.first().json.vorgang;
const p = kalender.plan(config, v, new Date().toISOString());
if (!p.relevant) return [{ json: { weiter: false, grund: p.grund } }];
if (!config.postfach_workflow_id) return [{ json: { weiter: false, grund: 'kein Postfach-Workflow' } }];
// Ganzer Tag, damit auch freie Ausweichzeiten am selben Tag gefunden werden.
const daten = JSON.stringify({ von: kalender.zuIso(p.datum, '00:00', p.zone), bis: kalender.zuIso(p.datum, '23:59', p.zone) });
return [{ json: { weiter: true, plan: p, daten, postfach: config.postfach, postfach_workflow_id: config.postfach_workflow_id } }];
`);
	const weiter = wf.node('Kalender prüfen?', 'n8n-nodes-base.if', [880, 0], {
		conditions: bedingungen([bedingung('={{ $json.weiter }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	const lesen = wf.aufrufDynamisch('Kalender lesen', [1100, -80], '={{ $json.postfach_workflow_id }}', [
		['aktion', 'string', 'kalender_pruefen'],
		['postfach', 'string', '={{ $json.postfach }}'],
		['daten', 'string', '={{ $json.daten }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const bewerten = wf.code('Bewerten', [1320, -80], ['kalender', 'freigabe'], `
const crypto = require('crypto');
const config = ${C};
const v = $('Vorgang lesen').first().json.vorgang;
const p = $('Plan erstellen').first().json.plan;
const r = $input.first().json || {};
if (r.ok !== true) {
	const fehler = r.meldung || (r.error && (r.error.message || r.error)) || 'keine Antwort vom Postfach';
	return [{ json: { mit_link: false, nachricht_html: kalender.meldung({ vorgangs_id: v.vorgangs_id, plan: p, fehler: String(fehler).replace(/\\[EPA:[^\\]]*\\]\\s*/g, '').slice(0, 160) }), ergebnis: 'kalender_fehler' } }];
}
const e = kalender.bewerten(p, r.ereignisse);
if (!e.frei) e.ausweichen = kalender.ausweichen(p, r.ereignisse, config.geschaeftszeiten);
const termin = { vorgangs_id: v.vorgangs_id, vorschlaege: e.vorschlaege, ausweichen: e.ausweichen || [] };
const optionen = kalender.optionen(termin);
if (!optionen.length) {
	return [{ json: { mit_link: false, nachricht_html: kalender.meldung({ vorgangs_id: v.vorgangs_id, plan: p, ergebnis: e }), ergebnis: 'keine_freie_zeit' } }];
}
const t = freigabe.tokenErzeugen(crypto);
const gueltig = Number(config.kalender.gueltig_stunden) || 72;
const ablauf = new Date(Date.now() + gueltig * 3600000).toISOString();
const link = freigabe.basisUrl($execution.resumeUrl, config.freigabe_basis_url) + '/webhook/epa-kalender?t=' + encodeURIComponent(t.token);
const ablaufText = new Date(ablauf).toLocaleString('de-DE', { timeZone: p.zone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
return [{ json: {
	mit_link: true,
	nachricht_html: kalender.meldung({ vorgangs_id: v.vorgangs_id, plan: p, ergebnis: e, link, ablaufText }),
	ergebnis: e.frei ? 'frei' : 'belegt',
	zeile: {
		termin_id: 'K-' + crypto.randomUUID(),
		kunde_id: config.kunde_id,
		vorgangs_id: v.vorgangs_id,
		token_hash: t.hash,
		status: 'offen',
		ablauf,
		daten: JSON.stringify({ optionen, wunsch_text: kalender.wunschText(p), zone: p.zone, frei: e.frei }),
	},
} }];
`);
	const linkFrage = wf.node('Link anlegen?', 'n8n-nodes-base.if', [1540, -80], {
		conditions: bedingungen([bedingung('={{ $json.mit_link }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	const zeile = wf.code('Zeile vorbereiten', [1760, -160], [], `
return [{ json: $input.first().json.zeile }];
`);
	const speichern = wf.tabelle('Termin speichern', [1980, -160], 'insert', 'epa_kalender_termine');
	const informieren = wf.aufruf('Team informieren', [2200, -80], 'EPA SW Benachrichtigen', [
		['kunde_id', 'string', `={{ ${C}.kunde_id }}`],
		['vorgangs_id', 'string', "={{ $('Bei Aufruf').first().json.vorgangs_id }}"],
		['team_id', 'string', `={{ ${C}.benachrichtigung.team_id }}`],
		['channel_id', 'string', `={{ ${C}.benachrichtigung.channel_id }}`],
		['kanal', 'string', `={{ ${C}.benachrichtigung.kanal }}`],
		['chat_id', 'string', `={{ ${C}.benachrichtigung.chat_id || '' }}`],
		['telegram_workflow_id', 'string', `={{ ${C}.benachrichtigung.telegram_workflow_id || '' }}`],
		['nachricht_html', 'string', "={{ $('Bewerten').first().json.nachricht_html }}"],
		['anlass', 'string', "={{ 'kalender_' + $('Bewerten').first().json.ergebnis }}"],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const ergebnis = wf.code('Ergebnis melden', [2420, -80], [], `
const b = $('Bewerten').first().json;
return [{ json: { geprueft: true, ergebnis: b.ergebnis, link: b.mit_link === true, benachrichtigt: $input.first().json.gesendet === true } }];
`);
	const nichts = wf.code('Ergebnis: nicht geprüft', [1100, 120], [], `
return [{ json: { geprueft: false, grund: $input.first().json.grund } }];
`);

	wf.kette(trigger, config, vorgang, plan, weiter);
	wf.verbinde(weiter, lesen, 0);
	wf.verbinde(weiter, nichts, 1);
	wf.kette(lesen, bewerten, linkFrage);
	wf.verbinde(linkFrage, zeile, 0);
	wf.verbinde(linkFrage, informieren, 1);
	wf.kette(zeile, speichern, informieren, ergebnis);
	return wf;
};
