'use strict';
// Prüft und normalisiert die Kunden-Config (Masterprompt 4.2, 4.3, B1).
// Jeder Fehler führt zum harten Abbruch (424). Es wird nie mit Default-Annahmen weitergearbeitet.

const FELDTYPEN = ['text', 'plz', 'datum', 'zahl', 'email', 'telefon', 'enum'];

// Erlaubte Schlüssel der Validierungsregel je Feldtyp (Tippfehler sollen auffallen).
const REGEL_SCHLUESSEL = {
	text: ['min_laenge', 'max_laenge', 'regex'],
	plz: ['regex'],
	datum: ['min_tage_ab_heute', 'max_tage_ab_heute'],
	zahl: ['min', 'max', 'ganzzahl'],
	email: ['regex'],
	telefon: ['min_ziffern', 'max_ziffern'],
	enum: ['werte'],
};

const LLM_AUFGABEN = ['klassifizierung', 'extraktion', 'entwurf'];
const EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const FELDNAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

function parseJson(wert, name, fehler) {
	if (wert === null || wert === undefined || wert === '') return null;
	if (typeof wert === 'object') return wert;
	try {
		return JSON.parse(wert);
	} catch {
		fehler.push(`${name}: kein gültiges JSON`);
		return null;
	}
}

function zahl(wert, name, fehler, { min = -Infinity, max = Infinity, ganz = false } = {}) {
	const n = typeof wert === 'string' && wert.trim() !== '' ? Number(wert) : wert;
	if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (ganz && !Number.isInteger(n))) {
		fehler.push(`${name}: muss ${ganz ? 'eine ganze Zahl' : 'eine Zahl'} zwischen ${min} und ${max} sein (ist "${wert}")`);
		return null;
	}
	return n;
}

function text(wert, name, fehler) {
	if (typeof wert !== 'string' || wert.trim() === '') {
		fehler.push(`${name}: fehlt`);
		return null;
	}
	return wert.trim();
}

function emailListe(wert, name, fehler, { pflicht }) {
	const liste = Array.isArray(wert) ? wert : wert ? [wert] : [];
	if (pflicht && liste.length === 0) fehler.push(`${name}: mindestens eine Adresse nötig`);
	const out = [];
	for (const e of liste) {
		if (typeof e !== 'string' || !EMAIL.test(e.trim())) fehler.push(`${name}: "${e}" ist keine gültige E-Mail-Adresse`);
		else out.push(e.trim().toLowerCase());
	}
	return out;
}

function pruefeRegex(muster, name, fehler) {
	try {
		// eslint-disable-next-line no-new
		new RegExp(muster);
		return true;
	} catch {
		fehler.push(`${name}: ungültiger regulärer Ausdruck "${muster}"`);
		return false;
	}
}

function pruefeRegel(feld, regel, praefix, fehler) {
	const r = regel || {};
	if (typeof r !== 'object' || Array.isArray(r)) {
		fehler.push(`${praefix}.validierungsregel: muss ein JSON-Objekt sein`);
		return {};
	}
	const erlaubt = REGEL_SCHLUESSEL[feld.typ] || [];
	for (const k of Object.keys(r)) {
		if (!erlaubt.includes(k)) fehler.push(`${praefix}.validierungsregel: Schlüssel "${k}" ist für Typ "${feld.typ}" nicht erlaubt (erlaubt: ${erlaubt.join(', ') || 'keine'})`);
	}
	if (r.regex !== undefined) {
		if (typeof r.regex !== 'string') fehler.push(`${praefix}.validierungsregel.regex: muss Text sein`);
		else pruefeRegex(r.regex, `${praefix}.validierungsregel.regex`, fehler);
	}
	for (const k of ['min_laenge', 'max_laenge', 'min_ziffern', 'max_ziffern']) {
		if (r[k] !== undefined) zahl(r[k], `${praefix}.validierungsregel.${k}`, fehler, { min: 0, max: 100000, ganz: true });
	}
	for (const k of ['min', 'max', 'min_tage_ab_heute', 'max_tage_ab_heute']) {
		if (r[k] !== undefined) zahl(r[k], `${praefix}.validierungsregel.${k}`, fehler);
	}
	const paare = [['min_laenge', 'max_laenge'], ['min_ziffern', 'max_ziffern'], ['min', 'max'], ['min_tage_ab_heute', 'max_tage_ab_heute']];
	for (const [a, b] of paare) {
		if (typeof r[a] === 'number' && typeof r[b] === 'number' && r[a] > r[b]) fehler.push(`${praefix}.validierungsregel: ${a} ist größer als ${b}`);
	}
	if (r.ganzzahl !== undefined && typeof r.ganzzahl !== 'boolean') fehler.push(`${praefix}.validierungsregel.ganzzahl: muss true/false sein`);
	if (feld.typ === 'enum') {
		if (!Array.isArray(r.werte) || r.werte.length === 0 || r.werte.some((w) => typeof w !== 'string' || !w.trim())) {
			fehler.push(`${praefix}.validierungsregel.werte: Typ enum braucht eine Liste erlaubter Werte`);
		}
	}
	return r;
}

