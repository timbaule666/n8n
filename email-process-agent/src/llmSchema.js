'use strict';
// LLM-Anbindung ohne Tools (Masterprompt A4, B2, 6): Ausgabeschemata, eigener Schema-Validator (n8n Cloud erlaubt
// im Code-Node keine externen Bibliotheken), Prompt-Aufbau mit klar abgegrenzten, nicht vertrauenswürdigen Mail-Daten,
// Auswertung der OpenAI-Antwort inkl. Retry-Entscheidung.

const AUFGABEN = ['klassifizierung', 'extraktion'];
const KLASSEN = ['anfrage', 'keine_anfrage', 'unklar'];
const MAX_VERSUCHE_TECHNISCH = 3; // 429, 5xx, Timeout
const MAX_KORREKTUREN = 1; // ungültiges JSON/Schema

// ---------------------------------------------------------------- Schemata

function klassifizierungSchema(vorgangstypen) {
	const typen = [...(vorgangstypen || [])];
	return {
		type: 'object',
		additionalProperties: false,
		required: ['klasse', 'konfidenz', 'begruendung_kurz', 'vorgangstyp', 'sprache', 'verdacht_manipulation'],
		properties: {
			klasse: { type: 'string', enum: KLASSEN },
			konfidenz: { type: 'number', minimum: 0, maximum: 1 },
			begruendung_kurz: { type: 'string', maxLength: 300 },
			vorgangstyp: { type: ['string', 'null'], enum: [...typen, null] },
			sprache: { type: 'string', pattern: '^[a-z]{2}$' },
			verdacht_manipulation: { type: 'boolean' },
		},
	};
}

/** Extraktionsschema dynamisch aus der Feldliste der Config: je Feld { wert, quelle, konfidenz }. */
function extraktionSchema(felder) {
	const props = {};
	for (const f of felder || []) {
		props[f.feldname] = {
			type: 'object',
			additionalProperties: false,
			required: ['wert', 'quelle', 'konfidenz'],
			properties: {
				// Werte immer als Text: die Normalisierung (Zahl, Datum, PLZ) macht die Pflichtfeld-Prüfung deterministisch.
				wert: { type: ['string', 'null'], maxLength: 500 },
				quelle: { type: ['string', 'null'], maxLength: 200 },
				konfidenz: { type: 'number', minimum: 0, maximum: 1 },
			},
		};
	}
	return {
		type: 'object',
		additionalProperties: false,
		required: ['felder', 'verdacht_manipulation'],
		properties: {
			felder: { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props },
			verdacht_manipulation: { type: 'boolean' },
		},
	};
}

function schemaFuer(aufgabe, kontext) {
	if (aufgabe === 'klassifizierung') return klassifizierungSchema(kontext.vorgangstypen);
	if (aufgabe === 'extraktion') return extraktionSchema(kontext.felder);
	throw new Error(`Unbekannte LLM-Aufgabe "${aufgabe}"`);
}

// ---------------------------------------------------------------- Validator (Teilmenge von JSON Schema)

function typVon(w) {
	if (w === null) return 'null';
	if (Array.isArray(w)) return 'array';
	if (typeof w === 'number') return Number.isInteger(w) ? 'integer' : 'number';
	return typeof w;
}

function passtTyp(w, typ) {
	const t = typVon(w);
	return t === typ || (typ === 'number' && t === 'integer');
}

