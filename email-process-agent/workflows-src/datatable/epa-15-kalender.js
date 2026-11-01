'use strict';
const { Workflow, bedingung, bedingungen, uuid } = require('../../tools/lib/n8n');

const P = "$('Prüfen').first().json";
const SEITE_HEADER = {
	entries: [
		{ name: 'Content-Type', value: 'text/html; charset=utf-8' },
		{ name: 'Cache-Control', value: 'no-store' },
		{ name: 'Referrer-Policy', value: 'no-referrer' },
		{ name: 'X-Robots-Tag', value: 'noindex' },
		{ name: 'X-Frame-Options', value: 'DENY' },
		{ name: 'X-Content-Type-Options', value: 'nosniff' },
	],
};

function existiert(ausdruck) {
	return bedingungen([bedingung(ausdruck, { type: 'number', operation: 'exists', singleValue: true })]);
}

module.exports = function () {
	const wf = new Workflow('EPA-15 Kalender-Endpunkt');
	// Erfolgreiche Ausführungen enthalten Links und Termindaten und werden nicht gespeichert.
	wf.settings.saveDataSuccessExecution = 'none';

	wf.notiz('Notiz Zweck', [-120, -560], [
		'## EPA-15 Kalender-Endpunkt',
		'**Zweck:** Seite hinter dem Link "Termin in den Kalender eintragen" aus der Teams-Meldung von "EPA SW Kalender prüfen". GET zeigt Anlass, Wunsch und die freien Zeiten; POST trägt die gewählte Zeit in den Kalender des Postfachs ein oder verwirft den Vorschlag.',
		'**Sicherheit:** Token einmalig (nur Hash gespeichert), Ablaufzeit (kalender.gueltig_stunden). Übernahme atomar (bedingtes Update auf status = offen): Doppelklick → "bereits bearbeitet". Der Kunde bekommt keine Nachricht.',
		'**Eintragen:** über den Postfach-Workflow des Kunden (Aktion kalender_eintragen). transactionId = Termin-ID verhindert doppelte Termine. Audit-Eintrag mit Zeit, ohne Inhalte.',
		'**Trigger:** Webhook GET/POST /webhook/epa-kalender. Muss veröffentlicht sein. Keine Credentials nötig.',
	].join('\n'), { breite: 900, hoehe: 300 });

	const hook = wf.node('Kalender-Link', 'n8n-nodes-base.webhook', [0, 0], {
		multipleMethods: true,
		httpMethod: ['GET', 'POST'],
		path: 'epa-kalender',
		responseMode: 'responseNode',
		options: {},
	}, { webhookId: uuid('EPA-15', 'epa-kalender') });

	const lesen = wf.code('Anfrage lesen', [220, 0], ['freigabe'], `
const crypto = require('crypto');
const j = $input.first().json;
const body = j.body && typeof j.body === 'object' ? j.body : {};
const post = Object.prototype.hasOwnProperty.call(body, 'aktion') || Object.prototype.hasOwnProperty.call(body, 't');
const token = String(post ? body.t || '' : (j.query || {}).t || '');
const gueltig = freigabe.istGueltigesToken(token);
return [{ json: { methode: post ? 'POST' : 'GET', token, gueltig, body: post ? body : null, hash: gueltig ? freigabe.tokenHash(crypto, token) : '__ungueltig__' } }];
`);
	const terminLesen = wf.tabelle('Termin lesen', [440, 0], 'get', 'epa_kalender_termine', { bedingungen: [['token_hash', 'eq', '={{ $json.hash }}']] }, { alwaysOutputData: true });
	const kundeLesen = wf.tabelle('Kunde lesen', [660, 0], 'get', 'epa_config_allgemein', { bedingungen: [['kunde_id', 'eq', "={{ $json.kunde_id || '__kein_kunde__' }}"]] }, { alwaysOutputData: true });
	const vorgangLesen = wf.tabelle('Vorgang lesen', [880, 0], 'get', 'epa_vorgaenge', {
		bedingungen: [
			['vorgangs_id', 'eq', "={{ $('Termin lesen').first().json.vorgangs_id || '__keine__' }}"],
			['kunde_id', 'eq', "={{ $('Termin lesen').first().json.kunde_id || '__kein_kunde__' }}"],
		],
	}, { alwaysOutputData: true });

	const pruefen = wf.code('Prüfen', [1100, 0], ['kalender', 'freigabe', 'datenTabellen'], `
const a = $('Anfrage lesen').first().json;
const da = (n) => { const j = $(n).first().json; return j && j.id !== undefined ? j : null; };
const t = da('Termin lesen');
const kunde = da('Kunde lesen');
const v = datenTabellen.zeileLesen($input.first().json, 'epa_vorgaenge');
const TITEL = { 400: 'Eingabe unvollständig', 404: 'Link ungültig', 409: 'Bereits bearbeitet', 410: 'Link abgelaufen' };
const antwort = (status, text) => [{ json: { weg: 'antworten', status, html: freigabe.seiteMeldung(TITEL[status] || 'Hinweis', text, 'fehler') } }];
if (!a.gueltig) return antwort(404, 'Dieser Link ist ungültig.');
const p = kalender.terminPruefen(t, new Date().toISOString());
if (!p.ok) return antwort(p.status, p.meldung);
if (!kunde || !v) return antwort(404, 'Der Vorgang existiert nicht mehr.');
let daten = {};
try { daten = JSON.parse(t.daten || '{}'); } catch (e) { daten = {}; }
let k = {};
try { k = JSON.parse(kunde.kalender || '{}') || {}; } catch (e) { k = {}; }
const wert = (f) => { const d = f && v.extrahierte_daten && v.extrahierte_daten[f]; const w = d && typeof d === 'object' ? d.wert : d; return w === null || w === undefined || w === '' ? null : String(w); };
const termin = {
	termin_id: t.termin_id,
	vorgangs_id: t.vorgangs_id,
	titel: wert(k.titel_feld) || 'Termin',
	ort: wert(k.ort_feld),
	kontakt: wert('Ansprechpartner'),
	telefon: wert('Telefon'),
	absender: v.absender_adresse || null,
	wunsch_text: daten.wunsch_text || '',
	vorschlaege: daten.optionen || [],
	ausweichen: [],
};
const optionen = kalender.optionen(termin);
if (a.methode === 'GET') return [{ json: { weg: 'antworten', status: 200, html: kalender.seiteFormular(freigabe.seite, { token: a.token, termin }) } }];
if (!freigabe.istGueltigesToken(a.body && a.body.t)) return antwort(400, 'Ungültiger Link.');
const f = kalender.formularLesen(a.body, optionen.length);
if (!f.ok) return antwort(400, f.meldung + ' Bitte über den Link erneut öffnen.');
const basis = { termin_id: t.termin_id, kunde_id: t.kunde_id, vorgangs_id: t.vorgangs_id, postfach: kunde.postfach, postfach_workflow_id: kunde.postfach_workflow_id };
if (f.aktion === 'verwerfen') return [{ json: { ...basis, weg: 'verwerfen' } }];
const slot = optionen[f.slot];
const zone = daten.zone || kunde.zeitzone || 'Europe/Berlin';
return [{ json: { ...basis, weg: 'eintragen', slot_text: slot.text, ereignis: JSON.stringify(kalender.ereignis({ termin, slot, zone })) } }];
`);
	const weiche = wf.node('Weiter', 'n8n-nodes-base.switch', [1320, 0], {
		mode: 'rules',
		rules: {
			values: ['antworten', 'verwerfen', 'eintragen'].map((w) => ({
				conditions: bedingungen([bedingung('={{ $json.weg }}', { type: 'string', operation: 'equals' }, w)]),
				renameOutput: true,
				outputKey: w,
			})),
		},
		options: {},
	});

	// ---------------------------------------------------------------- Verwerfen
	const vDaten = wf.code('Verwerfen vorbereiten', [1540, -220], [], `
return [{ json: { status: 'verworfen', entscheider: 'Teams-Kanal', entschieden_am: new Date().toISOString() } }];
`);
	const vSchreiben = wf.tabelle('Termin verwerfen', [1760, -220], 'update', 'epa_kalender_termine', {
		bedingungen: [['termin_id', 'eq', `={{ ${P}.termin_id }}`], ['status', 'eq', 'offen']],
	}, { alwaysOutputData: true });
	const vOk = wf.node('Verwerfen übernommen?', 'n8n-nodes-base.if', [1980, -220], { conditions: existiert("={{ $('Termin verwerfen').first().json.id }}"), options: { looseTypeValidation: true } });
	const vSeite = wf.code('Seite: verworfen', [2200, -260], ['freigabe'], `
return [{ json: { status: 200, html: freigabe.seiteMeldung('Nicht eingetragen', 'Der Termin wurde nicht in den Kalender eingetragen. Der Kunde hat keine Nachricht bekommen.', 'ok') } }];
`);
	const bereits = wf.code('Seite: bereits bearbeitet', [2200, -60], ['freigabe'], `
return [{ json: { status: 409, html: freigabe.seiteMeldung('Bereits bearbeitet', 'Dieser Termin wurde gerade von jemand anderem bzw. in einem anderen Fenster bearbeitet. Es wurde nichts doppelt eingetragen.', 'fehler') } }];
`);

	// ---------------------------------------------------------------- Eintragen
	const eDaten = wf.code('Eintragen vorbereiten', [1540, 220], [], `
return [{ json: { status: 'in_arbeit', entscheider: 'Teams-Kanal', entschieden_am: new Date().toISOString() } }];
`);
	const eUebernehmen = wf.tabelle('Termin übernehmen', [1760, 220], 'update', 'epa_kalender_termine', {
		bedingungen: [['termin_id', 'eq', `={{ ${P}.termin_id }}`], ['status', 'eq', 'offen']],
	}, { alwaysOutputData: true });
	const eOk = wf.node('Übernommen?', 'n8n-nodes-base.if', [1980, 220], { conditions: existiert("={{ $('Termin übernehmen').first().json.id }}"), options: { looseTypeValidation: true } });
	const eAnlegen = wf.aufrufDynamisch('Termin anlegen', [2200, 300], `={{ ${P}.postfach_workflow_id }}`, [
		['aktion', 'string', 'kalender_eintragen'],
		['postfach', 'string', `={{ ${P}.postfach }}`],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['daten', 'string', `={{ ${P}.ereignis }}`],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const eAuswerten = wf.code('Ergebnis vermerken (Daten)', [2420, 300], [], `
const r = $input.first().json || {};
const ok = r.ok === true;
const fehler = ok ? '' : String(r.meldung || (r.error && (r.error.message || r.error)) || 'keine Bestätigung').replace(/\\[EPA:[^\\]]*\\]\\s*/g, '').slice(0, 200);
return [{ json: { status: ok ? 'eingetragen' : 'fehler', event_id: ok ? r.event_id || '' : '', fehler } }];
`);
	const eSchreiben = wf.tabelle('Termin vermerken', [2640, 300], 'update', 'epa_kalender_termine', { bedingungen: [['termin_id', 'eq', `={{ ${P}.termin_id }}`]] });
	const eAudit = wf.aufruf('Eintrag protokollieren', [2860, 300], 'EPA SW Audit schreiben', [
		['kunde_id', 'string', `={{ ${P}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['typ', 'string', 'SYSTEM'],
		['alt', 'string', ''],
		['neu', 'string', "={{ $('Ergebnis vermerken (Daten)').first().json.status === 'eingetragen' ? 'Termin in Kalender eingetragen' : 'Termin eintragen fehlgeschlagen' }}"],
		['ausloeser', 'string', 'Mitarbeiter:Teams-Kanal'],
		['details', 'object', `={{ { termin_id: ${P}.termin_id, zeit: ${P}.slot_text, fehler: $('Ergebnis vermerken (Daten)').first().json.fehler || null } }}`],
		['referenz', 'string', `={{ ${P}.termin_id }}`],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const eSeite = wf.code('Seite: eingetragen', [3080, 300], ['freigabe'], `
const r = $('Ergebnis vermerken (Daten)').first().json;
const p = $('Prüfen').first().json;
return [{ json: r.status === 'eingetragen'
	? { status: 200, html: freigabe.seiteMeldung('Termin eingetragen', 'Der Termin ' + p.slot_text + ' steht jetzt im Kalender des Postfachs. Der Kunde hat keine Nachricht bekommen – bitte bestätigen Sie den Termin wie gewohnt.', 'ok') }
	: { status: 502, html: freigabe.seiteMeldung('Nicht eingetragen', 'Der Termin konnte nicht eingetragen werden (' + r.fehler + '). Bitte direkt in Outlook anlegen.', 'fehler') } }];
`);

	const antwort = wf.node('Seite ausliefern', 'n8n-nodes-base.respondToWebhook', [3300, 0], {
		respondWith: 'text',
		responseBody: '={{ $json.html }}',
		options: { responseCode: '={{ $json.status }}', responseHeaders: SEITE_HEADER },
	});

	wf.verbinde(hook, lesen, 0);
	wf.verbinde(hook, lesen, 1);
	wf.kette(lesen, terminLesen, kundeLesen, vorgangLesen, pruefen, weiche);
	wf.verbinde(weiche, antwort, 0);
	wf.verbinde(weiche, vDaten, 1);
	wf.verbinde(weiche, eDaten, 2);
	wf.kette(vDaten, vSchreiben, vOk);
	wf.verbinde(vOk, vSeite, 0);
	wf.verbinde(vOk, bereits, 1);
	wf.kette(vSeite, antwort);
	wf.kette(bereits, antwort);
	wf.kette(eDaten, eUebernehmen, eOk);
	wf.verbinde(eOk, eAnlegen, 0);
	wf.verbinde(eOk, bereits, 1);
	wf.kette(eAnlegen, eAuswerten, eSchreiben, eAudit, eSeite, antwort);
	return wf;
};