function pruefePflichtfelder(zeilen, fehler) {
	const typen = {};
	const gesehen = new Set();
	(zeilen || []).forEach((z, i) => {
		const typ = typeof z.vorgangstyp === 'string' && z.vorgangstyp.trim() ? z.vorgangstyp.trim() : null;
		const name = typeof z.feldname === 'string' ? z.feldname.trim() : '';
		const p = `pflichtfelder[${typ || '?'}.${name || i}]`;
		if (!typ) fehler.push(`${p}.vorgangstyp: fehlt`);
		if (!FELDNAME.test(name)) fehler.push(`${p}.feldname: ungültig (Buchstabe am Anfang, dann Buchstaben, Ziffern, _)`);
		const schluessel = `${typ}.${name}`;
		if (gesehen.has(schluessel)) fehler.push(`${p}: Feld ist doppelt definiert`);
		gesehen.add(schluessel);
		if (!FELDTYPEN.includes(z.typ)) fehler.push(`${p}.typ: "${z.typ}" ist unbekannt (erlaubt: ${FELDTYPEN.join(', ')})`);
		const pflicht = z.pflicht === true || z.pflicht === 'ja';
		if (z.pflicht !== true && z.pflicht !== false && z.pflicht !== 'ja' && z.pflicht !== 'nein') fehler.push(`${p}.pflicht: muss ja/nein sein`);
		const baustein = typeof z.resolution_textbaustein === 'string' ? z.resolution_textbaustein.trim() : '';
		// Jedes Feld, das in einer Rückfrage vorkommen kann, braucht einen festen Baustein (Masterprompt C1).
		if (!baustein) fehler.push(`${p}.resolution_textbaustein: fehlt (Konfigurationsfehler, es wird nicht geraten)`);
		const regel = FELDTYPEN.includes(z.typ) ? pruefeRegel({ typ: z.typ }, parseJson(z.validierungsregel, `${p}.validierungsregel`, fehler), p, fehler) : {};
		const platzhalter = parseJson(z.platzhalter_muster, `${p}.platzhalter_muster`, fehler) || [];
		if (!Array.isArray(platzhalter)) fehler.push(`${p}.platzhalter_muster: muss eine Liste sein`);
		const reihenfolge = z.reihenfolge === undefined || z.reihenfolge === null ? 0 : zahl(z.reihenfolge, `${p}.reihenfolge`, fehler, { min: 0, max: 100000, ganz: true });
		if (!typ) return;
		(typen[typ] = typen[typ] || []).push({
			feldname: name,
			anzeigename: typeof z.anzeigename === 'string' && z.anzeigename.trim() ? z.anzeigename.trim() : name,
			typ: z.typ,
			pflicht,
			validierungsregel: regel || {},
			resolution_textbaustein: baustein,
			extraktions_hinweis: typeof z.extraktions_hinweis === 'string' ? z.extraktions_hinweis.trim() : '',
			platzhalter_muster: Array.isArray(platzhalter) ? platzhalter : [],
			reihenfolge: reihenfolge ?? 0,
		});
	});
	for (const [typ, felder] of Object.entries(typen)) {
		felder.sort((a, b) => a.reihenfolge - b.reihenfolge || a.feldname.localeCompare(b.feldname));
		if (!felder.some((f) => f.pflicht)) fehler.push(`pflichtfelder[${typ}]: kein Pflichtfeld definiert`);
	}
	if (Object.keys(typen).length === 0) fehler.push('pflichtfelder: keine aktiven Felder vorhanden');
	return typen;
}