/** Gibt eine Liste von Fehlern zurück (leer = gültig). */
function validieren(wert, schema, pfad = '$') {
	const fehler = [];
	const typen = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
	if (typen.length && !typen.some((t) => passtTyp(wert, t))) {
		return [`${pfad}: erwartet ${typen.join('|')}, ist ${typVon(wert)}`];
	}
	if (schema.enum && !schema.enum.some((e) => e === wert)) fehler.push(`${pfad}: Wert ${JSON.stringify(wert)} nicht erlaubt`);
	if (typeof wert === 'number') {
		if (schema.minimum !== undefined && wert < schema.minimum) fehler.push(`${pfad}: kleiner als ${schema.minimum}`);
		if (schema.maximum !== undefined && wert > schema.maximum) fehler.push(`${pfad}: größer als ${schema.maximum}`);
	}
	if (typeof wert === 'string') {
		if (schema.maxLength !== undefined && wert.length > schema.maxLength) fehler.push(`${pfad}: länger als ${schema.maxLength} Zeichen`);
		if (schema.pattern && !new RegExp(schema.pattern).test(wert)) fehler.push(`${pfad}: Format ungültig`);
	}
	if (typVon(wert) === 'object') {
		const props = schema.properties || {};
		for (const r of schema.required || []) if (!(r in wert)) fehler.push(`${pfad}.${r}: fehlt`);
		for (const [k, v] of Object.entries(wert)) {
			if (props[k]) fehler.push(...validieren(v, props[k], `${pfad}.${k}`));
			else if (schema.additionalProperties === false) fehler.push(`${pfad}.${k}: nicht erlaubt`);
		}
	}
	if (Array.isArray(wert) && schema.items) wert.forEach((v, i) => fehler.push(...validieren(v, schema.items, `${pfad}[${i}]`)));
	return fehler;
}

/**
 * Schema für OpenAI Structured Outputs (strict). Nur Kern-Schlüsselwörter, deren Unterstützung sicher ist;
 * Längen, Zahlenbereiche und Muster prüft danach unser eigener Validator.
 */
function fuerOpenAi(schema) {
	const KERN = ['type', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'description'];
	const out = {};
	for (const k of KERN) if (k in schema) out[k] = schema[k];
	if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, fuerOpenAi(v)]));
	if (out.items) out.items = fuerOpenAi(out.items);
	return out;
}

/** JSON aus der Modellantwort lesen (toleriert ```json-Zäune). */
function jsonLesen(text) {
	if (typeof text !== 'string' || !text.trim()) return { ok: false, fehler: 'leere Antwort' };
	let s = text.trim();
	const zaun = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (zaun) s = zaun[1];
	try {
		return { ok: true, wert: JSON.parse(s) };
	} catch (e) {
		return { ok: false, fehler: `kein gültiges JSON (${String(e.message).slice(0, 80)})` };
	}
}

// ---------------------------------------------------------------- Prompt-Aufbau

/** Mailinhalt als Datenblock. Abschluss-Tags im Inhalt werden entschärft, damit der Block nicht verlassen werden kann. */
function datenblock(name, inhalt) {
	const sicher = String(inhalt ?? '').replace(/<\s*\/?\s*(mail_daten|anhang_daten|bekannte_daten)\b/gi, (m) => m.replace('<', '[').replace(/\s/g, ''));
	return `<${name}>\n${sicher}\n</${name}>`;
}

/** Mail-Daten für den Prompt: nur, was für die Aufgabe nötig ist (keine Adressen außer der Domain). */
function mailText(mail, { mitAnhaengen = true } = {}) {
	const z = [
		`Betreff: ${mail.betreff || '(leer)'}`,
		`Absender-Domain: ${mail.absender_domain || '(unbekannt)'}`,
		`Weiterleitung: ${mail.ist_weiterleitung ? 'ja' : 'nein'}`,
		'Text:',
		mail.text || '(kein Text)',
	];
	const anh = (mail.anhaenge || []);
	if (anh.length) {
		z.push('', 'Anhänge:');
		for (const a of anh) z.push(`- ${a.name} (${a.typ}, Status: ${a.status})`);
		if (mitAnhaengen) {
			for (const a of anh.filter((x) => x.text)) z.push('', `=== Inhalt Anhang "${a.name}" ===`, a.text);
		}
	}
	return z.join('\n');
}

