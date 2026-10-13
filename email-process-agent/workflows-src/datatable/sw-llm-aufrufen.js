'use strict';
const { Workflow, bedingung, bedingungen, uuid } = require('../../tools/lib/n8n');

const AKTIONEN = ['wiederholen', 'korrigieren', 'fertig', 'ungueltig', 'fehler'];

module.exports = function () {
	const wf = new Workflow('EPA SW LLM aufrufen');

	wf.notiz('Notiz Zweck', [-80, -520], [
		'## EPA SW LLM aufrufen',
		'**Zweck:** Einziger Zugang zum LLM (OpenAI Chat Completions, ohne Tools). Lädt den Prompt aus der Data Table epa_prompts (Version aus der Config), baut das Ausgabeschema dynamisch (src/llmSchema.js), ruft OpenAI mit Structured Output auf und prüft die Antwort mit eigenem Validator.',
		'**Trigger:** Aufruf durch andere Workflows.',
		'**Eingaben:** kunde_id, vorgangs_id, aufgabe (klassifizierung | extraktion | entwurf), prompt_version, profil (modell, temperatur, timeout_ms, max_tokens, basis_url), kontext (mail, vorgangstypen, felder, hinweise, heute), fehler_als_ergebnis (true: technische Fehler als { ok: false, technisch: true } statt Abbruch).',
		'**Ausgabe:** { ok, ergebnis, code, fehler, modell, prompt_version, versuche, korrekturen, nutzung }. ok=false mit code EXTRAKTION_UNGUELTIG (422), wenn auch der Korrekturversuch ungültig war: der Aufrufer entscheidet fachlich.',
		'**Retries:** 429/5xx/Timeout bis zu 3 Versuche mit Wartezeit (Retry-After bzw. 2 s, 4 s). 401/403/400 sofort Fehler. Danach Abbruch mit EPA-Fehler -> EPA-05.',
		'**Einrichten:** Im Node "OpenAI aufrufen" das OpenAI-Credential zuweisen. Kein Mailinhalt landet in Logs; nur in den Ausführungsdaten von n8n (Aufbewahrung in den Instanz-Einstellungen begrenzen).',
	].join('\n'), { breite: 760, hoehe: 380 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['aufgabe', 'string'],
		['prompt_version', 'string'],
		['profil', 'object'],
		['kontext', 'object'],
		['fehler_als_ergebnis', 'boolean'],
	]);

	const eingabe = wf.code('Eingabe prüfen', [220, 0], ['fehlerklassen', 'llmSchema'], `
const e = $input.first().json;
const vid = typeof e.vorgangs_id === 'string' && e.vorgangs_id ? e.vorgangs_id : null;
const fehler = (text) => fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', vid, text);
if (!llmSchema.AUFGABEN.includes(e.aufgabe)) throw fehler(\`LLM-Aufgabe "\${e.aufgabe}" ist unbekannt\`);
if (typeof e.prompt_version !== 'string' || !/^v\\d+$/.test(e.prompt_version)) throw fehler('prompt_version fehlt oder ist ungültig');
const p = e.profil || {};
if (!p.modell || typeof p.temperatur !== 'number' || !Number.isInteger(p.timeout_ms) || !Number.isInteger(p.max_tokens) || !p.basis_url) throw fehler('LLM-Profil unvollständig');
const k = e.kontext || {};
if (e.aufgabe !== 'entwurf' && (!k.mail || typeof k.mail !== 'object')) throw fehler('kontext.mail fehlt');
if (e.aufgabe === 'extraktion' && (!Array.isArray(k.felder) || k.felder.length === 0)) throw fehler('kontext.felder fehlt');
return [{ json: { kunde_id: e.kunde_id, vorgangs_id: vid, aufgabe: e.aufgabe, prompt_version: e.prompt_version, profil: p, kontext: k, fehler_als_ergebnis: e.fehler_als_ergebnis === true } }];
`);

	const prompt = wf.tabelle('Prompt laden', [440, 0], 'get', 'epa_prompts', {
		bedingungen: [['name', 'eq', '={{ $json.aufgabe }}'], ['version', 'eq', '={{ $json.prompt_version }}'], ['aktiv', 'isTrue']],
	}, { alwaysOutputData: true });

	const bauen = wf.code('Anfrage bauen', [660, 0], ['fehlerklassen', 'llmSchema'], `
const e = $('Eingabe prüfen').first().json;
const p = $input.first().json;
if (!p || p.id === undefined || !p.system || !p.user_vorlage) {
	throw fehlerklassen.epaFehler('KONFIGURATIONSFEHLER', e.vorgangs_id, \`Prompt \${e.aufgabe}/\${e.prompt_version} fehlt in epa_prompts (tools/datatables-setup.js --prompts)\`);
}
const body = llmSchema.anfrageBauen(e.aufgabe, p, e.kontext, e.profil);
return [{ json: {
	body,
	schema: llmSchema.schemaFuer(e.aufgabe, e.kontext),
	url: e.profil.basis_url + '/chat/completions',
	timeout_ms: e.profil.timeout_ms,
	versuch: 1,
	korrekturen: 0,
	nutzung: [],
} }];
`);

	// Schleifenanker: jede Runde (Erstversuch, Wiederholung, Korrektur) läuft hier durch.
	const zustand = wf.code('Anfrage-Zustand', [880, 0], [], `
return $input.all();
`);

	const aufruf = wf.node('OpenAI aufrufen', 'n8n-nodes-base.httpRequest', [1100, 0], {
		method: 'POST',
		url: '={{ $json.url }}',
		authentication: 'predefinedCredentialType',
		nodeCredentialType: 'openAiApi',
		sendBody: true,
		specifyBody: 'json',
		jsonBody: '={{ JSON.stringify($json.body) }}',
		options: {
			timeout: '={{ $json.timeout_ms }}',
			response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } },
		},
	}, { onError: 'continueRegularOutput', alwaysOutputData: true });

	const auswerten = wf.code('Antwort auswerten', [1320, 0], ['llmSchema'], `
const z = $('Anfrage-Zustand').itemMatching(0).json;
const a = $input.first().json;
const r = llmSchema.antwortAuswerten(a, z);
const nutzung = r.nutzung ? [...z.nutzung, r.nutzung] : z.nutzung;
const naechster = { ...z, ...r, nutzung };
if (r.aktion === 'wiederholen') naechster.versuch = z.versuch + 1;
return [{ json: naechster }];
`);

	const weiche = wf.node('Wie weiter?', 'n8n-nodes-base.switch', [1540, 0], {
		mode: 'rules',
		rules: {
			values: AKTIONEN.map((a) => ({
				conditions: bedingungen([bedingung('={{ $json.aktion }}', { type: 'string', operation: 'equals' }, a)]),
				renameOutput: true,
				outputKey: a,
			})),
		},
		options: {},
	});

	const warten = wf.node('Warten vor Wiederholung', 'n8n-nodes-base.wait', [1760, -240], {
		resume: 'timeInterval',
		amount: '={{ Math.ceil($json.warte_ms / 1000) }}',
		unit: 'seconds',
	}, { webhookId: uuid('EPA SW LLM aufrufen', 'Warten vor Wiederholung') });

	const korrektur = wf.code('Korrektur anfordern', [1760, -80], ['llmSchema'], `
const z = $input.first().json;
return [{ json: {
	body: llmSchema.korrekturBody(z.body, z.inhalt, z.fehler),
	schema: z.schema,
	url: z.url,
	timeout_ms: z.timeout_ms,
	versuch: z.versuch,
	korrekturen: z.korrekturen + 1,
	nutzung: z.nutzung,
} }];
`);

	const melden = wf.code('Ergebnis melden', [1760, 100], [], `
const z = $input.first().json;
const e = $('Eingabe prüfen').first().json;
return [{ json: {
	ok: z.aktion === 'fertig',
	ergebnis: z.aktion === 'fertig' ? z.ergebnis : null,
	code: z.aktion === 'fertig' ? null : z.code,
	fehler: z.aktion === 'fertig' ? [] : z.fehler,
	modell: z.modell || e.profil.modell,
	prompt_version: e.prompt_version,
	versuche: z.versuch,
	korrekturen: z.korrekturen,
	nutzung: z.nutzung,
} }];
`);

	const abbruch = wf.code('Fehler auslösen', [1760, 260], ['fehlerklassen'], `
const z = $input.first().json;
const e = $('Eingabe prüfen').first().json;
// Aufrufer mit eigener Rückfallebene (z. B. Entwurf -> Standardvorlage) bekommen den Fehler als Ergebnis,
// damit EPA-05 den Vorgang nicht eskaliert.
if (e.fehler_als_ergebnis) {
	return [{ json: { ok: false, ergebnis: null, code: z.code || 'UPSTREAM_FEHLER', fehler: [z.grund || 'LLM-Aufruf fehlgeschlagen'], technisch: true, modell: e.profil.modell, prompt_version: e.prompt_version, versuche: z.versuch, korrekturen: z.korrekturen, nutzung: z.nutzung } }];
}
throw fehlerklassen.epaFehler(z.code || 'UPSTREAM_FEHLER', e.vorgangs_id, \`\${e.aufgabe}: \${z.grund || 'LLM-Aufruf fehlgeschlagen'}\`);
`);

	wf.kette(trigger, eingabe, prompt, bauen, zustand, aufruf, auswerten, weiche);
	wf.verbinde(weiche, warten, 0);
	wf.verbinde(weiche, korrektur, 1);
	wf.verbinde(weiche, melden, 2);
	wf.verbinde(weiche, melden, 3);
	wf.verbinde(weiche, abbruch, 4);
	wf.verbinde(warten, zustand);
	wf.verbinde(korrektur, zustand);
	return wf;
};