function pruefeLlmProfil(wert, fehler) {
	const profil = parseJson(wert, 'llm_profil', fehler) || {};
	const out = {};
	for (const aufgabe of LLM_AUFGABEN) {
		const a = profil[aufgabe];
		const p = `llm_profil.${aufgabe}`;
		if (!a || typeof a !== 'object') {
			fehler.push(`${p}: fehlt`);
			continue;
		}
		out[aufgabe] = {
			modell: text(a.modell, `${p}.modell`, fehler),
			temperatur: zahl(a.temperatur, `${p}.temperatur`, fehler, { min: 0, max: 1 }),
			timeout_ms: zahl(a.timeout_ms, `${p}.timeout_ms`, fehler, { min: 1000, max: 300000, ganz: true }),
			max_tokens: zahl(a.max_tokens, `${p}.max_tokens`, fehler, { min: 16, max: 100000, ganz: true }),
		};
	}
	return out;
}

/**
 * @param {object} allgemein Zeile aus epa_config_allgemein
 * @param {object[]} pflichtfelder Zeilen aus epa_config_pflichtfelder (nur aktive)
 * @param {{ zeitzoneGueltig?: (zone: string) => boolean }} [optionen]
 * @returns {{ gueltig: boolean, fehler: string[], config: object|null }}
 */