function feldliste(felder) {
	return (felder || []).map((f) => {
		const regel = f.validierungsregel && Object.keys(f.validierungsregel).length ? ` Regel: ${JSON.stringify(f.validierungsregel)}.` : '';
		return `- ${f.feldname} (${f.anzeigename}; Typ ${f.typ}; ${f.pflicht ? 'Pflicht' : 'optional'}): ${f.extraktions_hinweis || f.anzeigename}.${regel}`;
	}).join('\n');
}

function ersetzen(vorlage, variablen) {
	return String(vorlage || '').replace(/\{\{\s*([A-Z_]+)\s*\}\}/g, (m, k) => (k in variablen ? String(variablen[k]) : m));
}

/**
 * Baut den Request-Body für /v1/chat/completions.
 * @param {string} aufgabe klassifizierung | extraktion
 * @param {{system: string, user_vorlage: string, version: string}} prompt aus der Prompt-Registry
 * @param {object} kontext { mail, vorgangstypen?, felder?, hinweise?, heute? }
 * @param {{modell, temperatur, max_tokens}} profil
 */
function anfrageBauen(aufgabe, prompt, kontext, profil) {
	if (!AUFGABEN.includes(aufgabe)) throw new Error(`Unbekannte LLM-Aufgabe "${aufgabe}"`);
	const schema = schemaFuer(aufgabe, kontext);
	const variablen = {
		MAIL: datenblock('mail_daten', mailText(kontext.mail, { mitAnhaengen: aufgabe === 'extraktion' })),
		VORGANGSTYPEN: (kontext.vorgangstypen || []).join(', ') || '(keine)',
		FELDLISTE: feldliste(kontext.felder),
		HINWEISE: (kontext.hinweise || []).length ? kontext.hinweise.map((h) => `- ${h}`).join('\n') : '- keine',
		HEUTE: kontext.heute || '',
		SCHEMA: JSON.stringify(schema),
	};
	const userText = ersetzen(prompt.user_vorlage, variablen);
	const bilder = aufgabe === 'extraktion' ? (kontext.mail.anhaenge || []).filter((a) => a.bild && a.bild_data_url) : [];
	const userInhalt = bilder.length
		? [{ type: 'text', text: userText }, ...bilder.map((b) => ({ type: 'image_url', image_url: { url: b.bild_data_url, detail: 'high' } }))]
		: userText;
	return {
		model: profil.modell,
		temperature: profil.temperatur,
		max_tokens: profil.max_tokens,
		messages: [
			{ role: 'system', content: ersetzen(prompt.system, variablen) },
			{ role: 'user', content: userInhalt },
		],
		response_format: { type: 'json_schema', json_schema: { name: aufgabe, strict: true, schema: fuerOpenAi(schema) } },
	};
}

// ---------------------------------------------------------------- Antwort auswerten

function wartezeitMs(headers, versuch) {
	const h = headers || {};
	const ra = h['retry-after'] ?? h['Retry-After'];
	const sek = Number(ra);
	if (Number.isFinite(sek) && sek >= 0) return Math.min(60000, Math.max(1000, sek * 1000));
	return Math.min(60000, 2000 * 2 ** (versuch - 1));
}

/**
 * Entscheidet nach einem HTTP-Aufruf, wie es weitergeht.
 * @param {object} antwort Ausgabe des HTTP-Request-Nodes (fullResponse) oder { error } bei Timeout/Netzwerkfehler
 * @param {object} zustand { body, schema, versuch, korrekturen }
 * @returns {{ aktion: 'fertig'|'wiederholen'|'korrigieren'|'ungueltig'|'fehler', ... }}
 */
