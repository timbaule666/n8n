'use strict';
const { Workflow, bedingung, bedingungen, uuid } = require('../../tools/lib/n8n');

const P = "$('Prüfen').first().json";
const SEITE_HEADER = {
	entries: [
		{ name: 'Content-Type', value: 'text/html; charset=utf-8' },
		{ name: 'Cache-Control', value: 'no-store' },
		{ name: 'Referrer-Policy', value: 'no-referrer' },
		{ name: 'X-Robots-Tag', value: 'noindex' },
		// Härtung (M6): Freigabeseite darf nicht eingebettet werden (Clickjacking), kein MIME-Sniffing.
		// Eine eigene Content-Security-Policy ist wirkungslos: n8n setzt für Webhook-Antworten seine Sandbox-CSP.
		{ name: 'X-Frame-Options', value: 'DENY' },
		{ name: 'X-Content-Type-Options', value: 'nosniff' },
	],
};

function existiert(ausdruck) {
	return bedingungen([bedingung(ausdruck, { type: 'number', operation: 'exists', singleValue: true })]);
}

module.exports = function () {
	const wf = new Workflow('EPA-07 Freigabe-Endpunkt');
	// Härtung (M6): Erfolgreiche Ausführungen enthalten Klartext-Links bzw. Mail-Text und werden nicht gespeichert.
	wf.settings.saveDataSuccessExecution = 'none';

	wf.notiz('Notiz Zweck', [-120, -640], [
		'## EPA-07 Freigabe-Endpunkt (Phase C3/C4)',
		'**Zweck:** Seite hinter dem persönlichen Freigabe-Link. GET zeigt Empfänger, Betreff, fehlende Angaben und den bearbeitbaren Text; POST nimmt "Freigeben und senden" (optional mit geändertem Text) oder "Ablehnen" (mit Grund) entgegen.',
		'**Sicherheit:** Token einmalig (nur Hash gespeichert), Ablaufzeit, Freigeber muss noch in der Config stehen. Die Freigabe wird atomar übernommen (bedingtes Update auf status = offen): ein Doppelklick oder zweiter Freigeber bekommt "bereits bearbeitet". Signatur und KI-Hinweis sind nicht änderbar.',
		'**Versand (C4):** über den Postfach-Workflow des Kunden (postfach_workflow_id): vorher prüfen, ob der Entwurf noch existiert, sonst in Gesendete Elemente suchen → kein Doppelversand. Erst nach bestätigtem Versand: Status "Warten auf Kunde", Rundenzähler +1, Antwortfrist (Geschäftszeiten), Audit mit Freigeber und "bearbeitet". Bei einer Erinnerung (M5): Erinnerungszähler +1, neue Frist = Erinnerungsintervall, Runde bleibt.',
		'**Links (M5):** Jeder Link hat eine eigene Ablaufzeit. Erneuert EPA-04 eine abgelaufene Freigabe, gelten nur noch die neuen Links (alte → 410).',
		'**Fehler:** Versand fehlgeschlagen → Freigabe "fehler", Seite informiert, danach Fehler an EPA-05 (Vorgang wird gesichert, Alarm).',
		'**Trigger:** Webhook GET/POST /webhook/epa-freigabe. Muss veröffentlicht sein. Keine Credentials nötig.',
	].join('\n'), { breite: 920, hoehe: 400 });

	const hook = wf.node('Freigabe-Link', 'n8n-nodes-base.webhook', [0, 0], {
		multipleMethods: true,
		httpMethod: ['GET', 'POST'],
		path: 'epa-freigabe',
		responseMode: 'responseNode',
		options: {},
	}, { webhookId: uuid('EPA-07', 'epa-freigabe') });

	const lesen = wf.code('Anfrage lesen', [220, 0], ['freigabe'], `
const crypto = require('crypto');
const j = $input.first().json;
const body = j.body && typeof j.body === 'object' ? j.body : {};
// Abgeschicktes Formular: enthält immer das Token "t" (verstecktes Feld). Fehlt "aktion", meldet formularLesen
// "Unbekannte Aktion" statt das Formular stillschweigend erneut anzuzeigen.
const post = Object.prototype.hasOwnProperty.call(body, 'aktion') || Object.prototype.hasOwnProperty.call(body, 't');
const token = String(post ? body.t || '' : (j.query || {}).t || '');
const gueltig = freigabe.istGueltigesToken(token);
return [{ json: {
	methode: post ? 'POST' : 'GET',
	token,
	gueltig,
	hash: gueltig ? freigabe.tokenHash(crypto, token) : '__ungueltig__',
	formular: post ? freigabe.formularLesen(body) : null,
} }];
`);
	const tokenLesen = wf.tabelle('Token lesen', [440, 0], 'get', 'epa_freigabe_tokens', { bedingungen: [['token_hash', 'eq', '={{ $json.hash }}']] }, { alwaysOutputData: true });
	const fgLesen = wf.tabelle('Freigabe lesen', [660, 0], 'get', 'epa_freigaben', { bedingungen: [['freigabe_id', 'eq', "={{ $json.freigabe_id || '__keine__' }}"]] }, { alwaysOutputData: true });
	const kundeLesen = wf.tabelle('Kunde lesen', [880, 0], 'get', 'epa_config_allgemein', { bedingungen: [['kunde_id', 'eq', "={{ $json.kunde_id || '__kein_kunde__' }}"]] }, { alwaysOutputData: true });
	const vorgangLesen = wf.tabelle('Vorgang lesen', [1100, 0], 'get', 'epa_vorgaenge', {
		bedingungen: [
			['vorgangs_id', 'eq', "={{ $('Freigabe lesen').first().json.vorgangs_id || '__keine__' }}"],
			['kunde_id', 'eq', "={{ $('Freigabe lesen').first().json.kunde_id || '__kein_kunde__' }}"],
		],
	}, { alwaysOutputData: true });

	const pruefen = wf.code('Prüfen', [1320, 0], ['freigabe', 'entwurf', 'datenTabellen'], `
const a = $('Anfrage lesen').first().json;
const da = (n) => { const j = $(n).first().json; return j && j.id !== undefined ? j : null; };
const tok = da('Token lesen');
const fg = da('Freigabe lesen');
const kunde = da('Kunde lesen');
const v = datenTabellen.zeileLesen($input.first().json, 'epa_vorgaenge');
const TITEL = { 400: 'Eingabe unvollständig', 403: 'Keine Berechtigung', 404: 'Link ungültig', 409: 'Bereits bearbeitet', 410: 'Link abgelaufen' };
const antwort = (status, text) => [{ json: { weg: 'antworten', status, html: freigabe.seiteMeldung(TITEL[status] || 'Hinweis', text, 'fehler') } }];
if (!a.gueltig) return antwort(404, 'Dieser Freigabe-Link ist ungültig.');
let liste = [];
try { liste = JSON.parse((kunde && kunde.freigeber) || '[]').map((s) => String(s).toLowerCase()); } catch (e) { liste = []; }
const p = freigabe.freigabePruefen({ token: tok, freigabe: fg, freigeberErlaubt: Boolean(tok) && liste.includes(String(tok.freigeber).toLowerCase()), jetzt: new Date().toISOString() });
if (!p.ok) return antwort(p.status, p.meldung);
if (!v) return antwort(404, 'Der Vorgang existiert nicht mehr.');
let fehlende = [];
try { fehlende = JSON.parse(fg.fehlende_felder || '[]'); } catch (e) { fehlende = []; }
if (a.methode === 'GET') {
	return [{ json: { weg: 'antworten', status: 200, html: freigabe.seiteFormular({ token: a.token, freigabe: fg, vorgang: v, fehlende, text: fg.entwurf_text, abschluss: fg.abschluss }) } }];
}
const f = a.formular;
if (!f.ok) return antwort(400, f.meldung + ' Bitte über den Link erneut öffnen.');
const basis = { freigabe_id: fg.freigabe_id, kunde_id: fg.kunde_id, vorgangs_id: fg.vorgangs_id, entwurf_id: fg.entwurf_id, token_id: tok.id, entscheider: String(tok.freigeber).toLowerCase(), runde: fg.runde, art: fg.art || 'rueckfrage', erinnerungen_gesendet: Number(v.erinnerungen_gesendet || 0) };
if (f.aktion === 'ablehnen') return [{ json: { ...basis, weg: 'ablehnen', grund: f.grund } }];
const bearbeitet = freigabe.istBearbeitet(fg.entwurf_text, f.text);
let text = fg.entwurf_text;
let hinweis = [];
if (bearbeitet) {
	const c = entwurf.bearbeitungPruefen(f.text, []);
	if (!c.ok) return antwort(400, c.meldung || c.grund);
	text = c.text;
}
return [{ json: { ...basis, weg: 'senden', bearbeitet, text, html_mail: bearbeitet ? entwurf.zuHtml(text, entwurf.abschlussTeile(fg.abschluss) || { signatur: kunde.signatur, ki_hinweistext: kunde.ki_hinweistext }) : null, postfach: kunde.postfach, postfach_workflow_id: kunde.postfach_workflow_id } }];
`);
	const weiche = wf.node('Weiter', 'n8n-nodes-base.switch', [1540, 0], {
		mode: 'rules',
		rules: {
			values: ['antworten', 'ablehnen', 'senden'].map((w) => ({
				conditions: bedingungen([bedingung('={{ $json.weg }}', { type: 'string', operation: 'equals' }, w)]),
				renameOutput: true,
				outputKey: w,
			})),
		},
		options: {},
	});

	// ---------------------------------------------------------------- Ablehnen
	const abVorb = wf.code('Ablehnung vorbereiten', [1760, -260], [], `
const p = $input.first().json;
return [{ json: { status: 'abgelehnt', entscheider: p.entscheider, entscheidung: 'abgelehnt', bearbeitet: false, grund: p.grund } }];
`);
	const abSchreiben = wf.tabelle('Freigabe ablehnen', [1980, -260], 'update', 'epa_freigaben', {
		bedingungen: [['freigabe_id', 'eq', `={{ ${P}.freigabe_id }}`], ['status', 'eq', 'offen']],
	}, { alwaysOutputData: true });
	const abOk = wf.node('Ablehnung übernommen?', 'n8n-nodes-base.if', [2200, -260], { conditions: existiert("={{ $('Freigabe ablehnen').first().json.id }}"), options: { looseTypeValidation: true } });
	const abToken = wf.code('Token-Verbrauch (Ablehnung)', [2420, -340], [], `
return [{ json: { verbraucht_am: new Date().toISOString() } }];
`);
	const abTokenSchreiben = wf.tabelle('Token verbrauchen (Ablehnung)', [2640, -340], 'update', 'epa_freigabe_tokens', { bedingungen: [['id', 'eq', `={{ ${P}.token_id }}`]] });
	const abStatus = wf.aufruf('Status: Eskaliert (abgelehnt)', [2860, -340], 'EPA SW Status setzen', [
		['kunde_id', 'string', `={{ ${P}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['neuer_status', 'string', 'Eskaliert / Manuell'],
		['ausloeser', 'string', `={{ 'Mitarbeiter:' + ${P}.entscheider }}`],
		['details', 'object', `={{ { grund: 'Rückfrage abgelehnt', begruendung: ${P}.grund, freigabe_id: ${P}.freigabe_id } }}`],
		['referenz', 'string', `={{ ${P}.freigabe_id }}`],
		['erwartete_version', 'number', '={{ null }}'],
		['nur_wenn_erlaubt', 'boolean', '={{ false }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const abSeite = wf.code('Seite: abgelehnt', [3080, -340], ['freigabe'], `
const s = $input.first().json || {};
const ok = s.ok === true;
return [{ json: { status: 200, nachmelden: !ok, vorgangs_id: $('Prüfen').first().json.vorgangs_id, meldung: 'Status nach Ablehnung nicht gesetzt',
	html: freigabe.seiteMeldung('Rückfrage abgelehnt', ok ? 'Es wurde nichts gesendet. Der Vorgang steht auf "Eskaliert / Manuell" und wird manuell bearbeitet.' : 'Es wurde nichts gesendet. Der Vorgangsstatus konnte nicht automatisch angepasst werden; die Entwicklung wurde informiert.', ok ? 'ok' : 'fehler') } }];
`);
	const bereits = wf.code('Seite: bereits bearbeitet', [2420, -100], ['freigabe'], `
return [{ json: { status: 409, html: freigabe.seiteMeldung('Bereits bearbeitet', 'Diese Rückfrage wurde gerade von jemand anderem bzw. in einem anderen Fenster bearbeitet. Es wurde nichts doppelt gesendet.', 'fehler') } }];
`);

	// ---------------------------------------------------------------- Freigeben und senden
	const sVorb = wf.code('Versand vorbereiten', [1760, 260], [], `
const p = $input.first().json;
return [{ json: { status: 'in_versand', entscheider: p.entscheider, entscheidung: p.bearbeitet ? 'bearbeitet' : 'freigegeben', bearbeitet: p.bearbeitet, entwurf_text: p.text } }];
`);
	const sUebernehmen = wf.tabelle('Freigabe übernehmen', [1980, 260], 'update', 'epa_freigaben', {
		bedingungen: [['freigabe_id', 'eq', `={{ ${P}.freigabe_id }}`], ['status', 'eq', 'offen']],
	}, { alwaysOutputData: true });
	const sOk = wf.node('Übernommen?', 'n8n-nodes-base.if', [2200, 260], { conditions: existiert("={{ $('Freigabe übernehmen').first().json.id }}"), options: { looseTypeValidation: true } });
	const sToken = wf.code('Token-Verbrauch (Versand)', [2420, 340], [], `
return [{ json: { verbraucht_am: new Date().toISOString() } }];
`);
	const sTokenSchreiben = wf.tabelle('Token verbrauchen (Versand)', [2640, 340], 'update', 'epa_freigabe_tokens', { bedingungen: [['id', 'eq', `={{ ${P}.token_id }}`]] });
	const sBearbeitet = wf.node('Bearbeitet?', 'n8n-nodes-base.if', [2860, 340], {
		conditions: bedingungen([bedingung(`={{ ${P}.bearbeitet }}`, { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const POSTFACH_EINGABEN = (aktion, html) => [
		['aktion', 'string', aktion],
		['postfach', 'string', `={{ ${P}.postfach }}`],
		['graph_id', 'string', ''],
		['internet_message_id', 'string', ''],
		['entwurf_id', 'string', `={{ ${P}.entwurf_id }}`],
		['freigabe_id', 'string', `={{ ${P}.freigabe_id }}`],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['html', 'string', html],
	];
	const sAktualisieren = wf.aufrufDynamisch('Entwurf aktualisieren', [3080, 260], `={{ ${P}.postfach_workflow_id }}`, POSTFACH_EINGABEN('entwurf_aktualisieren', `={{ ${P}.html_mail }}`),
		{ onError: 'continueRegularOutput', alwaysOutputData: true });
	const sSenden = wf.aufrufDynamisch('Entwurf senden', [3300, 340], `={{ ${P}.postfach_workflow_id }}`, POSTFACH_EINGABEN('entwurf_senden', ''),
		{ onError: 'continueRegularOutput', alwaysOutputData: true });
	const sAuswerten = wf.code('Versand auswerten', [3520, 340], [], `
const r = $('Entwurf senden').isExecuted ? ($('Entwurf senden').first().json || {}) : {};
const akt = $('Entwurf aktualisieren').isExecuted ? $('Entwurf aktualisieren').first().json : null;
const fehler = akt && akt.aktualisiert !== true ? 'Bearbeiteter Text konnte nicht übernommen werden: ' + ((akt.error && (akt.error.message || akt.error)) || 'keine Bestätigung') : (r.gesendet === true ? null : 'Versand fehlgeschlagen: ' + ((r.error && (r.error.message || r.error)) || 'keine Bestätigung'));
return [{ json: { gesendet: !fehler, bereits: r.bereits === true, internet_message_id: r.internet_message_id || null, fehler } }];
`);
	const sGesendet = wf.node('Gesendet?', 'n8n-nodes-base.if', [3740, 340], {
		conditions: bedingungen([bedingung('={{ $json.gesendet }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});

	// gesendet
	const gVorb = wf.code('Gesendet vermerken (Daten)', [3960, 260], [], `
const r = $input.first().json;
return [{ json: { status: 'gesendet', gesendet_am: new Date().toISOString(), gesendet_message_id: r.internet_message_id } }];
`);
	const gSchreiben = wf.tabelle('Freigabe als gesendet vermerken', [4180, 260], 'update', 'epa_freigaben', { bedingungen: [['freigabe_id', 'eq', `={{ ${P}.freigabe_id }}`]] });
	const gStatus = wf.aufruf('Status: Warten auf Kunde', [4400, 260], 'EPA SW Status setzen', [
		['kunde_id', 'string', `={{ ${P}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['neuer_status', 'string', 'Warten auf Kunde'],
		['ausloeser', 'string', `={{ 'Mitarbeiter:' + ${P}.entscheider }}`],
		['details', 'object', `={{ { freigabe_id: ${P}.freigabe_id, art: ${P}.art, runde: ${P}.runde, bearbeitet: ${P}.bearbeitet, bereits_gesendet: $('Versand auswerten').first().json.bereits } }}`],
		['referenz', 'string', `={{ ${P}.freigabe_id }}`],
		['erwartete_version', 'number', '={{ null }}'],
		['nur_wenn_erlaubt', 'boolean', '={{ false }}'],
	]);
	const gConfig = wf.aufruf('Config laden', [4620, 260], 'EPA SW Config laden', [
		['kunde_id', 'string', `={{ ${P}.kunde_id }}`],
		['postfach', 'string', ''],
	]);
	const gFrist = wf.code('Frist berechnen', [4840, 260], ['fristen'], `
const config = $input.first().json.config;
const p = $('Prüfen').first().json;
const v = $('Versand auswerten').first().json;
// Rückfrage: neue Runde, volle Antwortfrist, Erinnerungen zurück auf 0.
// Erinnerung (M5): Runde bleibt, Erinnerungszähler +1, neue Frist = Erinnerungsintervall.
const daten = p.art === 'erinnerung'
	? { antwort_frist: fristen.berechneFrist(new Date().toISOString(), config.erinnerung_intervall_stunden, config), erinnerungen_gesendet: Number(p.erinnerungen_gesendet) + 1 }
	: { rundenzaehler: Number(p.runde), antwort_frist: fristen.berechneFrist(new Date().toISOString(), config.frist_stunden, config), erinnerungen_gesendet: 0 };
if (v.internet_message_id) daten.neue_message_ids = [v.internet_message_id];
return [{ json: { daten, version: $('Status: Warten auf Kunde').first().json.version } }];
`);
	const gVorgang = wf.aufruf('Vorgang nach Versand aktualisieren', [5060, 260], 'EPA SW Vorgang verwalten', [
		['aktion', 'string', 'aktualisieren'],
		['kunde_id', 'string', `={{ ${P}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['daten', 'object', '={{ $json.daten }}'],
		['erwartete_version', 'number', '={{ $json.version }}'],
		['referenz', 'string', `={{ ${P}.freigabe_id }}`],
		['lock_sekunden', 'number', '={{ null }}'],
	]);
	const gSeite = wf.code('Seite: gesendet', [5280, 260], ['freigabe'], `
const p = $('Prüfen').first().json;
const frist = $('Frist berechnen').first().json.daten.antwort_frist;
const config = $('Config laden').first().json.config;
const t = DateTime.fromISO(frist).setZone(config.zeitzone).toFormat('dd.LL.yyyy, HH:mm');
const was = p.art === 'erinnerung' ? 'Erinnerung' : 'Rückfrage';
return [{ json: { status: 200, html: freigabe.seiteMeldung(was + ' gesendet', (p.bearbeitet ? 'Ihr bearbeiteter Text wurde gesendet. ' : 'Die ' + was + ' wurde gesendet. ') + 'Der Vorgang ' + p.vorgangs_id + ' wartet jetzt auf die Antwort des Kunden (Frist: ' + t + ').', 'ok') } }];
`);

	// fehlgeschlagen
	const fVorb = wf.code('Versandfehler (Daten)', [3960, 440], [], `
return [{ json: { status: 'fehler' } }];
`);
	const fSchreiben = wf.tabelle('Freigabe als fehlgeschlagen vermerken', [4180, 440], 'update', 'epa_freigaben', { bedingungen: [['freigabe_id', 'eq', `={{ ${P}.freigabe_id }}`]] });
	const fSeite = wf.code('Seite: Versand fehlgeschlagen', [4400, 440], ['freigabe'], `
const p = $('Prüfen').first().json;
return [{ json: { status: 502, nachmelden: true, vorgangs_id: p.vorgangs_id, meldung: $('Versand auswerten').first().json.fehler,
	html: freigabe.seiteMeldung('Versand fehlgeschlagen', 'Die Mail konnte nicht gesendet werden. Es wurde nichts doppelt gesendet. Die Entwicklung ist informiert, der Vorgang wird manuell weiterbearbeitet.', 'fehler') } }];
`);

	// ---------------------------------------------------------------- Antwort
	const antwort = wf.node('Seite ausliefern', 'n8n-nodes-base.respondToWebhook', [5500, 0], {
		respondWith: 'text',
		responseBody: '={{ $json.html }}',
		options: { responseCode: '={{ $json.status }}', responseHeaders: SEITE_HEADER },
	});
	const nachmelden = wf.node('Fehler nachmelden?', 'n8n-nodes-base.if', [5720, 0], {
		conditions: bedingungen([bedingung('={{ $json.nachmelden }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	const ausloesen = wf.code('Fehler an EPA-05', [5940, -80], ['fehlerklassen'], `
// Erst nach der Antwort an den Browser: Fehler auslösen, damit EPA-05 protokolliert, alarmiert und den Vorgang sichert.
const j = $input.first().json;
throw fehlerklassen.epaFehler('UPSTREAM_FEHLER', j.vorgangs_id || null, j.meldung || 'Freigabe-Versand fehlgeschlagen');
`);

	wf.verbinde(hook, lesen, 0);
	wf.verbinde(hook, lesen, 1);
	wf.kette(lesen, tokenLesen, fgLesen, kundeLesen, vorgangLesen, pruefen, weiche);
	wf.verbinde(weiche, antwort, 0);
	wf.verbinde(weiche, abVorb, 1);
	wf.verbinde(weiche, sVorb, 2);
	wf.kette(abVorb, abSchreiben, abOk);
	wf.verbinde(abOk, abToken, 0);
	wf.verbinde(abOk, bereits, 1);
	wf.kette(abToken, abTokenSchreiben, abStatus, abSeite, antwort);
	wf.kette(sVorb, sUebernehmen, sOk);
	wf.verbinde(sOk, sToken, 0);
	wf.verbinde(sOk, bereits, 1);
	wf.kette(bereits, antwort);
	wf.kette(sToken, sTokenSchreiben, sBearbeitet);
	wf.verbinde(sBearbeitet, sAktualisieren, 0);
	wf.verbinde(sBearbeitet, sSenden, 1);
	const sTextOk = wf.node('Text übernommen?', 'n8n-nodes-base.if', [3300, 180], {
		conditions: bedingungen([bedingung('={{ $json.aktualisiert }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	// Scheitert das Übernehmen des bearbeiteten Textes, wird NICHT der alte Entwurf gesendet.
	wf.kette(sAktualisieren, sTextOk);
	wf.verbinde(sTextOk, sSenden, 0);
	wf.verbinde(sTextOk, sAuswerten, 1);
	wf.kette(sSenden, sAuswerten, sGesendet);
	wf.verbinde(sGesendet, gVorb, 0);
	wf.verbinde(sGesendet, fVorb, 1);
	wf.kette(gVorb, gSchreiben, gStatus, gConfig, gFrist, gVorgang, gSeite, antwort);
	wf.kette(fVorb, fSchreiben, fSeite, antwort);
	wf.kette(antwort, nachmelden);
	wf.verbinde(nachmelden, ausloesen, 0);
	return wf;
};