function validiereConfig(allgemein, pflichtfelder, optionen = {}) {
	const fehler = [];
	const a = allgemein || {};
	if (!allgemein) return { gueltig: false, fehler: ['config_allgemein: keine Zeile gefunden'], config: null };
	if (a.aktiv === false) fehler.push('config_allgemein.aktiv: Kunde ist deaktiviert');

	const kundeId = text(a.kunde_id, 'kunde_id', fehler);
	const postfach = text(a.postfach, 'postfach', fehler);
	if (postfach && !EMAIL.test(postfach)) fehler.push(`postfach: "${postfach}" ist keine gültige E-Mail-Adresse`);
	if (!['Sie', 'Du'].includes(a.anrede_stil)) fehler.push(`anrede_stil: muss "Sie" oder "Du" sein (ist "${a.anrede_stil}")`);
	const sprache = typeof a.sprache === 'string' && /^[a-z]{2}$/.test(a.sprache) ? a.sprache : (fehler.push('sprache: ISO-Code mit zwei Buchstaben, z. B. "de"'), null);
	const signatur = text(a.signatur, 'signatur', fehler);
	const kiHinweis = text(a.ki_hinweistext, 'ki_hinweistext', fehler);

	const zeitzone = text(a.zeitzone, 'zeitzone', fehler);
	if (zeitzone && optionen.zeitzoneGueltig && !optionen.zeitzoneGueltig(zeitzone)) fehler.push(`zeitzone: "${zeitzone}" ist ungültig`);
	const geschaeftszeiten = parseJson(a.geschaeftszeiten, 'geschaeftszeiten', fehler);
	if (!geschaeftszeiten || typeof geschaeftszeiten !== 'object') fehler.push('geschaeftszeiten: fehlt');
	else {
		const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
		if (!hhmm.test(geschaeftszeiten.von || '')) fehler.push('geschaeftszeiten.von: Format HH:MM');
		if (!hhmm.test(geschaeftszeiten.bis || '')) fehler.push('geschaeftszeiten.bis: Format HH:MM');
		if (hhmm.test(geschaeftszeiten.von || '') && hhmm.test(geschaeftszeiten.bis || '') && geschaeftszeiten.bis <= geschaeftszeiten.von) fehler.push('geschaeftszeiten: "bis" muss nach "von" liegen');
		if (!Array.isArray(geschaeftszeiten.tage) || !geschaeftszeiten.tage.length || geschaeftszeiten.tage.some((t) => !Number.isInteger(t) || t < 1 || t > 7)) fehler.push('geschaeftszeiten.tage: Liste mit 1 (Mo) bis 7 (So)');
	}
	const region = a.feiertage_region || null;
	const BL = ['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'];
	if (region !== null && !BL.includes(region)) fehler.push(`feiertage_region: "${region}" ist kein Bundesland-Kürzel`);
	const zusaetzliche = parseJson(a.zusaetzliche_feiertage, 'zusaetzliche_feiertage', fehler) || [];
	if (!Array.isArray(zusaetzliche) || zusaetzliche.some((d) => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d))) fehler.push('zusaetzliche_feiertage: Liste von Daten im Format JJJJ-MM-TT');

	const benachrichtigung = parseJson(a.benachrichtigung, 'benachrichtigung', fehler);
	if (!benachrichtigung || benachrichtigung.kanal !== 'teams') fehler.push('benachrichtigung.kanal: in v1 nur "teams"');
	else {
		text(benachrichtigung.team_id, 'benachrichtigung.team_id', fehler);
		text(benachrichtigung.channel_id, 'benachrichtigung.channel_id', fehler);
	}

	const config = {
		kunde_id: kundeId,
		postfach: postfach ? postfach.toLowerCase() : null,
		anrede_stil: a.anrede_stil,
		sprache,
		signatur,
		ki_hinweistext: kiHinweis,
		frist_stunden: zahl(a.frist_stunden, 'frist_stunden', fehler, { min: 1, max: 2000 }),
		frist_nur_geschaeftszeit: a.frist_nur_geschaeftszeit === true,
		max_runden: zahl(a.max_runden, 'max_runden', fehler, { min: 1, max: 20, ganz: true }),
		erinnerung_intervall_stunden: zahl(a.erinnerung_intervall_stunden, 'erinnerung_intervall_stunden', fehler, { min: 1, max: 2000 }),
		anzahl_erinnerungen: zahl(a.anzahl_erinnerungen, 'anzahl_erinnerungen', fehler, { min: 0, max: 10, ganz: true }),
		zeitzone,
		geschaeftszeiten,
		feiertage_region: region,
		zusaetzliche_feiertage: Array.isArray(zusaetzliche) ? zusaetzliche : [],
		benachrichtigung,
		freigeber: emailListe(parseJson(a.freigeber, 'freigeber', fehler), 'freigeber', fehler, { pflicht: true }),
		vertreter: emailListe(parseJson(a.vertreter, 'vertreter', fehler), 'vertreter', fehler, { pflicht: false }),
		zustaendigkeit: parseJson(a.zustaendigkeit, 'zustaendigkeit', fehler) || {},
		absender_allowlist: parseJson(a.absender_allowlist, 'absender_allowlist', fehler) || [],
		absender_blocklist: parseJson(a.absender_blocklist, 'absender_blocklist', fehler) || [],
		konfidenz_schwelle: zahl(a.konfidenz_schwelle, 'konfidenz_schwelle', fehler, { min: 0, max: 1 }),
		zuordnung_schwellen: parseJson(a.zuordnung_schwellen, 'zuordnung_schwellen', fehler) || { eindeutig: 80, abstand: 50, neu: 40 },
		llm_profil: pruefeLlmProfil(a.llm_profil, fehler),
		prompt_versionen: parseJson(a.prompt_versionen, 'prompt_versionen', fehler) || {},
		archivordner: text(a.archivordner, 'archivordner', fehler),
		aufbewahrung_tage: zahl(a.aufbewahrung_tage, 'aufbewahrung_tage', fehler, { min: 1, max: 3650, ganz: true }),
		anhang_limits: parseJson(a.anhang_limits, 'anhang_limits', fehler) || {},
		leerantwort_fristverlaengerung_stunden: zahl(a.leerantwort_fristverlaengerung_stunden ?? 0, 'leerantwort_fristverlaengerung_stunden', fehler, { min: 0, max: 2000 }),
		freigabe_erinnerung_stunden: zahl(a.freigabe_erinnerung_stunden, 'freigabe_erinnerung_stunden', fehler, { min: 1, max: 2000 }),
		freigabe_ablauf_stunden: zahl(a.freigabe_ablauf_stunden, 'freigabe_ablauf_stunden', fehler, { min: 1, max: 2000 }),
		vorgangstypen: pruefePflichtfelder(pflichtfelder, fehler),
	};
	for (const liste of ['absender_allowlist', 'absender_blocklist']) {
		if (!Array.isArray(config[liste])) fehler.push(`${liste}: muss eine Liste sein`);
	}
	if (config.freigabe_ablauf_stunden !== null && config.freigabe_erinnerung_stunden !== null && config.freigabe_erinnerung_stunden >= config.freigabe_ablauf_stunden) {
		fehler.push('freigabe_erinnerung_stunden: muss kleiner als freigabe_ablauf_stunden sein');
	}
	return fehler.length ? { gueltig: false, fehler, config: null } : { gueltig: true, fehler: [], config };
}

module.exports = { FELDTYPEN, REGEL_SCHLUESSEL, LLM_AUFGABEN, validiereConfig };
