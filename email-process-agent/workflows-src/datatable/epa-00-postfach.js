'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAIL_FELDER = [
	'id', 'internetMessageId', 'conversationId', 'subject', 'body', 'bodyPreview', 'from', 'sender', 'replyTo', 'toRecipients',
	'ccRecipients', 'receivedDateTime', 'hasAttachments', 'internetMessageHeaders', 'webLink',
].join(',');
// Technische Obergrenze für das Herunterladen; die fachlichen Limits je Kunde prüft EPA-01 (anhang_limits).
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
// Eigene Mail-Eigenschaft (Extended Property, PS_PUBLIC_STRINGS) zur Wiedererkennung gesendeter Rückfragen.
const PROP_FREIGABE = 'String {00020329-0000-0000-C000-000000000046} Name EPA-Freigabe-ID';
const AKTIONEN = ['eingang', 'entwurf_anlegen', 'entwurf_aktualisieren', 'entwurf_senden', 'verbindung_pruefen', 'entwurf_loeschen'];
const E = "$('Bei Einzelaufruf').first().json";
const P = `{{ encodeURIComponent(${E}.postfach) }}`;

function graph(wf, name, pos, methode, url, extra = {}, optionen = {}) {
	const p = {
		method: methode,
		url,
		authentication: 'predefinedCredentialType',
		nodeCredentialType: 'microsoftOutlookOAuth2Api',
		options: optionen,
	};
	if (extra.query) {
		// Query-Parameter über die Node-Option, damit OData-Filter korrekt kodiert werden
		p.sendQuery = true;
		p.specifyQuery = 'keypair';
		p.queryParameters = { parameters: Object.entries(extra.query).map(([name, value]) => ({ name, value })) };
	}
	if (extra.body) {
		p.sendBody = true;
		p.specifyBody = 'json';
		p.jsonBody = extra.body;
	}
	return wf.node(name, 'n8n-nodes-base.httpRequest', pos, p, { ...Workflow.retry(), ...(extra.node || {}) });
}

