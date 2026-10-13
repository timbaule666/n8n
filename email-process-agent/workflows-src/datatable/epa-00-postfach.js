'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const MAIL_FELDER = [
	'id', 'internetMessageId', 'conversationId', 'subject', 'body', 'bodyPreview', 'from', 'sender', 'replyTo', 'toRecipients',
	'ccRecipients', 'receivedDateTime', 'hasAttachments', 'internetMessageHeaders', 'webLink',
].join(',');
// Technische Obergrenze für das Herunterladen; die fachlichen Limits je Kunde prüft EPA-01 (anhang_limits).
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

function graph(wf, name, pos, methode, url, extra = {}, optionen = {}) {
	const p = {
		method: methode,
		url,
		authentication: 'predefinedCredentialType',
		nodeCredentialType: 'microsoftOutlookOAuth2Api',
		options: optionen,
	};
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
		'**Hinweis:** Der Trigger liefert nur die Message-ID; Header (In-Reply-To, References, Auto-Submitted, Authentication-Results) holt "Mail laden", weil der Trigger sie nicht ausgibt.',
	].join('\n'), { breite: 900, hoehe: 380 });

	// ---------------------------------------------------------------- Polling
	const trigger = wf.node('Neue Mail im Posteingang', 'n8n-nodes-base.microsoftOutlookTrigger', [0, 0], {
		pollTimes: { item: [{ mode: 'everyMinute' }] },
		authentication: 'microsoftOutlookOAuth2Api',
		event: 'messageReceived',
		output: 'fields',
		fields: ['id', 'receivedDateTime'],
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
			value: { postfach: '={{ $json.postfach }}', graph_id: '={{ $json.graph_id }}' },
			matchingColumns: [],
			schema: ['postfach', 'graph_id'].map((n) => ({ id: n, displayName: n, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false })),
			attemptToConvertTypes: false,
			convertFieldsToString: false,
		},
		mode: 'each',
		options: { waitForSubWorkflow: true },
	}, { onError: 'continueRegularOutput' });

	// ---------------------------------------------------------------- Einzelne Mail
	const start = wf.trigger('Bei Einzelaufruf', [0, 300], [
		['postfach', 'string'],
		['graph_id', 'string'],
	]);
	const BASIS = `${GRAPH}/users/{{ encodeURIComponent($('Bei Einzelaufruf').first().json.postfach) }}/messages/{{ encodeURIComponent($('Bei Einzelaufruf').first().json.graph_id) }}`;
	const laden = graph(wf, 'Mail laden', [220, 300], 'GET', `=${BASIS}?$select=${MAIL_FELDER}`);
	const liste = graph(wf, 'Anhänge auflisten', [440, 300], 'GET', `=${BASIS}/attachments?$select=id,name,contentType,size,isInline&$top=100`);

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
	const ordner = graph(wf, 'Archivordner suchen', [2420, 200], 'GET',
		`=${GRAPH}/users/{{ encodeURIComponent($('Bei Einzelaufruf').first().json.postfach) }}/mailFolders?$filter=displayName eq '{{ String($json.archivordner).replace(/'/g, "''") }}'&$select=id,displayName`);
	const ordnerId = wf.code('Ordner-ID ermitteln', [2640, 200], [], `
const name = $('Eingang verarbeiten').first().json.archivordner;
const treffer = ($input.first().json.value || []).filter((f) => f.displayName === name);
if (treffer.length !== 1) throw new Error(\`[EPA:424:KONFIGURATIONSFEHLER:\${$('Eingang verarbeiten').first().json.vorgangs_id || '-'}] Archivordner "\${name}" \${treffer.length ? 'ist mehrdeutig' : 'fehlt'} im Postfach (Ordner auf oberster Ebene anlegen)\`);
return [{ json: { ordner_id: treffer[0].id } }];
`);
	const verschieben = graph(wf, 'In Archiv verschieben', [2860, 200], 'POST', `=${BASIS}/move`, { body: '={{ JSON.stringify({ destinationId: $json.ordner_id }) }}' });

	wf.kette(trigger, festlegen, einzeln);
	wf.kette(start, laden, liste, pruefen, zuLaden);
	wf.verbinde(zuLaden, download, 0);
	wf.verbinde(zuLaden, zusammen, 1);
	wf.kette(download, kodieren, pdf, zusammen);
	wf.kette(zusammen, verarbeiten, archivieren);
	wf.verbinde(archivieren, ordner, 0);
	wf.kette(ordner, ordnerId, verschieben);
	return wf;
};
