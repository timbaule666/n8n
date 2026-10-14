#!/usr/bin/env node
'use strict';
// End-to-End-Test M2 (EPA-01 Eingang) in einer LOKALEN n8n-Instanz mit Mock-LLM und Mock-Graph.
// - legt einen eigenen Testkunden "epa-e2e" an (Config, Pflichtfelder) und räumt dessen Daten vorher auf
// - spielt alle Workflows ein (tools/deploy.js), weist lokale Test-Credentials zu und veröffentlicht
// - erzeugt eine Kopie von EPA-00 ohne Outlook-Trigger, deren Graph-Aufrufe auf den Mock zeigen
// - führt alle Fälle aus test/daten/testmails.js aus und schreibt docs/Testprotokoll-M2.md
//
// Aufruf: N8N_URL=http://127.0.0.1:5678 N8N_API_KEY=… EPA_E2E_CREDS=pfad/creds.json node tools/e2e-eingang.js [--nur=T01,T02]
// creds.json: { "openAiApi": { "id", "name" }, "microsoftTeamsOAuth2Api": { "id", "name" } } (Test-Credentials der lokalen Instanz)
// Läuft nur gegen localhost (der Mock lauscht auf 127.0.0.1).
const fs = require('node:fs');
const path = require('node:path');
const { Workflow, ROOT } = require('./lib/n8n');
const { mockServer } = require('./lib/mock-server');
const { einrichten, alleTabellen, alleZeilen, api } = require('./datatables-setup');
const { deploy } = require('./deploy');
const { bauen } = require('./build-workflows');
const { POSTFACH, FAELLE } = require('../test/daten/testmails');
const { freigabeSzenarien } = require('./lib/e2e-freigabe');
const { antwortSzenarien } = require('./lib/e2e-antwort');
const { nachfassSzenarien } = require('./lib/e2e-nachfassen');

const BASIS = (process.env.N8N_URL || '').replace(/\/+$/, '');
const KEY = process.env.N8N_API_KEY;
const KUNDE = 'epa-e2e';
const TEAM = '61165b04-e4cc-4026-b43f-926b4e2a7182';
const KANAL = '19:e2e@thread.tacv2';
const FREIGEBER = ['freigabe@spedition.example', 'chef@spedition.example'];

const warte = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function entfernen(id) {
	await api('POST', `/workflows/${id}/deactivate`).catch(() => {});
	for (let v = 1; ; v++) {
		try {
			return await api('DELETE', `/workflows/${id}`);
		} catch (e) {
			if (v >= 20 || !/409/.test(e.message)) throw e;
			await warte(500);
		}
	}
}

async function zeilenLoeschen(tabellenId, spalte, wert) {
	const filter = JSON.stringify({ type: 'and', filters: [{ columnName: spalte, condition: 'eq', value: wert }] });
	await api('DELETE', `/data-tables/${tabellenId}/rows/delete?filter=${encodeURIComponent(filter)}`).catch((e) => {
		if (!/404/.test(e.message)) throw e;
	});
}

async function testkundeAnlegen(ids, mockPort, postfachWorkflowId) {
	for (const t of ['epa_config_allgemein', 'epa_config_pflichtfelder', 'epa_vorgaenge', 'epa_audit_log', 'epa_verarbeitete_mails', 'epa_freigaben', 'epa_freigabe_tokens', 'epa_fehler_log']) {
		await zeilenLoeschen(ids[t], 'kunde_id', KUNDE);
	}
	const daten = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'datatables', 'beispiel-transport.json'), 'utf8'));
	const allg = { ...daten.epa_config_allgemein[0] };
	const profil = JSON.parse(allg.llm_profil);
	for (const a of Object.values(profil)) {
		a.basis_url = `http://127.0.0.1:${mockPort}/v1`;
		a.timeout_ms = 20000;
	}
	Object.assign(allg, {
		kunde_id: KUNDE,
		postfach: POSTFACH,
		freigeber: JSON.stringify(FREIGEBER),
		postfach_workflow_id: postfachWorkflowId,
		benachrichtigung: JSON.stringify({ kanal: 'teams', team_id: TEAM, channel_id: KANAL }),
		llm_profil: JSON.stringify(profil),
		absender_blocklist: JSON.stringify(['spam@werbung.example']),
		absender_allowlist: JSON.stringify(['@stammkunde.example']),
		signatur: allg.signatur.replace('<TELEFON>', '0221 000000'),
	});
	await api('POST', `/data-tables/${ids.epa_config_allgemein}/rows`, { data: [allg], returnType: 'count' });
	await api('POST', `/data-tables/${ids.epa_config_pflichtfelder}/rows`, { data: daten.epa_config_pflichtfelder.map((f) => ({ ...f, kunde_id: KUNDE })), returnType: 'count' });
}

