'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const E = "$('Bei Aufruf').first().json";
const C = "$('Config laden').first().json.config";
const V = "$('Vorgang lesen').first().json.vorgang";
const A = "$('Auffrischen prüfen').first().json";

function existiert(ausdruck) {
	return bedingungen([bedingung(ausdruck, { type: 'number', operation: 'exists', singleValue: true })]);
}

module.exports = function () {
	const wf = new Workflow('EPA SW Nachfassen');
	// Härtung (M6): Erfolgreiche Ausführungen enthalten Klartext-Links bzw. Mail-Text und werden nicht gespeichert.
	wf.settings.saveDataSuccessExecution = 'none';

	wf.notiz('Notiz Zweck', [-80, -560], [
		'## EPA SW Nachfassen (Phase E, eine Aufgabe)',
		'**Zweck:** Führt eine von EPA-04 geplante Aufgabe für genau einen Vorgang bzw. eine Freigabe aus. Prüft vorher erneut, ob die Aufgabe noch gilt (der Kunde kann inzwischen geantwortet haben).',
		'**erinnerung (Fall 1):** Erinnerungsentwurf über EPA-02 (art = erinnerung): Vorlage mit den Bausteinen der offenen Felder, Freigabe nötig, nie automatischer Versand.',
		'**eskalation (Fall 2):** Status "Eskaliert / Manuell" (Auslöser Cronjob, mit Versionsprüfung) und Teams-Nachricht "Kunde reagiert seit N Tagen nicht … bitte telefonisch kontaktieren" mit Kontaktdaten.',
		'**freigabe_erinnerung:** Freigabe ist seit freigabe_erinnerung_stunden offen: neue persönliche Links an alle Freigeber (alte bleiben gültig).',
		'**freigabe_erneuern:** Freigabe ist abgelaufen: neue Ablaufzeit, alle alten Links gesperrt (410), neue Links an alle Freigeber. Es wird nie automatisch gesendet.',
		'**freigabe_nach_fehler:** Versand nach Freigabe ist fehlgeschlagen (z. B. Postfach gesperrt). Ist das Postfach wieder erreichbar (verbindung_pruefen), wird die Freigabe wieder geöffnet und kommt mit neuem Link und Fehlergrund erneut zur Freigabe; alte Links bleiben gesperrt.',
		'**Trigger:** Aufruf durch EPA-04 (einzeln je Aufgabe). **Eingaben:** aktion, kunde_id, vorgangs_id, freigabe_id, jetzt, referenz. **Ausgabe:** { ergebnis }',
	].join('\n'), { breite: 900, hoehe: 360 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['aktion', 'string'],
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['freigabe_id', 'string'],
		['jetzt', 'string'],
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
		['referenz', 'string', `={{ ${E}.referenz || '' }}`],
		['lock_sekunden', 'number', '={{ null }}'],
	]);
	const weiche = wf.node('Aktion', 'n8n-nodes-base.switch', [660, 0], {
		mode: 'rules',
		rules: {
			values: [
				['erinnerung', 'equals', 'erinnerung'],
				['eskalation', 'equals', 'eskalation'],
				['freigabe', 'startsWith', 'freigabe_'],
			].map(([key, operation, wert]) => ({
				conditions: bedingungen([bedingung(`={{ ${E}.aktion }}`, { type: 'string', operation }, wert)]),
				renameOutput: true,
				outputKey: key,
			})),
		},
		options: { fallbackOutput: 'extra', renameFallbackOutput: 'unbekannt' },
	});
	const unbekannt = wf.code('Unbekannte Aktion', [880, 420], ['fehlerklassen'], `
throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', ${E}.vorgangs_id || null, 'Unbekannte Nachfass-Aktion "' + ${E}.aktion + '"');
`);

	// ---------------------------------------------------------------- Fall 1: Erinnerung an den Kunden
	const erinnerung = wf.aufruf('Erinnerung anfordern', [880, -320], 'EPA-02 Rückfrage anfordern', [
		['kunde_id', 'string', `={{ ${E}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${E}.vorgangs_id }}`],
		['art', 'string', 'erinnerung'],
		['referenz', 'string', `={{ ${E}.referenz || '' }}`],
	]);
	const ergErinnerung = wf.code('Ergebnis: Erinnerung', [1100, -320], [], `
const r = $input.first().json;
return [{ json: { ergebnis: 'erinnerung_' + (r.ergebnis || 'unbekannt'), freigabe_id: r.freigabe_id || null, zugestellt: r.zugestellt ?? null } }];
`);

	// ---------------------------------------------------------------- Fall 2: Eskalation
	const eskPruefen = wf.code('Eskalation prüfen', [880, -100], [], `
// Gilt die Aufgabe noch? Der Kunde kann seit der Planung geantwortet haben.
const e = $('Bei Aufruf').first().json;
const config = $('Config laden').first().json.config;
const v = $('Vorgang lesen').first().json.vorgang;
const jetzt = e.jetzt || new Date().toISOString();
let grund = '';
if (v.status !== 'Warten auf Kunde') grund = 'status_geaendert';
else if (!v.antwort_frist || new Date(v.antwort_frist).getTime() >= new Date(jetzt).getTime()) grund = 'frist_nicht_abgelaufen';
else if (Number(v.erinnerungen_gesendet || 0) < Number(config.anzahl_erinnerungen || 0)) grund = 'erinnerungen_offen';
return [{ json: { eskalieren: !grund, grund, jetzt } }];
`);
	const eskOk = wf.node('Eskalieren?', 'n8n-nodes-base.if', [1100, -100], {
		conditions: bedingungen([bedingung('={{ $json.eskalieren }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const gesendete = wf.tabelle('Gesendete Nachrichten lesen', [1320, -180], 'get', 'epa_freigaben', {
		bedingungen: [['kunde_id', 'eq', `={{ ${E}.kunde_id }}`], ['vorgangs_id', 'eq', `={{ ${E}.vorgangs_id }}`], ['status', 'eq', 'gesendet']],
		alle: true,
	}, { alwaysOutputData: true });
	const eskMeldung = wf.code('Meldung: keine Reaktion', [1540, -180], ['nachfassen'], `
const v = $('Vorgang lesen').first().json.vorgang;
const jetzt = $('Eskalation prüfen').first().json.jetzt;
const gesendet = $input.all().map((i) => i.json).filter((z) => z && z.id !== undefined);
const tage = nachfassen.tageOhneReaktion(v, gesendet, jetzt);
const daten = v.extrahierte_daten || {};
return [{ json: {
	tage,
	nachricht_html: nachfassen.meldungKeineReaktion({ vorgang: v, tage, erinnerungen: v.erinnerungen_gesendet, fehlende: v.fehlende_felder, daten }),
} }];
`);
	const eskStatus = wf.aufruf('Status: Eskaliert (keine Reaktion)', [1760, -180], 'EPA SW Status setzen', [
		['kunde_id', 'string', `={{ ${E}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${E}.vorgangs_id }}`],
		['neuer_status', 'string', 'Eskaliert / Manuell'],
		['ausloeser', 'string', 'Cronjob'],
		['details', 'object', `={{ { grund: 'Kunde reagiert nicht auf Nachfragen', erinnerungen_gesendet: ${V}.erinnerungen_gesendet, tage_ohne_reaktion: $json.tage, fehlende: (${V}.fehlende_felder || []).map((f) => f.feldname) } }}`],
		['referenz', 'string', `={{ ${E}.referenz || '' }}`],
		['erwartete_version', 'number', `={{ ${V}.version }}`],
		['nur_wenn_erlaubt', 'boolean', '={{ false }}'],
	]);
	const eskInfo = wf.aufruf('Mitarbeiter informieren', [1980, -180], 'EPA SW Benachrichtigen', [
		['kunde_id', 'string', `={{ ${E}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${E}.vorgangs_id }}`],
		['team_id', 'string', `={{ ${C}.benachrichtigung.team_id }}`],
		['channel_id', 'string', `={{ ${C}.benachrichtigung.channel_id }}`],
		['kanal', 'string', `={{ ${C}.benachrichtigung.kanal }}`],
		['chat_id', 'string', `={{ ${C}.benachrichtigung.chat_id || '' }}`],
		['telegram_workflow_id', 'string', `={{ ${C}.benachrichtigung.telegram_workflow_id || '' }}`],
		['nachricht_html', 'string', "={{ $('Meldung: keine Reaktion').first().json.nachricht_html }}"],
		['anlass', 'string', 'keine_reaktion'],
	]);
	const ergEsk = wf.code('Ergebnis: eskaliert', [2200, -180], [], `
return [{ json: { ergebnis: 'eskaliert', tage: $('Meldung: keine Reaktion').first().json.tage } }];
`);
	const ergEskNein = wf.code('Ergebnis: Eskalation entfällt', [1320, -20], [], `
return [{ json: { ergebnis: 'entfaellt_' + $('Eskalation prüfen').first().json.grund } }];
`);

	// ---------------------------------------------------------------- Freigabe erinnern / erneuern
	const fgLesen = wf.tabelle('Freigabe lesen', [880, 200], 'get', 'epa_freigaben', {
		bedingungen: [['freigabe_id', 'eq', `={{ ${E}.freigabe_id || '__keine__' }}`], ['kunde_id', 'eq', `={{ ${E}.kunde_id }}`]],
	}, { alwaysOutputData: true });
	const pruefen = wf.code('Auffrischen prüfen', [1100, 200], ['fehlerklassen', 'nachfassen', 'freigabe'], `
const crypto = require('crypto');
const e = $('Bei Aufruf').first().json;
const config = $('Config laden').first().json.config;
const f = $input.first().json;
const jetzt = e.jetzt || new Date().toISOString();
const r = nachfassen.freigabeAuffrischen({ aktion: e.aktion, freigabe: f && f.id !== undefined ? f : null, config, jetzt, vorgang: $('Vorgang lesen').first().json.vorgang });
if (!r.ok) return [{ json: { weiter: false, grund: r.grund } }];
if (!config.freigeber.length) throw fehlerklassen.epaFehler('KONFIGURATIONSFEHLER', e.vorgangs_id, 'Keine Freigeber konfiguriert');
return [{ json: {
	weiter: true,
	alte_sperren: r.alteLinksSperren,
	ablauf: r.ablauf,
	daten: r.daten,
	tokens: config.freigeber.map((fg) => ({ freigeber: fg, ...freigabe.tokenErzeugen(crypto) })),
} }];
`);
	// Nach Versandfehler erst prüfen, ob das Postfach wieder erreichbar ist. Sonst nichts tun, nächster Lauf prüft erneut.
	const postfachNoetig = wf.node('Postfach prüfen nötig?', 'n8n-nodes-base.if', [1210, 320], {
		conditions: bedingungen([bedingung(`={{ ${A}.weiter === true && ${E}.aktion === 'freigabe_nach_fehler' }}`, { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const postfach = wf.aufrufDynamisch('Postfach prüfen', [1320, 420], `={{ ${C}.postfach_workflow_id }}`, [
		['aktion', 'string', 'verbindung_pruefen'],
		['postfach', 'string', `={{ ${C}.postfach }}`],
		['graph_id', 'string', ''],
		['internet_message_id', 'string', ''],
		['entwurf_id', 'string', ''],
		['freigabe_id', 'string', ''],
		['vorgangs_id', 'string', ''],
		['html', 'string', ''],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const postfachOk = wf.code('Postfach auswerten', [1430, 420], [], `
const r = $input.first().json || {};
const ok = r.ok === true;
return [{ json: { ...$('Auffrischen prüfen').first().json, weiter: ok, grund: ok ? '' : 'postfach_noch_gestoert' } }];
`);
	const auffrischen = wf.node('Auffrischen?', 'n8n-nodes-base.if', [1320, 200], {
		conditions: bedingungen([bedingung('={{ $json.weiter }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const fgDaten = wf.code('Freigabe-Daten', [1540, 120], [], `
return [{ json: $input.first().json.daten }];
`);
	// Bedingt auf status = offen (nach Versandfehler: fehler): Hat inzwischen jemand entschieden oder kam eine Kundenantwort, passiert nichts.
	const fgSchreiben = wf.tabelle('Freigabe aktualisieren', [1760, 120], 'update', 'epa_freigaben', {
		bedingungen: [['freigabe_id', 'eq', `={{ ${E}.freigabe_id }}`], ['status', 'eq', `={{ ${E}.aktion === 'freigabe_nach_fehler' ? 'fehler' : 'offen' }}`]],
	}, { alwaysOutputData: true });
	const fgOk = wf.node('Freigabe noch offen?', 'n8n-nodes-base.if', [1980, 120], { conditions: existiert("={{ $('Freigabe aktualisieren').first().json.id }}"), options: { looseTypeValidation: true } });
	const sperren = wf.node('Alte Links sperren?', 'n8n-nodes-base.if', [2200, 40], {
		conditions: bedingungen([bedingung(`={{ ${A}.alte_sperren }}`, { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const sperrDaten = wf.code('Sperrdaten', [2420, -40], [], `
return [{ json: { ablauf: new Date().toISOString() } }];
`);
	const tokSperren = wf.tabelle('Alte Links sperren', [2640, -40], 'update', 'epa_freigabe_tokens', {
		bedingungen: [['freigabe_id', 'eq', `={{ ${E}.freigabe_id }}`], ['verbraucht_am', 'isEmpty']],
	}, { alwaysOutputData: true });
	const tokZeilen = wf.code('Neue Links vorbereiten', [2860, 40], [], `
const e = $('Bei Aufruf').first().json;
const a = $('Auffrischen prüfen').first().json;
return a.tokens.map((t) => ({ json: { freigabe_id: e.freigabe_id, kunde_id: e.kunde_id, freigeber: t.freigeber, token_hash: t.hash, verbraucht_am: null, ablauf: a.ablauf } }));
`, { executeOnce: true });
	const tokSpeichern = wf.tabelle('Neue Links speichern', [3080, 40], 'insert', 'epa_freigabe_tokens');
	const nachrichten = wf.code('Nachrichten vorbereiten', [3300, 40], ['freigabe'], `
const e = $('Bei Aufruf').first().json;
const config = $('Config laden').first().json.config;
const v = $('Vorgang lesen').first().json.vorgang;
const f = $('Freigabe lesen').first().json;
const a = $('Auffrischen prüfen').first().json;
let fehlende = [];
try { fehlende = JSON.parse(f.fehlende_felder || '[]'); } catch (err) { fehlende = []; }
const basis = freigabe.basisUrl($execution.resumeUrl, config.freigabe_basis_url);
const ablaufText = DateTime.fromISO(a.ablauf).setZone(config.zeitzone).toFormat('dd.LL.yyyy, HH:mm');
return a.tokens.map((t) => ({ json: {
	freigeber: t.freigeber,
	nachricht_html: freigabe.nachrichtFreigeber({ vorgang: v, freigabe: f, fehlende: fehlende.map((x) => ({ anzeigename: x.anzeigename || x.feldname })), link: freigabe.link(basis, t.token), ablaufText, art: f.art, anlass: e.aktion }),
} }));
`, { executeOnce: true });
	const senden = wf.aufruf('Freigeber benachrichtigen', [3520, 40], 'EPA SW Freigabe senden', [
		['kunde_id', 'string', `={{ ${E}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${E}.vorgangs_id }}`],
		['freigeber', 'string', '={{ $json.freigeber }}'],
		['kanal', 'string', `={{ ${C}.benachrichtigung.kanal }}`],
		['chat_id', 'string', `={{ (${C}.benachrichtigung.freigeber_chat_ids || {})[String($json.freigeber).toLowerCase()] || ${C}.benachrichtigung.chat_id || '' }}`],
		['telegram_workflow_id', 'string', `={{ ${C}.benachrichtigung.telegram_workflow_id || '' }}`],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
	], {}, 'each');
	const zustellung = wf.code('Zustellung auswerten', [3740, 40], ['entwurf'], `
const e = $('Bei Aufruf').first().json;
const zugestellt = $input.all().filter((i) => i.json && i.json.gesendet === true).length;
const html = zugestellt ? null : '<b>Neuer Freigabe-Link konnte niemandem zugestellt werden</b><br>Vorgang: <b>' + entwurf.esc(e.vorgangs_id) + '</b><br>Freigabe ' + entwurf.esc(e.freigabe_id) + ' ist weiter offen. Bitte Teams-Zugang prüfen; der Fehler steht im Fehlerlog.';
return [{ json: { zugestellt, nachricht_html: html } }];
`);
	const niemand = wf.node('Niemand erreicht?', 'n8n-nodes-base.if', [3960, 40], {
		conditions: bedingungen([bedingung('={{ $json.zugestellt }}', { type: 'number', operation: 'equals' }, 0)]),
		options: {},
	});
	const kanal = wf.aufruf('Kanal warnen', [4180, -40], 'EPA SW Benachrichtigen', [
		['kunde_id', 'string', `={{ ${E}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${E}.vorgangs_id }}`],
		['team_id', 'string', `={{ ${C}.benachrichtigung.team_id }}`],
		['channel_id', 'string', `={{ ${C}.benachrichtigung.channel_id }}`],
		['kanal', 'string', `={{ ${C}.benachrichtigung.kanal }}`],
		['chat_id', 'string', `={{ ${C}.benachrichtigung.chat_id || '' }}`],
		['telegram_workflow_id', 'string', `={{ ${C}.benachrichtigung.telegram_workflow_id || '' }}`],
		['nachricht_html', 'string', '={{ $json.nachricht_html }}'],
		['anlass', 'string', 'freigabe_nicht_zugestellt'],
	]);
	const ergFg = wf.code('Ergebnis: Freigabe', [4400, 40], [], `
const e = $('Bei Aufruf').first().json;
return [{ json: { ergebnis: { freigabe_erneuern: 'links_erneuert', freigabe_nach_fehler: 'erneut_zur_freigabe' }[e.aktion] || 'freigeber_erinnert', zugestellt: $('Zustellung auswerten').first().json.zugestellt } }];
`);
	const ergFgNein = wf.code('Ergebnis: Freigabe entfällt', [1540, 300], [], `
const p = $('Postfach auswerten').isExecuted ? $('Postfach auswerten').first().json : $('Auffrischen prüfen').first().json;
return [{ json: { ergebnis: 'entfaellt_' + (p.grund || 'nicht_mehr_offen') } }];
`);

	wf.kette(trigger, config, vorgang, weiche);
	wf.verbinde(weiche, erinnerung, 0);
	wf.verbinde(weiche, eskPruefen, 1);
	wf.verbinde(weiche, fgLesen, 2);
	wf.verbinde(weiche, unbekannt, 3);
	wf.kette(erinnerung, ergErinnerung);
	wf.kette(eskPruefen, eskOk);
	wf.verbinde(eskOk, gesendete, 0);
	wf.verbinde(eskOk, ergEskNein, 1);
	wf.kette(gesendete, eskMeldung, eskStatus, eskInfo, ergEsk);
	wf.kette(fgLesen, pruefen, postfachNoetig);
	wf.verbinde(postfachNoetig, postfach, 0);
	wf.verbinde(postfachNoetig, auffrischen, 1);
	wf.kette(postfach, postfachOk, auffrischen);
	wf.verbinde(auffrischen, fgDaten, 0);
	wf.verbinde(auffrischen, ergFgNein, 1);
	wf.kette(fgDaten, fgSchreiben, fgOk);
	wf.verbinde(fgOk, sperren, 0);
	wf.verbinde(fgOk, ergFgNein, 1);
	wf.verbinde(sperren, sperrDaten, 0);
	wf.verbinde(sperren, tokZeilen, 1);
	wf.kette(sperrDaten, tokSperren, tokZeilen);
	wf.kette(tokZeilen, tokSpeichern, nachrichten, senden, zustellung, niemand);
	wf.verbinde(niemand, kanal, 0);
	wf.verbinde(niemand, ergFg, 1);
	wf.kette(kanal, ergFg);
	return wf;
};
