'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const GRAPH = 'https://graph.microsoft.com/v1.0';

function teams(wf, name, pos, methode, url, body) {
	const p = { method: methode, url, authentication: 'predefinedCredentialType', nodeCredentialType: 'microsoftTeamsOAuth2Api', options: {} };
	if (body) {
		p.sendBody = true;
		p.specifyBody = 'json';
		p.jsonBody = body;
	}
	return wf.node(name, 'n8n-nodes-base.httpRequest', pos, p, Workflow.retry({ onError: 'continueRegularOutput', alwaysOutputData: true }));
}

module.exports = function () {
	const wf = new Workflow('EPA SW Freigabe senden');
	// Härtung (M6): Erfolgreiche Ausführungen enthalten Klartext-Links bzw. Mail-Text und werden nicht gespeichert.
	wf.settings.saveDataSuccessExecution = 'none';

	wf.notiz('Notiz Zweck', [-80, -420], [
		'## EPA SW Freigabe senden',
		'**Zweck:** Schickt einem Freigeber seinen persönlichen Freigabe-Link als Teams-Nachricht im 1:1-Chat (Variante B, Bauplan 6). Der Link geht nur an diese Person, nicht in einen Kanal.',
		'**Trigger:** Aufruf durch EPA-02 (je Freigeber ein Aufruf).',
		'**Eingaben:** kunde_id, vorgangs_id, freigeber (E-Mail/UPN), nachricht_html.',
		'**Ausgabe:** { gesendet, fehler_id }. Ein Fehler bricht nichts ab; er landet im Fehlerlog, EPA-02 meldet dann im Kanal, dass die Freigabe nicht zugestellt wurde.',
		'**Einrichten:** In den drei Graph-Nodes das Teams-Credential (Dienstkonto, OAuth2 delegiert, Scope Chat.ReadWrite) zuweisen. [zu verifizieren] 1:1-Chat zwischen Dienstkonto und Freigeber in deinem Tenant.',
	].join('\n'), { breite: 700, hoehe: 320 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['freigeber', 'string'],
		['nachricht_html', 'string'],
	]);
	const eingabe = wf.code('Eingabe prüfen', [220, 0], ['fehlerklassen'], `
const e = $input.first().json;
const vid = e.vorgangs_id || null;
if (!/^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$/.test(String(e.freigeber || ''))) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', vid, 'freigeber ist keine gültige Adresse');
if (typeof e.nachricht_html !== 'string' || !e.nachricht_html.trim()) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', vid, 'Nachricht fehlt');
return [{ json: { ...e, vorgangs_id: vid, freigeber: e.freigeber.trim().toLowerCase() } }];
`);
	const ich = teams(wf, 'Eigenes Konto lesen', [440, 0], 'GET', `${GRAPH}/me?$select=id`);
	const chat = teams(wf, 'Chat öffnen', [660, 0], 'POST', `${GRAPH}/chats`, `={{ JSON.stringify({ chatType: 'oneOnOne', members: [
  { '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': ${JSON.stringify(GRAPH)} + "/users('" + $json.id + "')" },
  { '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': ${JSON.stringify(GRAPH)} + "/users('" + $('Eingabe prüfen').first().json.freigeber.replace(/'/g, "''") + "')" }
] }) }}`);
	const nachricht = teams(wf, 'Nachricht senden', [880, 0], 'POST', `=${GRAPH}/chats/{{ encodeURIComponent($json.id) }}/messages`,
		"={{ JSON.stringify({ body: { contentType: 'html', content: $('Eingabe prüfen').first().json.nachricht_html } }) }}");

	const pruefen = wf.code('Zustellung prüfen', [1100, 0], ['fehlerklassen'], `
const e = $('Eingabe prüfen').first().json;
const schritte = ['Eigenes Konto lesen', 'Chat öffnen', 'Nachricht senden'];
let fehler = null;
for (const s of schritte) {
	if (!$(s).isExecuted) { fehler = fehler || s + ' nicht ausgeführt'; continue; }
	const j = $(s).first().json || {};
	if (j.error || !j.id) { fehler = s + ': ' + (j.error ? (j.error.message || String(j.error)) : 'keine ID'); break; }
}
if (!fehler) return [{ json: { gesendet: true } }];
return [{ json: {
	gesendet: false,
	fehler: {
		statuscode: 502, fehlercode: 'UPSTREAM_FEHLER', klasse: 'Upstream', retrybar: true, eskalieren: false,
		workflow_id: String($workflow.id), workflow_name: $workflow.name, node: 'Freigabe-Nachricht', execution_id: String($execution.id),
		execution_url: null, modus: $execution.mode, vorgangs_id: e.vorgangs_id, kunde_id: e.kunde_id || null,
		meldung: fehlerklassen.bereinigeMeldung('Freigabe-Link nicht zugestellt: ' + fehler), eskaliert: false, alarmiert_am: null,
	},
} }];
`);
	const fehlgeschlagen = wf.node('Zustellung fehlgeschlagen?', 'n8n-nodes-base.if', [1320, 0], {
		conditions: bedingungen([bedingung('={{ $json.gesendet }}', { type: 'boolean', operation: 'false', singleValue: true })]),
		options: {},
	});
	const zeile = wf.code('Fehlerlog vorbereiten', [1540, -100], [], `
return [{ json: $input.first().json.fehler }];
`);
	const protokoll = wf.tabelle('Fehler protokollieren', [1760, -100], 'insert', 'epa_fehler_log', {}, { onError: 'continueRegularOutput' });
	const melden = wf.code('Ergebnis melden', [1980, 0], [], `
const p = $('Fehler protokollieren').isExecuted ? $('Fehler protokollieren').first().json : null;
return [{ json: { gesendet: $('Zustellung prüfen').first().json.gesendet, fehler_id: p && p.id !== undefined ? p.id : null } }];
`);

	// Bei einem Fehler in einem Schritt laufen die folgenden Graph-Nodes mit einem Fehler-Item weiter und
	// liefern selbst einen Fehler; "Zustellung prüfen" wertet den ersten fehlgeschlagenen Schritt aus.
	wf.kette(trigger, eingabe, ich, chat, nachricht, pruefen, fehlgeschlagen);
	wf.verbinde(fehlgeschlagen, zeile, 0);
	wf.verbinde(fehlgeschlagen, melden, 1);
	wf.kette(zeile, protokoll, melden);
	return wf;
};