/** Weist lokalen Test-Credentials allen EPA-Nodes ohne Credential zu (simuliert die Zuweisung in der Oberfläche). */
async function credentialsZuweisen(creds) {
	const { data } = await api('GET', '/workflows?limit=250');
	for (const w of data.filter((x) => x.name.startsWith('EPA') && !x.name.startsWith('EPA-TEST') && !x.name.startsWith('EPA-00'))) {
		const wf = await api('GET', `/workflows/${w.id}`);
		let geaendert = false;
		for (const n of wf.nodes) {
			if (n.credentials) continue;
			if (n.type === 'n8n-nodes-base.microsoftTeams') {
				n.credentials = { microsoftTeamsOAuth2Api: creds.microsoftTeamsOAuth2Api };
				if (/^<.*>$/.test(String(n.parameters.teamId.value))) {
					n.parameters.teamId.value = TEAM;
					n.parameters.channelId.value = KANAL;
				}
				geaendert = true;
			}
			if (n.type === 'n8n-nodes-base.httpRequest' && n.parameters.nodeCredentialType === 'openAiApi') {
				n.credentials = { openAiApi: creds.openAiApi };
				geaendert = true;
			}
			if (n.type === 'n8n-nodes-base.httpRequest' && n.parameters.nodeCredentialType === 'microsoftTeamsOAuth2Api') {
				n.credentials = { microsoftTeamsOAuth2Api: creds.microsoftTeamsOAuth2Api };
				geaendert = true;
			}
		}
		if (geaendert) await api('PUT', `/workflows/${w.id}`, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
	}
}

function harness(name, slug, zielId, zielName, eingaben) {
	const wf = new Workflow(name);
	const hook = wf.node('Testaufruf', 'n8n-nodes-base.webhook', [0, 0], {
		httpMethod: 'POST', path: `epa-test-${slug}`, responseMode: 'lastNode', responseData: 'firstEntryJson', options: {},
	}, { webhookId: `epa-test-${slug}` });
	const aufruf = wf.aufruf('Workflow aufrufen', [240, 0], zielName, eingaben.map(([n, t]) => [n, t, `={{ $json.body.${n} }}`]));
	wf.verbinde(hook, aufruf);
	const json = wf.json();
	json.nodes.find((n) => n.name === 'Workflow aufrufen').parameters.workflowId.value = zielId;
	return { name: json.name, nodes: json.nodes, connections: json.connections, settings: { executionOrder: 'v1' } };
}

/** EPA-00 ohne Outlook-Trigger, Graph auf den Mock umgeleitet, ohne Credentials. */
function postfachKopie(ids, mockPort, errorWorkflow) {
	const quelle = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', 'EPA-00_Postfach_Vorlage.json'), 'utf8'));
	const raus = new Set(['Neue Mail im Posteingang', 'Postfach festlegen', 'Jede Mail einzeln verarbeiten']);
	const nodes = quelle.nodes.filter((n) => !raus.has(n.name)).map((n) => {
		const k = JSON.parse(JSON.stringify(n));
		if (k.type === 'n8n-nodes-base.code') k.parameters.jsCode = k.parameters.jsCode.split('https://graph.microsoft.com/v1.0').join(`http://127.0.0.1:${mockPort}/graph/v1.0`);
		if (k.type === 'n8n-nodes-base.httpRequest') {
			k.parameters.url = k.parameters.url.split('https://graph.microsoft.com/v1.0').join(`http://127.0.0.1:${mockPort}/graph/v1.0`);
			k.parameters.authentication = 'none';
			delete k.parameters.nodeCredentialType;
		}
		if (k.type === 'n8n-nodes-base.executeWorkflow') {
			const ziel = k.parameters.workflowId.cachedResultName;
			k.parameters.workflowId = { __rl: true, mode: 'list', value: ids[ziel], cachedResultName: ziel };
		}
		return k;
	});
	const connections = Object.fromEntries(Object.entries(quelle.connections).filter(([v]) => !raus.has(v)));
	return { name: 'EPA-TEST Postfach (Mock-Graph)', nodes, connections, settings: { executionOrder: 'v1', errorWorkflow } };
}

/** Lokal: Graph-Aufrufe von "EPA SW Freigabe senden" auf den Mock umleiten (Teams-Chats). */
async function freigabeSendenUmleiten(id, mockPort) {
	const wf = await api('GET', `/workflows/${id}`);
	for (const n of wf.nodes) {
		if (n.type !== 'n8n-nodes-base.httpRequest') continue;
		n.parameters.url = String(n.parameters.url).split('https://graph.microsoft.com/v1.0').join(`http://127.0.0.1:${mockPort}/graph/v1.0`);
		n.parameters.authentication = 'none';
		delete n.parameters.nodeCredentialType;
		delete n.credentials;
	}
	await api('PUT', `/workflows/${id}`, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
	await api('POST', `/workflows/${id}/activate`);
}

async function zeitplanAus(id) {
	const wf = await api('GET', `/workflows/${id}`);
	for (const n of wf.nodes) if (n.type === 'n8n-nodes-base.scheduleTrigger') n.disabled = true;
	await api('PUT', `/workflows/${id}`, { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings });
	await api('POST', `/workflows/${id}/activate`);
}

async function aufrufen(slug, body) {
	const res = await fetch(`${BASIS}/webhook/epa-test-${slug}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = { roh: text };
	}
	return { status: res.status, json };
}

function vergleich(liste) {
	return [...(liste || [])].sort().join(', ') || '–';
}

async function main() {
	if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASIS)) throw new Error('Nur gegen eine lokale n8n-Instanz (N8N_URL=http://127.0.0.1:5678)');
	if (!KEY || !process.env.EPA_E2E_CREDS) throw new Error('N8N_API_KEY und EPA_E2E_CREDS setzen');
	const creds = JSON.parse(fs.readFileSync(process.env.EPA_E2E_CREDS, 'utf8'));
	const nur = (process.argv.find((a) => a.startsWith('--nur=')) || '').slice(6).split(',').filter(Boolean);

	const mock = mockServer();
	const port = await mock.starten();
	console.log(`Mock (OpenAI + Graph) auf Port ${port}`);
	const temp = [];
	const zeilen = [];
	const zeilenM3 = [];
	const zeilenM4 = [];
	const zeilenM5 = [];
	try {
		bauen();
		const ids = await einrichten({ prompts: true, log: () => {} });

		const leise = () => {};
		await deploy({ basis: BASIS, schluessel: KEY, log: leise });
		await credentialsZuweisen(creds);
		const wfIds = await deploy({ basis: BASIS, schluessel: KEY, log: (z) => /NICHT|FEHLER/.test(z) && !/EPA-00/.test(z) && console.log(z) });

		const kopie = await api('POST', '/workflows', postfachKopie(wfIds, port, wfIds['EPA-05 Error-Handler']));
		temp.push(kopie.id);
		await api('POST', `/workflows/${kopie.id}/activate`);
		await freigabeSendenUmleiten(wfIds['EPA SW Freigabe senden'], port);
		await testkundeAnlegen(ids, port, kopie.id);
		const h1 = await api('POST', '/workflows', harness('EPA-TEST Eingang', 'eingang', wfIds['EPA-01 Eingang verarbeiten'], 'EPA-01 Eingang verarbeiten', [['postfach', 'string'], ['mail', 'object'], ['anhaenge', 'array']]));
		const h2 = await api('POST', '/workflows', harness('EPA-TEST Postfach', 'postfach', kopie.id, 'EPA-TEST Postfach (Mock-Graph)', [['postfach', 'string'], ['graph_id', 'string']]));
		const h3 = await api('POST', '/workflows', harness('EPA-TEST Rückfrage', 'rueckfrage', wfIds['EPA-02 Rückfrage anfordern'], 'EPA-02 Rückfrage anfordern', [['kunde_id', 'string'], ['vorgangs_id', 'string'], ['art', 'string'], ['referenz', 'string']]));
		// EPA-04 lokal ohne Zeitplan (sonst würde der stündliche Lauf in die Tests greifen); Aufruf nur über den Test-Harness.
		await zeitplanAus(wfIds['EPA-04 Nachfassen und Eskalation']);
		const h4 = await api('POST', '/workflows', harness('EPA-TEST Nachfassen', 'nachfassen', wfIds['EPA-04 Nachfassen und Eskalation'], 'EPA-04 Nachfassen und Eskalation', [['jetzt', 'string']]));
		temp.push(h1.id, h2.id, h3.id, h4.id);
		for (const h of [h1, h2, h3, h4]) await api('POST', `/workflows/${h.id}/activate`);
		await warte(1000);

		const tabelle = async (name) => alleZeilen(ids[name]);
		const vorgangZurMail = async (messageId) => (await tabelle('epa_vorgaenge')).find((v) => v.kunde_id === KUNDE && JSON.parse(v.bekannte_message_ids || '[]').includes(messageId)) || null;
		const gesendet = {}; // id -> { mail, ergebnis, vorgang }

		for (const fall of FAELLE) {
			if (nur.length && !nur.includes(fall.id) && !nur.includes('T')) continue;
			const basisMail = fall.wiederholung ? gesendet[fall.wiederholung].mail : JSON.parse(JSON.stringify(fall.mail));
			if (fall.bezug) {
				const b = gesendet[fall.bezug].mail;
				basisMail.conversationId = b.conversationId;
				basisMail.internetMessageHeaders.push({ name: 'In-Reply-To', value: b.internetMessageId }, { name: 'References', value: b.internetMessageId });
			}
			mock.fall(fall.llm);
			const fehlerVorher = Math.max(0, ...(await tabelle('epa_fehler_log')).map((z) => z.id));
			let antwort;
			if (fall.modus === 'graph') {
				mock.zustand.graphMails.set(basisMail.id, { mail: { ...basisMail, hasAttachments: true }, anhaenge: (fall.anhaenge || []).map((a, i) => ({ ...a, id: `att-${fall.id}-${i}` })) });
				antwort = await aufrufen('postfach', { postfach: POSTFACH, graph_id: basisMail.id });
			} else {
				// auch im Mock-Postfach ablegen, damit EPA-02 einen Antwortentwurf im Thread anlegen kann
				mock.zustand.graphMails.set(basisMail.id, { mail: basisMail, anhaenge: [] });
				antwort = await aufrufen('eingang', { postfach: POSTFACH, mail: basisMail, anhaenge: [] });
			}
			await warte(fall.erwartet.fehler ? 4000 : 300);
			const e = fall.erwartet;
			const r = antwort.json || {};
			const vorgang = r.vorgangs_id ? (await tabelle('epa_vorgaenge')).find((v) => v.vorgangs_id === r.vorgangs_id) : await vorgangZurMail(basisMail.internetMessageId);
			gesendet[fall.id] = { mail: basisMail, ergebnis: r, vorgang };
			const anfragen = mock.zustand.llmAnfragen;
			const zahl = (a) => anfragen.filter((x) => x.aufgabe === a).length;
			const pruef = [];
			const soll = [];
			const ist = [];
			const check = (name, erwartet, tatsaechlich) => {
				soll.push(`${name}: ${erwartet}`);
				ist.push(`${name}: ${tatsaechlich}`);
				pruef.push(String(erwartet) === String(tatsaechlich));
			};
			if (e.ergebnis) check('Ergebnis', e.ergebnis, r.ergebnis);
			if (e.status) check('Status', e.status, vorgang ? vorgang.status : '(kein Vorgang)');
			if (e.fehlende) check('Lücken', vergleich(e.fehlende), vergleich(vorgang ? JSON.parse(vorgang.fehlende_felder || '[]').map((f) => f.feldname) : null));
			if (e.archivieren !== undefined) check('Archivieren', e.archivieren, r.archivieren === true);
			if (e.llm) check('LLM-Aufrufe K/E', `${e.llm.klassifizierung}/${e.llm.extraktion}`, `${zahl('klassifizierung')}/${zahl('extraktion')}`);
			if (e.keinVorgang) check('Vorgang angelegt', 'nein', vorgang ? 'ja' : 'nein');
			if (e.gleicherVorgangWie) check('Vorgang', gesendet[e.gleicherVorgangWie].vorgang?.vorgangs_id, vorgang?.vorgangs_id || r.vorgangs_id);
			if (e.hinweisImPrompt) check('Hinweis an KI', e.hinweisImPrompt, anfragen.some((a) => JSON.stringify(a.body).includes(e.hinweisImPrompt)) ? e.hinweisImPrompt : 'fehlt');
			if (e.imPrompt) check('Anhangtext an KI', 'ja', anfragen.some((a) => a.aufgabe === 'extraktion' && JSON.stringify(a.body).includes(e.imPrompt)) ? 'ja' : 'nein');
			if (e.nichtImPrompt) check('Zitat entfernt', 'ja', anfragen.every((a) => !JSON.stringify(a.body).includes(e.nichtImPrompt)) ? 'ja' : 'nein');
			if (e.bildImPrompt) check('Bild an KI', 'ja', anfragen.some((a) => a.aufgabe === 'extraktion' && JSON.stringify(a.body).includes('data:image/png;base64,')) ? 'ja' : 'nein');
			if (e.textGekuerzt) {
				const u = anfragen.find((a) => a.aufgabe === 'klassifizierung');
				const laenge = u ? JSON.stringify(u.body.messages[1].content).length : 0;
				check('Text gekürzt', 'ja', laenge > 0 && laenge < 20000 && JSON.stringify(u.body).includes('[… gekürzt]') ? 'ja' : `nein (${laenge})`);
			}
			if (e.datenblockDicht) {
				const u = anfragen.find((a) => a.aufgabe === 'klassifizierung');
				const t = u ? u.body.messages[1].content : '';
				check('Datenblock nicht verlassbar', 1, (String(t).match(/<\/mail_daten>/g) || []).length);
			}
			if (e.manipulation) {
				const audit = (await tabelle('epa_audit_log')).filter((a) => a.vorgangs_id === vorgang?.vorgangs_id);
				check('Manipulationsverdacht im Audit', 'ja', audit.some((a) => JSON.parse(a.details || '{}').verdacht_manipulation === true) ? 'ja' : 'nein');
			}
			if (e.spoofing) check('Spoofing-Hinweis', 'ja', vorgang && vorgang.spoofing_hinweis ? 'ja' : 'nein');
			if (e.anhangHinweise) {
				const req = anfragen.find((a) => a.aufgabe === 'extraktion');
				const text = req ? JSON.stringify(req.body) : '';
				check('Anhang-Hinweise an KI', vergleich(e.anhangHinweise), vergleich(e.anhangHinweise.filter((n) => new RegExp(`Anhang \\\\"${n.replace('.', '\\.')}\\\\" nicht auswertbar`).test(text))));
			}
			if (e.verschoben) check('In Archiv verschoben', 'ordner-archiv', mock.zustand.verschoben[0]?.ziel || 'nein');
			if (e.fehler) {
				const neu = (await tabelle('epa_fehler_log')).filter((z) => z.id > fehlerVorher && z.fehlercode === e.fehler.fehlercode);
				check('Fehlerlog', `${e.fehler.statuscode} ${e.fehler.fehlercode}`, neu.length ? `${neu[0].statuscode} ${neu[0].fehlercode}` : `keiner (HTTP ${antwort.status})`);
				const claim = (await tabelle('epa_verarbeitete_mails')).filter((c) => c.kunde_id === KUNDE && c.message_id === basisMail.internetMessageId);
				check('Fehlerlog-Einträge (kein Doppelalarm)', 1, (await tabelle('epa_fehler_log')).filter((z) => z.id > fehlerVorher && z.node !== 'Teams-Nachricht senden').length);
				check('Eingang freigegeben', 'fehler', claim.map((c) => c.status).join('/'));
				check('Fehlerlog ohne Mailinhalt', 'ja', neu.every((z) => !String(z.meldung).includes(basisMail.subject)) ? 'ja' : 'nein');
			}
			if (anfragen.length) check('LLM mit Credential', 'ja', anfragen.every((a) => a.auth) ? 'ja' : 'nein');
			const ok = pruef.every(Boolean);
			zeilen.push({ id: fall.id, szenario: fall.szenario, soll: soll.join('; '), ist: ist.join('; '), ok });
			console.log(`${ok ? 'ok    ' : 'FEHLER'} ${fall.id} ${fall.szenario}${ok ? '' : `\n       soll: ${soll.join('; ')}\n       ist:  ${ist.join('; ')}`}`);
		}

		// M3: Rückfrage und Freigabe
		const freigabeZeilen = (!nur.length || nur.some((n) => /^F/.test(n)))
			? await freigabeSzenarien({ mock, aufrufen, tabelle, api, ids, KUNDE, POSTFACH, FREIGEBER, nur: nur.filter((n) => /^F/.test(n)) })
			: [];
		zeilenM3.push(...freigabeZeilen);
		// M4: Antworten des Kunden (Phase D)
		if (!nur.length || nur.some((n) => /^A/.test(n))) {
			zeilenM4.push(...await antwortSzenarien({ mock, aufrufen, tabelle, api, ids, KUNDE, POSTFACH, FREIGEBER, nur: nur.filter((n) => /^A/.test(n)) }));
		}

		// M5: Nachfassen und Eskalation (Phase E)
		if (!nur.length || nur.some((n) => /^N/.test(n))) {
			zeilenM5.push(...await nachfassSzenarien({ mock, aufrufen, tabelle, api, ids, KUNDE, POSTFACH, FREIGEBER, nur: nur.filter((n) => /^N/.test(n)) }));
		}

		// Teams-Versandfehler werden protokolliert (lokal gibt es nur ein Dummy-Credential)
		const teamsFehler = (await tabelle('epa_fehler_log')).filter((z) => z.kunde_id === KUNDE && z.node === 'Teams-Nachricht senden');
		console.log(`\nHinweis: ${teamsFehler.length} Teams-Meldungen konnten lokal nicht zugestellt werden (Dummy-Credential) und stehen als 502 im Fehlerlog.`);
	} finally {
		if (process.env.EPA_E2E_BEHALTEN) temp.length = 0;
		for (const id of temp) await entfernen(id).catch((e) => console.error('Aufräumen:', e.message));
		await mock.stoppen();
	}
	const alle = [...zeilen, ...zeilenM3, ...zeilenM4, ...zeilenM5];
	const bestanden = alle.filter((z) => z.ok).length;
	console.log(`\nM2: ${zeilen.filter((z) => z.ok).length}/${zeilen.length}, M3: ${zeilenM3.filter((z) => z.ok).length}/${zeilenM3.length}, M4: ${zeilenM4.filter((z) => z.ok).length}/${zeilenM4.length}, M5: ${zeilenM5.filter((z) => z.ok).length}/${zeilenM5.length} – gesamt ${bestanden}/${alle.length} Szenarien bestanden`);
	if (!nur.length) {
		protokoll(zeilen, 'M2', 'Eingang (EPA-00/EPA-01)', 'Testprotokoll-M2.md');
		protokoll(zeilenM3, 'M3', 'Rückfrage und Freigabe (EPA-02/EPA-07)', 'Testprotokoll-M3.md');
		protokoll(zeilenM4, 'M4', 'Antworten verarbeiten (EPA-03)', 'Testprotokoll-M4.md');
		protokoll(zeilenM5, 'M5', 'Nachfassen und Eskalation (EPA-04)', 'Testprotokoll-M5.md');
	}
	process.exit(bestanden === alle.length ? 0 : 1);
}

function protokoll(zeilen, m, titel, datei) {
	const esc = (s) => String(s).replace(/\|/g, '\\|');
	const md = [
		`# Testprotokoll ${m}: ${titel}`,
		'',
		`Stand ${new Date().toISOString().slice(0, 10)}. Lokale n8n-Instanz 2.43.4, Data Tables, Mock-LLM (skriptgesteuert) und Mock-Graph.`,
		'Erzeugt von `tools/e2e-eingang.js` aus `test/daten/testmails.js`.',
		'',
		'Das Mock-LLM liefert festgelegte Antworten, der Mock-Graph simuliert Postfach (Entwürfe, Versand, Gesendete Elemente) und Teams-Chats. Geprüft wird damit die Verarbeitungskette, **nicht** die Qualität des echten Modells und nicht das Verhalten der echten Microsoft-APIs. Die Gegenprobe erfolgt in der Cloud-Instanz.',
		'',
		'| Nr. | Szenario | erwartet | tatsächlich | bestanden |',
		'|---|---|---|---|---|',
		...zeilen.map((z) => `| ${z.id} | ${esc(z.szenario)} | ${esc(z.soll)} | ${esc(z.ist)} | ${z.ok ? 'ja' : '**nein**'} |`),
		'',
		`**Ergebnis:** ${zeilen.filter((z) => z.ok).length} von ${zeilen.length} Szenarien bestanden.`,
		'',
	].join('\n');
	fs.writeFileSync(path.join(ROOT, 'docs', datei), md);
}

main().catch((e) => {
	console.error(e.stack || e.message);
	process.exit(1);
});