function antwortAuswerten(antwort, zustand) {
	const a = antwort || {};
	const versuch = zustand.versuch || 1;
	const technisch = (code, text) => (versuch < MAX_VERSUCHE_TECHNISCH
		? { aktion: 'wiederholen', warte_ms: wartezeitMs(a.headers, versuch), grund: text, code }
		: { aktion: 'fehler', code, grund: `${text} (nach ${versuch} Versuchen)` });

	if (a.error || a.statusCode === undefined) {
		const msg = String((a.error && (a.error.message || a.error.description)) || a.error || 'keine Antwort');
		const timeout = /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT|aborted/i.test(msg);
		return technisch(timeout ? 'ZEITUEBERSCHREITUNG' : 'NICHT_ERREICHBAR', timeout ? 'LLM-Timeout' : 'LLM nicht erreichbar');
	}
	const status = Number(a.statusCode);
	const body = typeof a.body === 'string' ? (jsonLesen(a.body).wert || {}) : a.body || {};
	const fehlerTyp = body && body.error && (body.error.code || body.error.type);
	if (status === 429 && fehlerTyp === 'insufficient_quota') return { aktion: 'fehler', code: 'RATE_LIMIT', grund: 'OpenAI-Kontingent erschöpft' };
	if (status === 429) return technisch('RATE_LIMIT', 'LLM-Rate-Limit (429)');
	if (status === 408 || status >= 500) return technisch(status === 504 || status === 408 ? 'ZEITUEBERSCHREITUNG' : 'UPSTREAM_FEHLER', `LLM-Fehler ${status}`);
	if (status === 401) return { aktion: 'fehler', code: 'AUTH_FEHLER', grund: 'LLM-Zugang ungültig (401)' };
	if (status === 403) return { aktion: 'fehler', code: 'KEINE_BERECHTIGUNG', grund: 'LLM-Zugriff verweigert (403)' };
	if (status !== 200) return { aktion: 'fehler', code: 'KONFIGURATIONSFEHLER', grund: `LLM-Anfrage abgelehnt (${status}${fehlerTyp ? ', ' + fehlerTyp : ''}), Modell/Parameter prüfen` };

	const wahl = body.choices && body.choices[0];
	const nutzung = body.usage ? { prompt: body.usage.prompt_tokens, antwort: body.usage.completion_tokens } : null;
	const inhalt = wahl && wahl.message ? wahl.message.content : null;
	let fehler;
	if (wahl && wahl.message && wahl.message.refusal) fehler = ['Modell hat die Antwort verweigert'];
	else if (wahl && wahl.finish_reason === 'length') fehler = ['Antwort wurde abgeschnitten (max_tokens zu klein?)'];
	else {
		const j = jsonLesen(inhalt);
		fehler = j.ok ? validieren(j.wert, zustand.schema) : [j.fehler];
		if (!fehler.length) return { aktion: 'fertig', ergebnis: j.wert, nutzung, modell: body.model || null };
	}
	if ((zustand.korrekturen || 0) < MAX_KORREKTUREN) {
		return { aktion: 'korrigieren', fehler: fehler.slice(0, 10), inhalt: typeof inhalt === 'string' ? inhalt.slice(0, 4000) : '', nutzung };
	}
	return { aktion: 'ungueltig', code: 'EXTRAKTION_UNGUELTIG', fehler: fehler.slice(0, 10), nutzung };
}

/** Body für den einen Korrektur-Versuch. */
function korrekturBody(body, inhalt, fehler) {
	return {
		...body,
		messages: [
			...body.messages,
			{ role: 'assistant', content: inhalt || '' },
			{ role: 'user', content: `Deine Antwort entspricht nicht dem Schema: ${fehler.join('; ')}. Antworte ausschließlich mit einem JSON-Objekt gemäß Schema, ohne weiteren Text.` },
		],
	};
}

module.exports = {
	AUFGABEN,
	KLASSEN,
	MAX_VERSUCHE_TECHNISCH,
	MAX_KORREKTUREN,
	klassifizierungSchema,
	extraktionSchema,
	schemaFuer,
	validieren,
	fuerOpenAi,
	jsonLesen,
	datenblock,
	mailText,
	feldliste,
	ersetzen,
	anfrageBauen,
	wartezeitMs,
	antwortAuswerten,
	korrekturBody,
};
