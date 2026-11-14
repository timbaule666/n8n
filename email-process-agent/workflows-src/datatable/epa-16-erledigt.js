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
	const wf = new Workflow('EPA-16 Erledigt-Endpunkt');
	// Erfolgreiche Ausführungen enthalten Links und werden nicht gespeichert.
	wf.settings.saveDataSuccessExecution = 'none';

	wf.notiz('Notiz Zweck', [-120, -560], [
		'## EPA-16 Erledigt-Endpunkt',
		'**Zweck:** Seite hinter dem Knopf „✅ Erledigt – Karte entfernen“ auf den Karten in „1 Vollständige Anfragen“ (Link von EPA SW Benachrichtigen, src/erledigt.js). GET zeigt eine Bestätigung (ändert nichts, Link-Vorschauen lösen nichts aus); POST schließt den Vorgang ab.',
		'**Abschluss:** Link verbrauchen (atomar, bedingtes Update auf verbraucht_am leer) → Status „Abgeschlossen“ (SW Status setzen, Auslöser Mitarbeiter:<Name>; schickt die Abschlusskarte nach „Logs“) → Karte aus „Vollständige Anfragen“ entfernen (Postfach-Kopie, teams_kanal_loeschen).',
		'**Sicherheit:** Token einmalig, nur Hash gespeichert (epa_erledigt_links), gültig 30 Tage. Nur bei Status „Bereit zur Bearbeitung“. Name aus Freigebern/Vertretern der Config (Protokoll). Der Kunde bekommt keine Nachricht.',
		'**Trigger:** Webhook GET/POST /webhook/epa-erledigt. Muss veröffentlicht sein. Keine Credentials nötig.',
	].join('\n'), { breite: 900, hoehe: 300 });

	const hook = wf.node('Erledigt-Link', 'n8n-nodes-base.webhook', [0, 0], {
		multipleMethods: true,
		httpMethod: ['GET', 'POST'],
		path: 'epa-erledigt',
		responseMode: 'responseNode',
		options: {},
	}, { webhookId: uuid('EPA-16', 'epa-erledigt') });

	const lesen = wf.code('Anfrage lesen', [220, 0], ['freigabe'], `
const crypto = require('crypto');
const j = $input.first().json;
const body = j.body && typeof j.body === 'object' ? j.body : {};
const post = Object.prototype.hasOwnProperty.call(body, 'aktion') || Object.prototype.hasOwnProperty.call(body, 't');
const token = String(post ? body.t || '' : (j.query || {}).t || '');
const gueltig = freigabe.istGueltigesToken(token);
return [{ json: { methode: post ? 'POST' : 'GET', token, gueltig, body: post ? body : null, hash: gueltig ? freigabe.tokenHash(crypto, token) : '__ungueltig__' } }];
`);
	const linkLesen = wf.tabelle('Link lesen', [440, 0], 'get', 'epa_erledigt_links', { bedingungen: [['token_hash', 'eq', '={{ $json.hash }}']] }, { alwaysOutputData: true });
	const kundeLesen = wf.tabelle('Kunde lesen', [660, 0], 'get', 'epa_config_allgemein', { bedingungen: [['kunde_id', 'eq', "={{ $json.kunde_id || '__kein_kunde__' }}"]] }, { alwaysOutputData: true });
	const vorgangLesen = wf.tabelle('Vorgang lesen', [880, 0], 'get', 'epa_vorgaenge', {
		bedingungen: [
			['vorgangs_id', 'eq', "={{ $('Link lesen').first().json.vorgangs_id || '__keine__' }}"],
			['kunde_id', 'eq', "={{ $('Link lesen').first().json.kunde_id || '__kein_kunde__' }}"],
		],
	}, { alwaysOutputData: true });

	const pruefen = wf.code('Prüfen', [1100, 0], ['erledigt', 'freigabe'], `
const a = $('Anfrage lesen').first().json;
const da = (n) => { const j = $(n).first().json; return j && j.id !== undefined ? j : null; };
const l = da('Link lesen');
const kunde = da('Kunde lesen');
const v = da('Vorgang lesen');
const TITEL = { 400: 'Eingabe unvollständig', 404: 'Link ungültig', 409: 'Bereits erledigt', 410: 'Link abgelaufen' };
const antwort = (status, text) => [{ json: { weg: 'antworten', status, html: freigabe.seiteMeldung(TITEL[status] || 'Hinweis', text, 'fehler') } }];
if (!a.gueltig) return antwort(404, 'Dieser Link ist ungültig.');
const p = erledigt.linkPruefen(l, v, new Date().toISOString());
if (!p.ok) return antwort(p.status, p.meldung);
if (!kunde) return antwort(404, 'Der Kunde ist nicht mehr eingerichtet.');
const auswahl = erledigt.personen(kunde);
if (a.methode === 'GET') return [{ json: { weg: 'antworten', status: 200, html: erledigt.seiteFormular(freigabe.seite, { token: a.token, vorgang: v, auswahl }) } }];
if (!freigabe.istGueltigesToken(a.body && a.body.t) || String(a.body.aktion || '') !== 'erledigt') return antwort(400, 'Ungültige Anfrage. Bitte über den Link erneut öffnen.');
const w = erledigt.werPruefen(a.body.wer, auswahl);
if (!w.ok) return antwort(400, w.meldung + ' Bitte über den Link erneut öffnen.');
let teams = null;
try { const t = JSON.parse(l.teams_nachricht || 'null'); if (t && t.team_id && t.channel_id && t.id) teams = t; } catch (e) { teams = null; }
return [{ json: { weg: 'erledigt', link_id: l.id, kunde_id: l.kunde_id, vorgangs_id: l.vorgangs_id, wer: w.wer, postfach: kunde.postfach, postfach_workflow_id: kunde.postfach_workflow_id, teams } }];
`);
	const weiche = wf.node('Weiter', 'n8n-nodes-base.switch', [1320, 0], {
		mode: 'rules',
		rules: {
			values: ['antworten', 'erledigt'].map((w) => ({
				conditions: bedingungen([bedingung('={{ $json.weg }}', { type: 'string', operation: 'equals' }, w)]),
				renameOutput: true,
				outputKey: w,
			})),
		},
		options: {},
	});

	// ---------------------------------------------------------------- Abschließen
	const verbrauchDaten = wf.code('Link verbrauchen (Daten)', [1540, 220], [], `
return [{ json: { verbraucht_am: new Date().toISOString() } }];
`);
	const verbrauchen = wf.tabelle('Link verbrauchen', [1760, 220], 'update', 'epa_erledigt_links', {
		bedingungen: [['id', 'eq', `={{ ${P}.link_id }}`], ['verbraucht_am', 'isEmpty']],
	}, { alwaysOutputData: true });
	const ok = wf.node('Übernommen?', 'n8n-nodes-base.if', [1980, 220], { conditions: existiert("={{ $('Link verbrauchen').first().json.id }}"), options: { looseTypeValidation: true } });
	const bereits = wf.code('Seite: bereits erledigt', [2200, 380], ['freigabe'], `
return [{ json: { status: 409, html: freigabe.seiteMeldung('Bereits erledigt', 'Dieser Vorgang wurde gerade schon als erledigt gemeldet (anderes Fenster oder Kollege). Es wurde nichts doppelt gespeichert.', 'fehler') } }];
`);
	const status = wf.aufruf('Status: Abgeschlossen', [2200, 220], 'EPA SW Status setzen', [
		['kunde_id', 'string', `={{ ${P}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['neuer_status', 'string', 'Abgeschlossen'],
		['ausloeser', 'string', `={{ 'Mitarbeiter:' + ${P}.wer }}`],
		['details', 'object', "={{ { grund: 'Auftrag bearbeitet (Knopf Erledigt in Teams)' } }}"],
		['referenz', 'string', `={{ 'erledigt:' + ${P}.link_id }}`],
		['erwartete_version', 'number', '={{ null }}'],
		['nur_wenn_erlaubt', 'boolean', '={{ false }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const karteFrage = wf.node('Karte bekannt?', 'n8n-nodes-base.if', [2420, 220], {
		conditions: bedingungen([bedingung(`={{ Boolean($('Status: Abgeschlossen').first().json.ok === true && ${P}.teams) }}`, { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const karteWeg = wf.aufrufDynamisch('Karte entfernen', [2640, 140], `={{ ${P}.postfach_workflow_id }}`, [
		['aktion', 'string', 'teams_kanal_loeschen'],
		['postfach', 'string', `={{ ${P}.postfach }}`],
		['graph_id', 'string', `={{ ${P}.teams.id }}`],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['team_id', 'string', `={{ ${P}.teams.team_id }}`],
		['channel_id', 'string', `={{ ${P}.teams.channel_id }}`],
	], { onError: 'continueRegularOutput', alwaysOutputData: true });
	const seite = wf.code('Seite: erledigt', [2860, 220], ['freigabe'], `
const s = $('Status: Abgeschlossen').first().json || {};
const p = $('Prüfen').first().json;
const k = $('Karte entfernen').isExecuted ? ($('Karte entfernen').first().json || {}) : {};
if (s.ok !== true) return [{ json: { status: 500, html: freigabe.seiteMeldung('Nicht abgeschlossen', 'Der Vorgang ' + p.vorgangs_id + ' konnte nicht abgeschlossen werden. Bitte später erneut versuchen oder die Entwicklung informieren.', 'fehler') } }];
const karte = k.geloescht === true ? 'Die Karte wurde aus „Vollständige Anfragen“ entfernt.' : 'Die Karte in „Vollständige Anfragen“ konnte nicht automatisch entfernt werden, bitte dort ausblenden.';
return [{ json: { status: 200, html: freigabe.seiteMeldung('Erledigt', 'Vorgang ' + p.vorgangs_id + ' ist abgeschlossen. ' + karte + ' Die Abschlusskarte steht in „Logs“.', 'ok') } }];
`);

	const antwort = wf.node('Seite ausliefern', 'n8n-nodes-base.respondToWebhook', [3080, 0], {
		respondWith: 'text',
		responseBody: '={{ $json.html }}',
		options: { responseCode: '={{ $json.status }}', responseHeaders: SEITE_HEADER },
	});

	wf.verbinde(hook, lesen, 0);
	wf.verbinde(hook, lesen, 1);
	wf.kette(lesen, linkLesen, kundeLesen, vorgangLesen, pruefen, weiche);
	wf.verbinde(weiche, antwort, 0);
	wf.verbinde(weiche, verbrauchDaten, 1);
	wf.kette(verbrauchDaten, verbrauchen, ok);
	wf.verbinde(ok, status, 0);
	wf.verbinde(ok, bereits, 1);
	wf.kette(bereits, antwort);
	wf.kette(status, karteFrage);
	wf.verbinde(karteFrage, karteWeg, 0);
	wf.verbinde(karteFrage, seite, 1);
	wf.kette(karteWeg, seite, antwort);
	return wf;
};