module.exports = function () {
	const wf = new Workflow('EPA-00 Postfach (Vorlage)');

	wf.notiz('Notiz Zweck', [-120, -620], [
		'## EPA-00 Postfach (Vorlage, je Postfach eine Kopie)',
		'**Zweck:** Holt neue Mails aus dem Posteingang (Polling, Bauplan 5.1), lädt Header und Anhänge über Microsoft Graph, liest PDF-Text und bereitet Bilder für die KI auf und übergibt alles an "EPA-01 Eingang verarbeiten". Aussortierte Mails (Newsletter, Auto-Replies, Blockliste) werden danach in den Archivordner verschoben, nie gelöscht.',
		'**Trigger:** Microsoft Outlook Trigger (jede Minute, nur Posteingang). Jede Mail wird als eigene Ausführung dieses Workflows verarbeitet (Aufruf von sich selbst), damit ein Fehler nur diese eine Mail betrifft.',
		'**Einrichten:** 1) Workflow duplizieren und umbenennen (z. B. "EPA-00 Postfach anfragen@kunde.de"). 2) Im Node "Postfach festlegen" die Adresse eintragen (muss in epa_config_allgemein.postfach stehen). 3) Outlook-Credential (Microsoft Outlook OAuth2, bei Shared Mailbox mit "Use Shared Mailbox") im Trigger und in allen Graph-Nodes zuweisen. 4) Archivordner (Config: archivordner) als Ordner auf oberster Ebene im Postfach anlegen. 5) Veröffentlichen.',
		'**Postfach-Aktionen (für EPA-02/EPA-07):** entwurf_anlegen (Antwort im Thread, Betreff mit Vorgangs-ID, Freigabe-ID als Extended Property), entwurf_aktualisieren, entwurf_senden (prüft vorher, ob der Entwurf noch existiert; sonst Suche in Gesendete Elemente: kein Doppelversand). Ab M6: verbindung_pruefen (Watchdog: Posteingang lesbar?) und entwurf_loeschen (Löschjob: nur ersetzte Entwürfe mit passender Freigabe-Kennung). Die ID dieser Kopie gehört in epa_config_allgemein.postfach_workflow_id.',
		'**Hinweis:** Der Trigger liefert nur die Message-ID; Header (In-Reply-To, References, Auto-Submitted, Authentication-Results) holt "Mail laden", weil der Trigger sie nicht ausgibt.',
	].join('\n'), { breite: 900, hoehe: 380 });

	// ---------------------------------------------------------------- Polling
	const trigger = wf.node('Neue Mail im Posteingang', 'n8n-nodes-base.microsoftOutlookTrigger', [0, 0], {
		pollTimes: { item: [{ mode: 'everyMinute' }] },
		authentication: 'microsoftOutlookOAuth2Api',
		event: 'messageReceived',
		output: 'fields',
		fields: ['receivedDateTime'], // Graph liefert die id immer mit; 'id' ist hier kein zulässiger Wert
		filters: { foldersToInclude: ['inbox'], readStatus: 'both' },
		options: {},
	});
	const festlegen = wf.code('Postfach festlegen', [220, 0], [], `
// Adresse des überwachten Postfachs (muss mit epa_config_allgemein.postfach übereinstimmen).
const POSTFACH = '<postfach@ihre-domain.de>';
if (!/^[^@<>\\s]+@[^@<>\\s]+\\.[A-Za-z]{2,}$/.test(POSTFACH)) throw new Error('[EPA:424:KONFIGURATIONSFEHLER:-] Im Node "Postfach festlegen" ist keine gültige Postfach-Adresse eingetragen');
return $input.all().filter((i) => i.json.id).map((i) => ({ json: { postfach: POSTFACH.toLowerCase(), graph_id: i.json.id } }));
`);
	const einzeln = wf.node('Jede Mail einzeln verarbeiten', 'n8n-nodes-base.executeWorkflow', [440, 0], {
		workflowId: { __rl: true, mode: 'id', value: '={{ $workflow.id }}' },
		workflowInputs: {
			mappingMode: 'defineBelow',
			value: { aktion: 'eingang', postfach: '={{ $json.postfach }}', graph_id: '={{ $json.graph_id }}' },
			matchingColumns: [],
			schema: ['aktion', 'postfach', 'graph_id'].map((n) => ({ id: n, displayName: n, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false })),
			attemptToConvertTypes: false,
			convertFieldsToString: false,
		},
		mode: 'each',
		options: { waitForSubWorkflow: true },
	}, { onError: 'continueRegularOutput' });

	// ---------------------------------------------------------------- Einzelne Mail (aktion "eingang") und Postfach-Aktionen
	const start = wf.trigger('Bei Einzelaufruf', [0, 300], [
		['aktion', 'string'],
		['postfach', 'string'],
		['graph_id', 'string'],
		['internet_message_id', 'string'],
		['entwurf_id', 'string'],
		['freigabe_id', 'string'],
		['vorgangs_id', 'string'],
		['html', 'string'],
	]);
	const aktion = wf.node('Aktion', 'n8n-nodes-base.switch', [220, 300], {
		mode: 'rules',
		rules: {
			values: AKTIONEN.map((a) => ({
				conditions: bedingungen([bedingung("={{ $json.aktion || 'eingang' }}", { type: 'string', operation: 'equals' }, a)]),
				renameOutput: true,
				outputKey: a,
			})),
		},
		options: {},
	});
	const BASIS = `${GRAPH}/users/{{ encodeURIComponent($('Bei Einzelaufruf').first().json.postfach) }}/messages/{{ encodeURIComponent($('Bei Einzelaufruf').first().json.graph_id) }}`;
	const laden = graph(wf, 'Mail laden', [440, 300], 'GET', `=${BASIS}`, { query: { $select: MAIL_FELDER } });
	const liste = graph(wf, 'Anhänge auflisten', [660, 300], 'GET', `=${BASIS}/attachments`, { query: { $select: 'id,name,contentType,size,isInline', $top: '100' } });

	const pruefen = wf.code('Anhänge prüfen', [660, 300], [], `
const MAX = ${MAX_DOWNLOAD_BYTES};
const basis = ${JSON.stringify(GRAPH)} + '/users/' + encodeURIComponent($('Bei Einzelaufruf').first().json.postfach) + '/messages/' + encodeURIComponent($('Bei Einzelaufruf').first().json.graph_id) + '/attachments/';
const liste = ($input.first().json.value || []);
const alle = [];
const laden = [];
for (const a of liste) {
	const typ = String(a.contentType || '').toLowerCase();
	const name = String(a.name || 'Anhang');
	const datei = String(a['@odata.type'] || '').endsWith('fileAttachment');
	const art = typ === 'application/pdf' || /\\.pdf$/i.test(name) ? 'pdf' : /^image\\/(jpeg|png|gif|webp)$/.test(typ) ? 'bild' : 'sonst';
	const meta = { name, contentType: art === 'pdf' ? 'application/pdf' : typ, size: Number(a.size) || 0, isInline: a.isInline === true, status: 'ok', hinweis: null };
	if (!datei) { meta.status = 'nicht_ausgewertet'; meta.hinweis = 'Eingebettete Mail/Element wird nicht ausgelesen'; }
	else if (art === 'sonst') { meta.status = 'nicht_ausgewertet'; meta.hinweis = 'Dateityp wird nicht ausgelesen'; }
	else if (meta.size > MAX) { meta.status = 'zu_gross'; meta.hinweis = 'größer als 25 MB'; }
	alle.push(meta);
	if (meta.status === 'ok' && !meta.isInline) laden.push({ index: alle.length - 1, art, url: basis + encodeURIComponent(a.id) + '/$value' });
}
return laden.length ? laden.map((l) => ({ json: { ...l, alle } })) : [{ json: { index: null, alle } }];
`);
	const zuLaden = wf.node('Anhang zu laden?', 'n8n-nodes-base.if', [880, 300], {
		conditions: bedingungen([bedingung('={{ $json.index }}', { type: 'number', operation: 'exists', singleValue: true })]),
		options: { looseTypeValidation: true },
	});
	const download = graph(wf, 'Anhang laden', [1100, 200], 'GET', '={{ $json.url }}', { node: { onError: 'continueRegularOutput', alwaysOutputData: true } },
		{ response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } });
	const kodieren = wf.node('Anhang kodieren', 'n8n-nodes-base.extractFromFile', [1320, 200], {
		operation: 'binaryToPropery',
		binaryPropertyName: 'data',
		destinationKey: 'base64',
		options: { keepSource: 'both' },
	}, { onError: 'continueRegularOutput', alwaysOutputData: true });
	const pdf = wf.node('PDF lesen', 'n8n-nodes-base.extractFromFile', [1540, 200], {
		operation: 'pdf',
		binaryPropertyName: 'data',
		options: { joinPages: true, maxPages: 50 },
	}, { onError: 'continueRegularOutput', alwaysOutputData: true });

	const zusammen = wf.code('Anhänge zusammenstellen', [1760, 300], [], `
const MAX_BILD_BASE64 = 14 * 1024 * 1024; // ca. 10 MB Bild
const geprueft = $('Anhänge prüfen').all().map((i) => i.json);
const alle = (geprueft[0] && geprueft[0].alle ? geprueft[0].alle : []).map((a) => ({ ...a }));
if ($('PDF lesen').isExecuted) {
	const geladen = $('Anhang laden').all();
	const kodiert = $('Anhang kodieren').all();
	const gelesen = $('PDF lesen').all();
	geprueft.forEach((g, i) => {
		if (g.index === null || g.index === undefined) return;
		const ziel = alle[g.index];
		if (!geladen[i] || geladen[i].json.error) { ziel.status = 'defekt'; ziel.hinweis = 'Anhang konnte nicht geladen werden'; return; }
		if (g.art === 'bild') {
			const b64 = kodiert[i] && kodiert[i].json.base64;
			if (!b64) { ziel.status = 'defekt'; ziel.hinweis = 'Bild nicht lesbar'; }
			else if (b64.length > MAX_BILD_BASE64) { ziel.status = 'zu_gross'; ziel.hinweis = 'Bild zu groß für die KI-Auswertung'; }
			else ziel.bild_data_url = 'data:' + ziel.contentType + ';base64,' + b64;
		} else {
			const r = gelesen[i] && gelesen[i].json;
			if (!r || r.error) { ziel.status = 'defekt'; ziel.hinweis = 'PDF nicht lesbar (beschädigt oder verschlüsselt)'; }
			else ziel.text = typeof r.text === 'string' ? r.text : '';
		}
	});
}
return [{ json: {
	postfach: $('Bei Einzelaufruf').first().json.postfach,
	mail: $('Mail laden').first().json,
	anhaenge: alle,
} }];
`);

	const verarbeiten = wf.aufruf('Eingang verarbeiten', [1980, 300], 'EPA-01 Eingang verarbeiten', [
		['postfach', 'string', '={{ $json.postfach }}'],
		['mail', 'object', '={{ $json.mail }}'],
		['anhaenge', 'array', '={{ $json.anhaenge }}'],
		['aufrufer_execution_id', 'string', '={{ String($execution.id) }}'],
	]);
	const archivieren = wf.node('Archivieren?', 'n8n-nodes-base.if', [2200, 300], {
		conditions: bedingungen([bedingung('={{ $json.archivieren }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const ordner = graph(wf, 'Archivordner suchen', [2420, 200], 'GET', `=${GRAPH}/users/${P}/mailFolders`,
		{ query: { $filter: "=displayName eq '{{ String($json.archivordner).replace(/'/g, \"''\") }}'", $select: 'id,displayName' } });
	const ordnerId = wf.code('Ordner-ID ermitteln', [2640, 200], [], `
const name = $('Eingang verarbeiten').first().json.archivordner;
const treffer = ($input.first().json.value || []).filter((f) => f.displayName === name);
if (treffer.length !== 1) throw new Error(\`[EPA:424:KONFIGURATIONSFEHLER:\${$('Eingang verarbeiten').first().json.vorgangs_id || '-'}] Archivordner "\${name}" \${treffer.length ? 'ist mehrdeutig' : 'fehlt'} im Postfach (Ordner auf oberster Ebene anlegen)\`);
return [{ json: { ordner_id: treffer[0].id } }];
`);
	const verschieben = graph(wf, 'In Archiv verschieben', [2860, 200], 'POST', `=${BASIS}/move`, { body: '={{ JSON.stringify({ destinationId: $json.ordner_id }) }}' });

	const ergebnis = wf.code('Ergebnis melden', [3080, 300], [], `
const r = $('Eingang verarbeiten').first().json;
return [{ json: { ...r, verschoben: $('In Archiv verschieben').isExecuted } }];
`);

	// ---------------------------------------------------------------- Aktion: Antwortentwurf im Thread anlegen (Bauplan 5.4)
	const suchen = graph(wf, 'Ursprungsmail suchen', [440, 700], 'GET', `=${GRAPH}/users/${P}/messages`, {
		query: { $filter: `=internetMessageId eq '{{ String(${E}.internet_message_id).replace(/'/g, "''") }}'`, $select: 'id,subject', $top: '2' },
	});
	const ursprung = wf.code('Ursprung prüfen', [660, 700], [], `
const e = $('Bei Einzelaufruf').first().json;
const treffer = $input.first().json.value || [];
if (!treffer.length) throw new Error(\`[EPA:404:NICHT_GEFUNDEN:\${e.vorgangs_id || '-'}] Ursprungsmail für den Antwortentwurf nicht im Postfach gefunden\`);
return [{ json: { id: treffer[0].id } }];
`);
	const reply = graph(wf, 'Antwortentwurf anlegen', [880, 700], 'POST', `=${GRAPH}/users/${P}/messages/{{ encodeURIComponent($json.id) }}/createReply`, { body: '={}' });
	const befuellen = graph(wf, 'Entwurf befüllen', [1100, 700], 'PATCH', `=${GRAPH}/users/${P}/messages/{{ encodeURIComponent($json.id) }}`, {
		body: `={{ JSON.stringify({ subject: String($json.subject || '').includes('[' + ${E}.vorgangs_id + ']') ? $json.subject : ($json.subject || '') + ' [' + ${E}.vorgangs_id + ']', body: { contentType: 'HTML', content: ${E}.html }, singleValueExtendedProperties: [{ id: ${JSON.stringify(PROP_FREIGABE)}, value: ${E}.freigabe_id }] }) }}`,
	});
	const entwurfMelden = wf.code('Entwurf melden', [1320, 700], [], `
const d = $input.first().json;
const an = (d.toRecipients || []).map((r) => r.emailAddress && r.emailAddress.address).filter(Boolean);
return [{ json: { entwurf_id: d.id, betreff: d.subject || '', empfaenger: an.join(', '), internet_message_id: d.internetMessageId || null } }];
`);

	// ---------------------------------------------------------------- Aktion: Entwurf aktualisieren (Freigabe mit Bearbeitung)
	const aktualisieren = graph(wf, 'Entwurfstext ersetzen', [440, 900], 'PATCH', `=${GRAPH}/users/${P}/messages/{{ encodeURIComponent(${E}.entwurf_id) }}`, {
		body: `={{ JSON.stringify({ body: { contentType: 'HTML', content: ${E}.html } }) }}`,
	});
	const aktualisiert = wf.code('Aktualisierung melden', [660, 900], [], `
return [{ json: { aktualisiert: true, entwurf_id: $input.first().json.id } }];
`);

	// ---------------------------------------------------------------- Aktion: Entwurf senden, ohne Doppelversand (Bauplan 5.4, Punkt 3)
	const pruefenEntwurf = graph(wf, 'Entwurf abrufen', [440, 1100], 'GET', `=${GRAPH}/users/${P}/messages/{{ encodeURIComponent(${E}.entwurf_id) }}`,
		{ query: { $select: 'id,isDraft,internetMessageId' }, node: { retryOnFail: false } },
		{ response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } });
	const entscheiden = wf.code('Versand entscheiden', [660, 1100], [], `
const e = $('Bei Einzelaufruf').first().json;
const r = $input.first().json;
const status = Number(r.statusCode);
if (status === 200 && r.body && r.body.isDraft === true) return [{ json: { weg: 'senden', internet_message_id: r.body.internetMessageId || null } }];
if (status === 404 || (status === 200 && r.body && r.body.isDraft === false)) return [{ json: { weg: 'suchen', internet_message_id: null } }];
throw new Error(\`[EPA:\${status === 401 ? '401:AUTH_FEHLER' : status === 403 ? '403:KEINE_BERECHTIGUNG' : '502:UPSTREAM_FEHLER'}:\${e.vorgangs_id || '-'}] Entwurf nicht abrufbar (HTTP \${status})\`);
`);
	const sendenFrage = wf.node('Entwurf vorhanden?', 'n8n-nodes-base.if', [880, 1100], {
		conditions: bedingungen([bedingung('={{ $json.weg }}', { type: 'string', operation: 'equals' }, 'senden')]),
		options: {},
	});
	// Kein automatischer Retry: Ein Timeout nach erfolgreichem Versand würde sonst als Fehler enden.
	// Stattdessen wird bei jedem Fehler in "Gesendete Elemente" nachgesehen.
	const senden = graph(wf, 'Entwurf senden', [1100, 1000], 'POST', `=${GRAPH}/users/${P}/messages/{{ encodeURIComponent(${E}.entwurf_id) }}/send`,
		{ node: { retryOnFail: false, onError: 'continueRegularOutput', alwaysOutputData: true } });
	const sendeErgebnis = wf.code('Sendeergebnis', [1320, 1000], [], `
const r = $input.first().json || {};
return [{ json: { bestaetigt: !r.error, internet_message_id: $('Versand entscheiden').first().json.internet_message_id } }];
`);
	const bestaetigt = wf.node('Versand bestätigt?', 'n8n-nodes-base.if', [1540, 1000], {
		conditions: bedingungen([bedingung('={{ $json.bestaetigt }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const gesendetMelden = wf.code('Gesendet melden', [1760, 900], [], `
return [{ json: { gesendet: true, bereits: false, internet_message_id: $input.first().json.internet_message_id } }];
`);
	const gesendetSuchen = graph(wf, 'In Gesendet suchen', [1760, 1180], 'GET', `=${GRAPH}/users/${P}/mailFolders/sentitems/messages`, {
		query: { $filter: `=singleValueExtendedProperties/Any(ep: ep/id eq '${PROP_FREIGABE}' and ep/value eq '{{ ${E}.freigabe_id }}')`, $select: 'id,internetMessageId' },
	});
	const gesendetPruefen = wf.code('Gesendet prüfen', [1980, 1180], [], `
const e = $('Bei Einzelaufruf').first().json;
const treffer = $input.first().json.value || [];
if (!treffer.length) throw new Error(\`[EPA:502:UPSTREAM_FEHLER:\${e.vorgangs_id || '-'}] Rückfrage nicht gesendet: Entwurf fehlt bzw. Versand fehlgeschlagen und nicht in Gesendete Elemente\`);
return [{ json: { gesendet: true, bereits: true, internet_message_id: treffer[0].internetMessageId || null } }];
`);

	// ---------------------------------------------------------------- Aktion: Verbindung prüfen (Watchdog, M6)
	const posteingang = graph(wf, 'Posteingang prüfen', [440, 1400], 'GET', `=${GRAPH}/users/${P}/mailFolders/inbox`,
		{ query: { $select: 'id' }, node: { retryOnFail: false } },
		{ response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } });
	const verbindung = wf.code('Verbindung melden', [660, 1400], [], `
const r = $input.first().json || {};
const status = Number(r.statusCode) || null;
const fehler = r.body && r.body.error ? String(r.body.error.code || r.body.error.message || '').slice(0, 120) : '';
return [{ json: { ok: status === 200, status, meldung: status === 200 ? '' : fehler } }];
`);

	// ---------------------------------------------------------------- Aktion: ersetzten Entwurf löschen (Löschjob, M6)
	// Nur löschen, was nachweislich ein Entwurf mit genau dieser Freigabe-Kennung ist. DELETE verschiebt in "Gelöschte Elemente".
	const entwurfLesen = graph(wf, 'Entwurf zum Löschen abrufen', [440, 1600], 'GET', `=${GRAPH}/users/${P}/messages/{{ encodeURIComponent(${E}.entwurf_id) }}`,
		{ query: { $select: 'id,isDraft', $expand: `singleValueExtendedProperties($filter=id eq '${PROP_FREIGABE}')` }, node: { retryOnFail: false } },
		{ response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } });
	const loeschPruefung = wf.code('Löschen prüfen', [660, 1600], ['loeschen'], `
const e = $('Bei Einzelaufruf').first().json;
return [{ json: loeschen.entwurfPruefen($input.first().json, e.freigabe_id, ${JSON.stringify(PROP_FREIGABE)}) }];
`);
	const loeschenFrage = wf.node('Entwurf löschen?', 'n8n-nodes-base.if', [880, 1600], {
		conditions: bedingungen([bedingung('={{ $json.loeschen }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const entwurfWeg = graph(wf, 'Entwurf löschen', [1100, 1540], 'DELETE', `=${GRAPH}/users/${P}/messages/{{ encodeURIComponent(${E}.entwurf_id) }}`);
	const geloescht = wf.code('Löschung melden', [1320, 1600], [], `
const p = $('Löschen prüfen').first().json;
return [{ json: { geloescht: p.loeschen, erledigt: p.erledigt, grund: p.grund } }];
`);

	wf.kette(trigger, festlegen, einzeln);
	wf.kette(start, aktion);
	wf.verbinde(aktion, laden, 0);
	wf.verbinde(aktion, suchen, 1);
	wf.verbinde(aktion, aktualisieren, 2);
	wf.verbinde(aktion, pruefenEntwurf, 3);
	wf.verbinde(aktion, posteingang, 4);
	wf.verbinde(aktion, entwurfLesen, 5);
	wf.kette(posteingang, verbindung);
	wf.kette(entwurfLesen, loeschPruefung, loeschenFrage);
	wf.verbinde(loeschenFrage, entwurfWeg, 0);
	wf.verbinde(loeschenFrage, geloescht, 1);
	wf.kette(entwurfWeg, geloescht);
	wf.kette(suchen, ursprung, reply, befuellen, entwurfMelden);
	wf.kette(aktualisieren, aktualisiert);
	wf.kette(pruefenEntwurf, entscheiden, sendenFrage);
	wf.verbinde(sendenFrage, senden, 0);
	wf.verbinde(sendenFrage, gesendetSuchen, 1);
	wf.kette(senden, sendeErgebnis, bestaetigt);
	wf.verbinde(bestaetigt, gesendetMelden, 0);
	wf.verbinde(bestaetigt, gesendetSuchen, 1);
	wf.kette(gesendetSuchen, gesendetPruefen);
	wf.kette(laden, liste, pruefen, zuLaden);
	wf.verbinde(zuLaden, download, 0);
	wf.verbinde(zuLaden, zusammen, 1);
	wf.kette(download, kodieren, pdf, zusammen);
	wf.kette(zusammen, verarbeiten, archivieren);
	wf.verbinde(archivieren, ordner, 0);
	wf.verbinde(archivieren, ergebnis, 1);
	wf.kette(ordner, ordnerId, verschieben, ergebnis);
	return wf;
};
