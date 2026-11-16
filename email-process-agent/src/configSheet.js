'use strict';
// Kunden-Regeln in einem Google Sheet (Reiter "Allgemein", "Pflichtfelder", "Status").
// Der Kunde pflegt nur die fachlichen Einstellungen. Technik und Sicherheit (Postfach, Kanal, Freigeber,
// KI-Profil, Prompt-Versionen …) bleiben in der Data Table und können über das Sheet nicht geändert werden.
// Ablauf (EPA SW Regeln abgleichen): Sheet lesen -> abgleichen() -> komplette neue Config mit
// configValidator.validiereConfig prüfen -> nur wenn fehlerfrei schreiben. Pflichtfelder werden nie gelöscht,
// fehlende Zeilen werden nur deaktiviert.

const TAGE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const LISTE = /[\n,;]+/;

/**
 * Einstellungen im Reiter "Allgemein": [Spalte, Bezeichnung im Sheet, Art, Erklärung].
 * Art: text | zahl | janein | liste | daten | sonder (Geschäftszeiten, Markierungen).
 */
const EINSTELLUNGEN = Object.freeze([
	['anrede_stil', 'Anrede', 'text', '"Sie" oder "Du"'],
	['sprache', 'Sprache', 'text', 'Standardsprache der Rückfragen, z. B. "de" (Kundenmails in Englisch werden auf Englisch beantwortet, wenn Übersetzungen eingerichtet sind)'],
	['signatur', 'Signatur', 'text', 'Grußformel und Unterschrift unter jeder Rückfrage (Zeilenumbrüche erlaubt)'],
	['ki_hinweistext', 'KI-Hinweis', 'text', 'Hinweis unter jeder Rückfrage, dass die Mail KI-gestützt vorbereitet wurde'],
	['frist_stunden', 'Antwortfrist Kunde (Stunden)', 'zahl', 'So lange wartet der Agent auf die Antwort des Kunden'],
	['frist_nur_geschaeftszeit', 'Frist nur in Geschäftszeiten', 'janein', '"ja": Nur Stunden innerhalb der Geschäftszeiten zählen'],
	['vorgangsnummer_im_betreff', 'Vorgangsnummer im Betreff', 'janein', '"nein" (empfohlen): Nummer nur im Mailtext, die Antwort bleibt beim Kunden im selben Verlauf'],
	['max_runden', 'Maximale Rückfrage-Runden', 'zahl', 'Danach übernimmt ein Mitarbeiter'],
	['erinnerung_intervall_stunden', 'Erinnerung nach (Stunden)', 'zahl', 'Abstand der Erinnerungen an den Kunden'],
	['anzahl_erinnerungen', 'Anzahl Erinnerungen', 'zahl', '0 = keine Erinnerung'],
	['arbeitstage', 'Arbeitstage', 'sonder', 'z. B. "Mo, Di, Mi, Do, Fr"'],
	['geschaeftszeit_von', 'Geschäftszeit von', 'sonder', 'Format HH:MM, z. B. 08:00'],
	['geschaeftszeit_bis', 'Geschäftszeit bis', 'sonder', 'Format HH:MM, z. B. 17:00'],
	['feiertage_region', 'Bundesland für Feiertage', 'text', 'Kürzel, z. B. NW, BY, HH (leer = keine gesetzlichen Feiertage)'],
	['zusaetzliche_feiertage', 'Zusätzliche freie Tage', 'daten', 'Daten als TT.MM.JJJJ, durch Komma getrennt (z. B. Betriebsferien)'],
	['absender_allowlist', 'Absender immer prüfen', 'liste', 'Adressen oder @domain.de, deren Mails nie automatisch aussortiert werden'],
	['absender_blocklist', 'Absender ignorieren', 'liste', 'Adressen oder @domain.de, deren Mails nie bearbeitet werden (sie bleiben im Postfach)'],
	['freigabe_erinnerung_stunden', 'Erinnerung an Freigeber nach (Stunden)', 'zahl', 'Wenn eine Rückfrage so lange nicht freigegeben wurde'],
	['freigabe_ablauf_stunden', 'Freigabe-Link gültig (Stunden)', 'zahl', 'Danach muss die Rückfrage neu angefordert werden'],
	['aufbewahrung_tage', 'Daten aufbewahren (Tage)', 'zahl', 'Danach werden abgeschlossene Vorgänge im System gelöscht (Mails im Postfach nie)'],
	['archivordner', 'Ordner für aussortierte Mails', 'text', 'Leer = aussortierte Mails bleiben im Posteingang (empfohlen). Mails werden nie gelöscht.'],
	['markierung_bereit', 'Outlook-Markierung "bereit"', 'sonder', 'Grüne Markierung, wenn eine Anfrage vollständig ist (leer = keine)'],
	['markierung_rueckfrage', 'Outlook-Markierung "Rückfrage"', 'sonder', 'Rote Markierung, solange eine Rückfrage auf die Freigabe wartet (leer = keine)'],
	['markierung_wartet', 'Outlook-Markierung "wartet"', 'sonder', 'Gelbe Markierung, wenn die Rückfrage verschickt ist und auf die Antwort des Kunden gewartet wird (leer = keine eigene Markierung)'],
]);

/** Spalten im Reiter "Pflichtfelder" (Kopfzeile). */
const PFLICHT_SPALTEN = Object.freeze([
	['vorgangstyp', 'Vorgangstyp'],
	['feldname', 'Feldname'],
	['anzeigename', 'Anzeigename'],
	['typ', 'Typ'],
	['pflicht', 'Pflicht'],
	['resolution_textbaustein', 'Rückfrage-Text'],
	['extraktions_hinweis', 'Hinweis für die KI'],
	['werte', 'Erlaubte Werte'],
	['reihenfolge', 'Reihenfolge'],
	['aktiv', 'Aktiv'],
]);

const FARBE_BEREIT = 'preset4';
const FARBE_RUECKFRAGE = 'preset0';
const FARBE_WARTET = 'preset3';
const STATUS_BEREIT = ['Bereit zur Bearbeitung'];
const STATUS_RUECKFRAGE = ['Freigabe ausstehend'];
const STATUS_WARTET = ['Warten auf Kunde'];
// Zeilen, die in älteren Sheets fehlen dürfen (ohne sie gilt das bisherige Verhalten).
const OPTIONAL = ['markierung_wartet', 'vorgangsnummer_im_betreff'];

const zelle = (v) => (v === null || v === undefined ? '' : String(v)).trim();

function jsonOder(roh, ersatz) {
	if (roh && typeof roh === 'object') return roh;
	if (typeof roh !== 'string' || !roh.trim()) return ersatz;
	try { return JSON.parse(roh); } catch { return ersatz; }
}

function janein(v) {
	const s = zelle(v).toLowerCase();
	if (['ja', 'j', 'x', 'true', 'wahr', '1', 'yes'].includes(s)) return true;
	if (['nein', 'n', '', 'false', 'falsch', '0', 'no'].includes(s)) return false;
	return null;
}

function zahlAus(v) {
	const s = zelle(v).replace(/\s/g, '').replace(',', '.');
	if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
	return Number(s);
}

// ---------------------------------------------------------------- Config -> Sheet

function datumDe(iso) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** Werte der Einstellungen aus einer Config-Zeile (für das Sheet). */
function einstellungsWerte(a) {
	const gz = jsonOder(a.geschaeftszeiten, {});
	const kat = jsonOder(a.outlook_kategorien, {});
	const name = (liste) => { for (const s of liste) if (kat[s] && kat[s].name) return kat[s].name; return ''; };
	const w = {
		arbeitstage: Array.isArray(gz.tage) ? gz.tage.map((t) => TAGE[t - 1]).filter(Boolean).join(', ') : '',
		geschaeftszeit_von: gz.von || '',
		geschaeftszeit_bis: gz.bis || '',
		markierung_bereit: name(STATUS_BEREIT),
		markierung_rueckfrage: name(STATUS_RUECKFRAGE),
		markierung_wartet: name(STATUS_WARTET),
	};
	for (const [spalte, , art] of EINSTELLUNGEN) {
		if (art === 'sonder') continue;
		const v = a[spalte];
		if (art === 'janein') w[spalte] = v === true ? 'ja' : 'nein';
		else if (art === 'liste') w[spalte] = (jsonOder(v, []) || []).join(', ');
		else if (art === 'daten') w[spalte] = (jsonOder(v, []) || []).map(datumDe).join(', ');
		else w[spalte] = v === null || v === undefined ? '' : String(v);
	}
	return w;
}

/** Inhalt der drei Reiter als Tabellen (Listen von Zeilen). */
function sheetInhalt(allgemein, pflichtfelder) {
	const w = einstellungsWerte(allgemein || {});
	const ue = jsonOder((allgemein || {}).uebersetzungen, {}) || {};
	const sprachen = Object.keys(ue);
	const reiterAllgemein = [['Einstellung', 'Wert', 'Erklärung'], ...EINSTELLUNGEN.map(([s, label, , erkl]) => [label, w[s] ?? '', erkl])];
	for (const l of sprachen) {
		reiterAllgemein.push([`Signatur (${l})`, ue[l].signatur || '', `Signatur für Rückfragen auf Mails in der Sprache "${l}"`]);
		reiterAllgemein.push([`KI-Hinweis (${l})`, ue[l].ki_hinweistext || '', `KI-Hinweis für Rückfragen in der Sprache "${l}"`]);
	}
	const zeilen = (pflichtfelder || []).slice().sort((x, y) => (x.reihenfolge || 0) - (y.reihenfolge || 0));
	const reiterPflicht = [[...PFLICHT_SPALTEN.map(([, k]) => k), ...sprachen.map((l) => `Rückfrage-Text (${l})`)], ...zeilen.map((z) => {
		const regel = jsonOder(z.validierungsregel, {}) || {};
		const v = { ...z, pflicht: z.pflicht ? 'ja' : 'nein', aktiv: z.aktiv === false ? 'nein' : 'ja', werte: Array.isArray(regel.werte) ? regel.werte.join(', ') : '' };
		return [...PFLICHT_SPALTEN.map(([s]) => (v[s] === null || v[s] === undefined ? '' : String(v[s]))), ...sprachen.map((l) => ((ue[l].textbausteine || {})[z.feldname] || ''))];
	})];
	return { Allgemein: reiterAllgemein, Pflichtfelder: reiterPflicht, Status: statusZeilen({ ergebnis: 'Angelegt', meldungen: [] }) };
}

/** Body für POST https://sheets.googleapis.com/v4/spreadsheets (neues Sheet mit drei Reitern). */
function anlegenBody(titel, inhalt) {
	const zeile = (werte) => ({ values: werte.map((v) => ({ userEnteredValue: { stringValue: String(v) } })) });
	const reiter = (name, daten, fixiert) => ({
		properties: { title: name, gridProperties: { frozenRowCount: fixiert ? 1 : 0 } },
		data: [{ startRow: 0, startColumn: 0, rowData: daten.map(zeile) }],
	});
	return {
		properties: { title: titel, locale: 'de_DE' },
		sheets: [reiter('Allgemein', inhalt.Allgemein, true), reiter('Pflichtfelder', inhalt.Pflichtfelder, true), reiter('Status', inhalt.Status, false)],
	};
}

// ---------------------------------------------------------------- Kunden-Sheet: "Einstellungen" und "Bereiche"
// Aufbau für den Kunden (seit 16.11.2026): Reiter "Einstellungen" (eine Zeile je Einstellung) und Reiter "Bereiche"
// (je Bereich eine Kopfzeile mit gebucht Ja/Nein, darunter die Angaben mit Pflicht und Rückfrage-Text). Technische
// Eigenschaften (Typ, Hinweis für die KI, Prüfregeln, Reihenfolge) pflegt IPS; neue Angaben legt IPS an.
// Bereiche wie in src/configValidator.js BEREICHE (Module laden sich in n8n nicht gegenseitig; Gleichheit prüft
// test/configSheet.test.js). anzeige = Name im Sheet, namen = akzeptierte Schreibweisen.
const BEREICH_REITER = Object.freeze([
	{ schluessel: 'angebot', spalte: 'bereich_angebot', name: 'Angebotsanfragen', typen: ['angebot', 'angebotsanfrage', 'transport'], anzeige: 'Angebote', namen: ['angebote', 'angebot', 'angebotsanfragen', 'angebotsanfrage'] },
	{ schluessel: 'bestellung', spalte: 'bereich_bestellung', name: 'Bestellungen', typen: ['bestellung'], anzeige: 'Bestellungen', namen: ['bestellungen', 'bestellung'] },
	{ schluessel: 'termin', spalte: 'bereich_termin', name: 'Terminanfragen', typen: ['termin', 'terminanfrage'], anzeige: 'Termine', namen: ['termine', 'termin', 'terminanfragen', 'terminanfrage'] },
	{ schluessel: 'reklamation', spalte: 'bereich_reklamation', name: 'Reklamationen', typen: ['reklamation'], anzeige: 'Reklamationen', namen: ['reklamationen', 'reklamation'] },
]);
const FELDTYPEN = ['text', 'plz', 'datum', 'zahl', 'email', 'telefon', 'enum']; // wie configValidator.FELDTYPEN
const OHNE_IM_KUNDEN_SHEET = ['vorgangsnummer_im_betreff'];
const KENNUNG = 'Kennung';

function bereichVon(typ) {
	const t = String(typ || '').trim().toLowerCase();
	return BEREICH_REITER.find((b) => b.typen.includes(t)) || null;
}

/** Gebucht-Status je Bereich aus der Config-Zeile (wie configValidator.bereicheLesen). */
function bereicheGebucht(a) {
	const z = a || {};
	const gesteuert = BEREICH_REITER.some((b) => Object.prototype.hasOwnProperty.call(z, b.spalte));
	return BEREICH_REITER.map((b) => ({ ...b, aktiv: !gesteuert || z[b.spalte] === true || ['true', 'ja', '1'].includes(String(z[b.spalte] ?? '').trim().toLowerCase()) }));
}

/** Vorgangstyp eines Bereichs beim Kunden (bestehender Typ, sonst Standard). */
function typVonBereich(b, alt) {
	const vorhanden = (alt || []).map((z) => z.vorgangstyp).find((t) => b.typen.includes(String(t || '').toLowerCase()));
	return vorhanden || b.schluessel;
}

/**
 * Inhalt des Kunden-Sheets: [{ titel, zeilen, art: 'einstellungen'|'bereiche'|'status', bloecke? }]
 * bloecke: Zeilenindex der Bereichs-Kopfzeilen mit gebucht (für die Formatierung).
 */
function sheetInhaltBereiche(allgemein, pflichtfelder) {
	const a = allgemein || {};
	const w = einstellungsWerte(a);
	const ue = jsonOder(a.uebersetzungen, {}) || {};
	const sprachen = Object.keys(ue);
	const gebucht = bereicheGebucht(a);
	const einst = [['Einstellung', 'Wert', 'Erklärung'], ...EINSTELLUNGEN.filter(([s]) => !OHNE_IM_KUNDEN_SHEET.includes(s)).map(([s, label, , erkl]) => [label, w[s] ?? '', erkl])];
	for (const l of sprachen) {
		einst.push([`Signatur (${l})`, ue[l].signatur || '', `Signatur für Rückfragen auf Mails in der Sprache "${l}"`]);
		einst.push([`KI-Hinweis (${l})`, ue[l].ki_hinweistext || '', `KI-Hinweis für Rückfragen in der Sprache "${l}"`]);
	}
	const kopf = ['Angabe', 'Pflicht', 'Rückfrage-Text', ...sprachen.map((l) => `Rückfrage-Text (${l})`), KENNUNG];
	const breite = kopf.length;
	const leer = () => Array(breite).fill('');
	const mit = (...x) => [...x, ...Array(breite - x.length).fill('')];
	const ber = [mit('Pflicht „ja“: Fehlt die Angabe in der Mail, bereitet der Agent eine Rückfrage vor (Versand erst nach Freigabe durch Ihre Mitarbeiter). Der Rückfrage-Text geht wortgleich an Ihren Kunden.'), leer()];
	const bloecke = [];
	const felder = (pflichtfelder || []).filter((z) => z.aktiv !== false).slice().sort((x, y) => (x.reihenfolge || 0) - (y.reihenfolge || 0));
	for (const b of gebucht) {
		bloecke.push({ zeile: ber.length, gebucht: b.aktiv, kopf: ber.length + 1 });
		ber.push(mit(b.anzeige, b.aktiv ? 'Ja' : 'Nein', 'gebucht (Freischaltung über IPS)'));
		ber.push(kopf.slice());
		for (const z of felder.filter((f) => (bereichVon(f.vorgangstyp) || {}).schluessel === b.schluessel)) {
			ber.push([z.anzeigename || z.feldname, z.pflicht ? 'ja' : 'nein', z.resolution_textbaustein || '', ...sprachen.map((l) => ((ue[l].textbausteine || {})[z.feldname] || '')), z.feldname]);
		}
		ber.push(leer());
	}
	return [
		{ titel: 'Einstellungen', art: 'einstellungen', zeilen: einst },
		{ titel: 'Bereiche', art: 'bereiche', zeilen: ber, bloecke },
		{ titel: 'Status', art: 'status', zeilen: statusZeilen({ ergebnis: 'Angelegt', meldungen: [], bereiche: gebucht }) },
	];
}

/** Body für POST /v4/spreadsheets und Formatierung (batchUpdate) für das Kunden-Sheet. */
function anlegenBodyBereiche(titel, reiter) {
	const GRAU = { red: 0.45, green: 0.47, blue: 0.52 }, BLAU = { red: 0.16, green: 0.45, blue: 0.85 }, GRUEN = { red: 0.2, green: 0.62, blue: 0.35 }, HELL = { red: 0.93, green: 0.94, blue: 0.96 }, WEISS = { red: 1, green: 1, blue: 1 }, BLASS = { red: 0.55, green: 0.55, blue: 0.6 };
	const zeile = (werte) => ({ values: werte.map((v) => ({ userEnteredValue: { stringValue: String(v ?? '') } })) });
	const body = {
		properties: { title: titel, locale: 'de_DE' },
		sheets: reiter.map((r, i) => ({ properties: { sheetId: i, index: i, title: r.titel, tabColor: r.art === 'status' ? GRAU : BLAU, gridProperties: { frozenRowCount: r.art === 'einstellungen' ? 1 : 0 } }, data: [{ startRow: 0, startColumn: 0, rowData: r.zeilen.map(zeile) }] })),
	};
	const req = [];
	const bereich = (id, r0, r1, c0, c1) => ({ sheetId: id, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
	const format = (id, r0, r1, c0, c1, f, felder) => ({ repeatCell: { range: bereich(id, r0, r1, c0, c1), cell: { userEnteredFormat: f }, fields: `userEnteredFormat(${felder})` } });
	const auswahl = (id, r0, r1, c, werte) => ({ setDataValidation: { range: bereich(id, r0, r1, c, c + 1), rule: { condition: { type: 'ONE_OF_LIST', values: werte.map((x) => ({ userEnteredValue: x })) }, strict: true, showCustomUi: true } } });
	const breite = (id, i, px) => ({ updateDimensionProperties: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } });
	reiter.forEach((r, id) => {
		const n = Math.max(...r.zeilen.map((z) => z.length));
		const m = r.zeilen.length;
		req.push(format(id, 0, m, 0, n, { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' }, 'wrapStrategy,verticalAlignment'));
		if (r.art === 'status') { req.push(breite(id, 0, 320), breite(id, 1, 620)); return; }
		if (r.art === 'einstellungen') {
			req.push(format(id, 0, 1, 0, 3, { backgroundColor: BLAU, textFormat: { bold: true, foregroundColor: WEISS } }, 'backgroundColor,textFormat'));
			req.push(format(id, 1, m, 0, 1, { textFormat: { bold: true } }, 'textFormat'));
			req.push(format(id, 1, m, 2, 3, { textFormat: { foregroundColor: BLASS, fontSize: 9 } }, 'textFormat'));
			req.push(breite(id, 0, 300), breite(id, 1, 380), breite(id, 2, 520));
			r.zeilen.forEach((z, i) => { const e = EINSTELLUNGEN.find((x) => x[1] === z[0]); if (e && e[2] === 'janein') req.push(auswahl(id, i, i + 1, 1, ['ja', 'nein'])); });
			return;
		}
		// Bereiche
		req.push(format(id, 0, 1, 0, n, { textFormat: { italic: true, foregroundColor: BLASS } }, 'textFormat'));
		req.push({ mergeCells: { range: bereich(id, 0, 1, 0, n), mergeType: 'MERGE_ALL' } });
		const kopf = r.zeilen[r.bloecke[0].kopf];
		const kSpalte = kopf.indexOf(KENNUNG);
		kopf.forEach((k, i) => req.push(breite(id, i, k === 'Angabe' ? 240 : k === 'Pflicht' ? 80 : k === KENNUNG ? 130 : 420)));
		r.bloecke.forEach((b, j) => {
			const ende = j + 1 < r.bloecke.length ? r.bloecke[j + 1].zeile : m;
			req.push(format(id, b.zeile, b.zeile + 1, 0, n, { backgroundColor: b.gebucht ? GRUEN : GRAU, textFormat: { bold: true, fontSize: 12, foregroundColor: WEISS } }, 'backgroundColor,textFormat'));
			req.push(format(id, b.kopf, b.kopf + 1, 0, n, { backgroundColor: HELL, textFormat: { bold: true } }, 'backgroundColor,textFormat'));
			req.push(auswahl(id, b.kopf + 1, ende, 1, ['ja', 'nein']));
		});
		req.push(format(id, 1, m, kSpalte, kSpalte + 1, { textFormat: { foregroundColor: BLASS, fontSize: 8 } }, 'textFormat'));
		req.push({ addProtectedRange: { protectedRange: { range: bereich(id, 0, m, kSpalte, kSpalte + 1), description: 'Kennung für den Agenten – bitte nicht ändern', warningOnly: true } } });
		req.push({ addProtectedRange: { protectedRange: { range: bereich(id, 0, m, 0, 1), description: 'Bereiche und Angaben richtet IPS ein', warningOnly: true } } });
	});
	return { body, format: { requests: req } };
}

/**
 * Liest den Reiter "Bereiche" und baut daraus eine Tabelle im Aufbau des Reiters "Pflichtfelder" mit allen
 * bisherigen Feldern; geändert werden nur Pflicht und Rückfrage-Texte. Angaben ohne Zeile bleiben unverändert.
 */
function bereicheLesenKunde(zeilen, alt, allgemein, fehler, hinweise) {
	const ue = jsonOder((allgemein || {}).uebersetzungen, {}) || {};
	const gebucht = bereicheGebucht(allgemein);
	const aenderung = new Map(); // vorgangstyp.feldname -> { pflicht?, text?, texte: { l: t } }
	const orte = new Map();
	let b = null;
	let kopf = null;
	(zeilen || []).forEach((z, i) => {
		const nr = i + 1;
		const a = zelle(z && z[0]);
		const name = a.toLowerCase();
		const neu = BEREICH_REITER.find((x) => x.namen.includes(name));
		if (neu) {
			b = neu;
			kopf = null;
			const im = janein(z[1]);
			const ist = gebucht.find((g) => g.schluessel === b.schluessel).aktiv;
			if (im !== null && im !== ist) hinweise.push(`Bereiche, Zeile ${nr}: ${b.anzeige} steht auf „${zelle(z[1])}“ – gebucht ist „${ist ? 'Ja' : 'Nein'}“. Die Freischaltung ändert IPS, der Wert wird nicht übernommen.`);
			return;
		}
		if (!b) return;
		if (name === 'angabe') { kopf = (z || []).map((k) => zelle(k).toLowerCase()); return; }
		if (!kopf || (z || []).every((x) => !zelle(x))) return;
		const sp = (k) => kopf.indexOf(k);
		const kennung = zelle(z[sp(KENNUNG.toLowerCase())]);
		const typ = typVonBereich(b, alt);
		const feld = (alt || []).find((f) => f.vorgangstyp === typ && f.feldname === kennung);
		if (!kennung || !feld) { hinweise.push(`Bereiche, Zeile ${nr}: „${a || kennung}“ ist keine eingerichtete Angabe und wird ignoriert (neue Angaben richtet IPS ein)`); return; }
		const e = { texte: {} };
		if (sp('pflicht') >= 0) {
			const p = janein(z[sp('pflicht')]);
			if (p === null || zelle(z[sp('pflicht')]) === '') fehler.push(`Bereiche, Zeile ${nr} (${b.anzeige}, ${a}): Pflicht bitte „ja“ oder „nein“`);
			else e.pflicht = p;
		}
		if (sp('rückfrage-text') >= 0) e.text = zelle(z[sp('rückfrage-text')]);
		kopf.forEach((k, j) => { const m = /^rückfrage-text \(([a-z]{2})\)$/.exec(k); if (m) e.texte[m[1]] = zelle(z[j]); });
		aenderung.set(`${typ}.${kennung}`, e);
		orte.set(`${typ}.${kennung}`, `Bereiche, Zeile ${nr}`);
	});
	const sprachen = [...new Set([...Object.keys(ue), ...[...aenderung.values()].flatMap((e) => Object.keys(e.texte))])];
	const tabelle = [[...PFLICHT_SPALTEN.map(([, k]) => k), ...sprachen.map((l) => `Rückfrage-Text (${l})`)]];
	const ortListe = [];
	for (const f of alt || []) {
		const e = aenderung.get(`${f.vorgangstyp}.${f.feldname}`) || { texte: {} };
		const regel = jsonOder(f.validierungsregel, {}) || {};
		const v = { ...f, pflicht: (e.pflicht ?? f.pflicht) ? 'ja' : 'nein', resolution_textbaustein: e.text ?? f.resolution_textbaustein, aktiv: f.aktiv === false ? 'nein' : 'ja', werte: Array.isArray(regel.werte) ? regel.werte.join(', ') : '' };
		tabelle.push([...PFLICHT_SPALTEN.map(([s]) => (v[s] === null || v[s] === undefined ? '' : String(v[s]))), ...sprachen.map((l) => (e.texte[l] ?? ((ue[l] || {}).textbausteine || {})[f.feldname] ?? ''))]);
		ortListe.push(orte.get(`${f.vorgangstyp}.${f.feldname}`) || `Angabe ${f.feldname}`);
	}
	return { zeilen: tabelle, ort: (nr) => ortListe[nr - 2] || `Zeile ${nr}` };
}

// ---------------------------------------------------------------- Sheet -> Config

function tageAus(text, fehler) {
	// "Mo", "Montag", "mo" -> Index; Bereiche wie "Mo-Fr" oder "Montag - Freitag"
	const tag = (s) => TAGE.indexOf(s.slice(0, 1).toUpperCase() + s.slice(1, 2).toLowerCase());
	const teile = zelle(text).split(LISTE).map((t) => t.trim()).filter(Boolean);
	const tage = [];
	for (const t of teile) {
		const bereich = /^([A-Za-zä]+)\s*-\s*([A-Za-zä]+)$/.exec(t);
		if (bereich) {
			const a = tag(bereich[1]); const b = tag(bereich[2]);
			if (a < 0 || b < 0 || b < a) { fehler.push(`Arbeitstage: "${t}" ist ungültig (Mo, Di, Mi, Do, Fr, Sa, So)`); continue; }
			for (let i = a; i <= b; i++) tage.push(i + 1);
			continue;
		}
		const i = tag(t);
		if (i < 0) fehler.push(`Arbeitstage: "${t}" ist kein Wochentag (Mo, Di, Mi, Do, Fr, Sa, So)`);
		else tage.push(i + 1);
	}
	return [...new Set(tage)].sort((x, y) => x - y);
}

function datenAus(text, fehler, label) {
	const out = [];
	for (const t of zelle(text).split(LISTE).map((x) => x.trim()).filter(Boolean)) {
		let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
		if (m) { out.push(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`); continue; }
		m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
		if (m) { out.push(t); continue; }
		fehler.push(`${label}: "${t}" ist kein Datum (TT.MM.JJJJ)`);
	}
	return out;
}

/** Liest den Reiter "Allgemein" (Zeilen [Einstellung, Wert, …]) in { spalte: wert }. */
function allgemeinLesen(zeilen, fehler, hinweise) {
	const nachLabel = new Map(EINSTELLUNGEN.map((e) => [e[1].toLowerCase(), e]));
	const werte = {};
	(zeilen || []).slice(1).forEach((z, i) => {
		const label = zelle(z && z[0]);
		if (!label) return;
		const sp = /^(Signatur|KI-Hinweis) \(([a-z]{2})\)$/i.exec(label);
		if (sp) {
			const l = sp[2].toLowerCase();
			const ziel = (werte.__sprachen = werte.__sprachen || {});
			ziel[l] = { ...(ziel[l] || {}), [sp[1].toLowerCase() === 'signatur' ? 'signatur' : 'ki_hinweistext']: zelle(z[1]).replace(/\r\n/g, '\n') };
			return;
		}
		const e = nachLabel.get(label.toLowerCase());
		if (!e) { hinweise.push(`Allgemein, Zeile ${i + 2}: Einstellung "${label}" ist unbekannt und wird ignoriert`); return; }
		if (e[0] in werte) { fehler.push(`Allgemein: Einstellung "${e[1]}" steht doppelt im Sheet`); return; }
		werte[e[0]] = z.length > 1 ? z[1] : '';
	});
	for (const [s, label] of EINSTELLUNGEN) if (!(s in werte) && !OPTIONAL.includes(s)) fehler.push(`Allgemein: Zeile "${label}" fehlt`);
	return werte;
}

/** Neue Werte für epa_config_allgemein aus den Sheet-Werten (nur die Spalten, die der Kunde pflegen darf). */
function allgemeinUmsetzen(werte, alt, fehler) {
	const neu = {};
	for (const [spalte, label, art] of EINSTELLUNGEN) {
		if (art === 'sonder' || !(spalte in werte)) continue;
		const roh = werte[spalte];
		if (art === 'text') neu[spalte] = zelle(roh).replace(/\r\n/g, '\n');
		else if (art === 'zahl') {
			const z = zahlAus(roh);
			if (z === null) fehler.push(`${label}: "${zelle(roh)}" ist keine Zahl`);
			else neu[spalte] = z;
		} else if (art === 'janein') {
			const b = janein(roh);
			if (b === null) fehler.push(`${label}: bitte "ja" oder "nein" eintragen`);
			else neu[spalte] = b;
		} else if (art === 'liste') {
			neu[spalte] = JSON.stringify(zelle(roh).split(LISTE).map((x) => x.trim().toLowerCase()).filter(Boolean));
		} else if (art === 'daten') {
			neu[spalte] = JSON.stringify(datenAus(roh, fehler, label));
		}
	}
	if (neu.feiertage_region === '') neu.feiertage_region = null;
	if ('arbeitstage' in werte || 'geschaeftszeit_von' in werte || 'geschaeftszeit_bis' in werte) {
		const gzAlt = jsonOder(alt.geschaeftszeiten, {}) || {};
		const gz = { ...gzAlt, tage: tageAus(werte.arbeitstage, fehler), von: zelle(werte.geschaeftszeit_von), bis: zelle(werte.geschaeftszeit_bis) };
		neu.geschaeftszeiten = JSON.stringify(gz);
	}
	if ('markierung_bereit' in werte || 'markierung_rueckfrage' in werte || 'markierung_wartet' in werte) {
		const altKat = jsonOder(alt.outlook_kategorien, {}) || {};
		const kat = {};
		// Die Farbe bleibt, solange der Name gleich bleibt (Outlook kennt je Name nur eine Farbe).
		const setze = (liste, name, farbe) => {
			for (const st of liste) kat[st] = { name, farbe: altKat[st] && altKat[st].name === name && altKat[st].farbe ? altKat[st].farbe : farbe };
		};
		const bereit = zelle(werte.markierung_bereit);
		const rueck = zelle(werte.markierung_rueckfrage);
		if (bereit) setze(STATUS_BEREIT, bereit, FARBE_BEREIT);
		if (rueck) setze(STATUS_RUECKFRAGE, rueck, FARBE_RUECKFRAGE);
		if ('markierung_wartet' in werte) {
			const wartet = zelle(werte.markierung_wartet);
			if (wartet) setze(STATUS_WARTET, wartet, FARBE_WARTET);
		} else if (rueck) {
			// Älteres Sheet ohne Zeile "wartet": wie bisher rot auch beim Warten auf den Kunden
			setze(STATUS_WARTET, rueck, FARBE_RUECKFRAGE);
		}
		neu.outlook_kategorien = Object.keys(kat).length ? JSON.stringify(kat) : '';
	}
	return neu;
}

/** Liest den Reiter "Pflichtfelder" (Kopfzeile + Zeilen) und baut die neuen Tabellenzeilen. */
function pflichtUmsetzen(zeilen, alt, kundeId, fehler, ort = (nr) => `Pflichtfelder, Zeile ${nr}`) {
	const kopf = (zeilen && zeilen[0] ? zeilen[0] : []).map((k) => zelle(k).toLowerCase());
	const index = {};
	for (const [s, k] of PFLICHT_SPALTEN) {
		const i = kopf.indexOf(k.toLowerCase());
		if (i < 0 && s !== 'werte') fehler.push(`Pflichtfelder: Spalte "${k}" fehlt in der Kopfzeile`);
		index[s] = i;
	}
	const sprachSpalten = [];
	kopf.forEach((k, i) => { const m = /^rückfrage-text \(([a-z]{2})\)$/.exec(k); if (m) sprachSpalten.push([m[1], i]); });
	if (fehler.length) return [];
	const altNach = new Map((alt || []).map((z) => [`${z.vorgangstyp}.${z.feldname}`, z]));
	const out = [];
	const gesehen = new Set();
	(zeilen || []).slice(1).forEach((z, i) => {
		const wert = (s) => (index[s] >= 0 ? zelle(z[index[s]]) : '');
		if (PFLICHT_SPALTEN.every(([s]) => !wert(s))) return; // Leerzeile
		const nr = i + 2;
		const vorgangstyp = wert('vorgangstyp');
		const feldname = wert('feldname');
		const schluessel = `${vorgangstyp}.${feldname}`;
		if (gesehen.has(schluessel)) { fehler.push(`${ort(nr)}: Feld "${feldname}" steht doppelt`); return; }
		gesehen.add(schluessel);
		const vorher = altNach.get(schluessel);
		const pflicht = janein(wert('pflicht'));
		if (pflicht === null) fehler.push(`${ort(nr)}: Pflicht bitte "ja" oder "nein"`);
		const aktivRoh = wert('aktiv');
		const aktiv = aktivRoh === '' ? true : janein(aktivRoh);
		if (aktiv === null) fehler.push(`${ort(nr)}: Aktiv bitte "ja" oder "nein"`);
		const reihenfolgeRoh = wert('reihenfolge');
		const reihenfolge = reihenfolgeRoh === '' ? (vorher ? vorher.reihenfolge : (out.length + 1) * 10) : zahlAus(reihenfolgeRoh);
		if (reihenfolge === null) fehler.push(`${ort(nr)}: Reihenfolge ist keine Zahl`);
		const regel = { ...(jsonOder(vorher && vorher.validierungsregel, {}) || {}) };
		const typ = wert('typ').toLowerCase();
		if (typ === 'enum') {
			const liste = wert('werte').split(LISTE).map((x) => x.trim()).filter(Boolean);
			if (liste.length) regel.werte = liste;
		} else delete regel.werte;
		const zeile = {
			kunde_id: kundeId,
			vorgangstyp,
			feldname,
			anzeigename: wert('anzeigename'),
			typ,
			pflicht: pflicht === true,
			validierungsregel: JSON.stringify(regel),
			resolution_textbaustein: wert('resolution_textbaustein'),
			extraktions_hinweis: wert('extraktions_hinweis'),
			platzhalter_muster: vorher && typeof vorher.platzhalter_muster === 'string' ? vorher.platzhalter_muster : '[]',
			reihenfolge: reihenfolge ?? 0,
			aktiv: aktiv !== false,
		};
		const texte = Object.fromEntries(sprachSpalten.map(([l, i]) => [l, zelle(z[i])]));
		out.push({ id: vorher ? vorher.id : null, zeile, texte });
	});
	// Felder, die im Sheet fehlen, werden deaktiviert, nie gelöscht.
	for (const z of alt || []) {
		if (!gesehen.has(`${z.vorgangstyp}.${z.feldname}`) && z.aktiv !== false) {
			const { id, createdAt, updatedAt, ...rest } = z;
			out.push({ id, zeile: { ...rest, aktiv: false }, entfernt: true });
		}
	}
	return out;
}

const SPALTEN_PFLICHT = ['vorgangstyp', 'feldname', 'anzeigename', 'typ', 'pflicht', 'validierungsregel', 'resolution_textbaustein', 'extraktions_hinweis', 'platzhalter_muster', 'reihenfolge', 'aktiv'];

/**
 * Gleicht das Sheet mit der Config ab.
 * @param {object} p
 * @param {object} p.allgemein       Zeile aus epa_config_allgemein
 * @param {object[]} p.pflichtfelder alle Zeilen des Kunden aus epa_config_pflichtfelder (auch inaktive)
 * @param {Array[]} p.reiterAllgemein Werte des Reiters "Allgemein" (Zeilen)
 * @param {Array[]} p.reiterPflicht   Werte des Reiters "Pflichtfelder" (Zeilen)
 * @param {function} p.validieren    (allgemein, aktivePflichtfelder) => { gueltig, fehler }
 * @returns {{ fehler: string[], hinweise: string[], allgemein_update: object, pflicht_ops: object[], aenderungen: string[] }}
 */
function abgleichen({ allgemein, pflichtfelder, reiterAllgemein, reiterPflicht, reiterBereiche, validieren }) {
	const fehler = [];
	const hinweise = [];
	const alt = allgemein || {};
	const werte = allgemeinLesen(reiterAllgemein, fehler, hinweise);
	const neu = allgemeinUmsetzen(werte, alt, fehler);
	let pflicht;
	if (reiterBereiche) {
		// Kunden-Sheet: nur Pflicht und Rückfrage-Texte ändern, nichts deaktivieren oder neu anlegen.
		const z = bereicheLesenKunde(reiterBereiche, pflichtfelder, alt, fehler, hinweise);
		pflicht = fehler.length ? [] : pflichtUmsetzen(z.zeilen, pflichtfelder, alt.kunde_id, fehler, z.ort);
	} else pflicht = pflichtUmsetzen(reiterPflicht, pflichtfelder, alt.kunde_id, fehler);
	const leer = { fehler, hinweise, allgemein_update: {}, pflicht_ops: [], aenderungen: [] };
	if (fehler.length) return leer;

	const gleich = (a, b) => (a === null || a === undefined || a === '' ? '' : String(a)) === (b === null || b === undefined || b === '' ? '' : String(b));
	const labelVon = Object.fromEntries(EINSTELLUNGEN.map(([s, l]) => [s, l]));
	labelVon.geschaeftszeiten = 'Geschäftszeiten';
	labelVon.outlook_kategorien = 'Outlook-Markierungen';
	const allgemeinUpdate = {};
	const aenderungen = [];
	for (const [s, v] of Object.entries(neu)) {
		const json = ['geschaeftszeiten', 'outlook_kategorien', 'absender_allowlist', 'absender_blocklist', 'zusaetzliche_feiertage'].includes(s);
		const k = (x) => (x ? kanonisch(jsonOder(x, x)) : '');
		if (json ? k(alt[s]) !== k(v) : !gleich(alt[s], v)) { allgemeinUpdate[s] = v; aenderungen.push(`${labelVon[s] || s} geändert`); }
	}
	const ops = [];
	const altNachId = new Map((pflichtfelder || []).map((z) => [z.id, z]));
	for (const p of pflicht) {
		if (!p.id) { ops.push({ aktion: 'insert', id: null, zeile: p.zeile }); aenderungen.push(`Feld "${p.zeile.feldname}" neu`); continue; }
		const vorher = altNachId.get(p.id) || {};
		const diff = {};
		const norm = (s, v) => (s === 'validierungsregel' ? JSON.stringify(jsonOder(v, {}) || {}) : v);
		for (const s of SPALTEN_PFLICHT) if (!gleich(norm(s, vorher[s]), norm(s, p.zeile[s]))) diff[s] = p.zeile[s];
		if (!Object.keys(diff).length) continue;
		ops.push({ aktion: 'update', id: p.id, zeile: diff });
		aenderungen.push(p.entfernt ? `Feld "${p.zeile.feldname}" deaktiviert (fehlt im Sheet)` : `Feld "${p.zeile.feldname}" geändert (${Object.keys(diff).join(', ')})`);
	}

	// Die komplette neue Config muss gültig sein, sonst wird nichts übernommen.
	const pflichtNeu = new Map((pflichtfelder || []).map((z) => [z.id, { ...z }]));
	for (const op of ops) {
		if (op.aktion === 'insert') pflichtNeu.set(`neu-${pflichtNeu.size}`, { ...op.zeile });
		else pflichtNeu.set(op.id, { ...pflichtNeu.get(op.id), ...op.zeile });
	}
	const ueAlt = jsonOder(alt.uebersetzungen, {}) || {};
	const sheetSprachen = werte.__sprachen || {};
	const spaltenSprachen = new Set(pflicht.flatMap((p) => Object.keys(p.texte || {})));
	const sprachen = [...new Set([...Object.keys(ueAlt), ...Object.keys(sheetSprachen), ...spaltenSprachen])];
	if (sprachen.length) {
		const aktive = [...pflichtNeu.values()].filter((z) => z.aktiv !== false);
		const textVon = new Map(pflicht.map((p) => [`${p.zeile.vorgangstyp}.${p.zeile.feldname}`, p.texte || {}]));
		const ueNeu = {};
		for (const l of sprachen) {
			const e = ueAlt[l] || {};
			const tb = {};
			for (const f of aktive) {
				const t = (textVon.get(`${f.vorgangstyp}.${f.feldname}`) || {})[l];
				tb[f.feldname] = spaltenSprachen.has(l) ? (t || '') : ((e.textbausteine || {})[f.feldname] || '');
			}
			ueNeu[l] = { ...e, signatur: (sheetSprachen[l] || {}).signatur ?? e.signatur ?? '', ki_hinweistext: (sheetSprachen[l] || {}).ki_hinweistext ?? e.ki_hinweistext ?? '', textbausteine: tb };
		}
		if (kanonisch(ueNeu) !== kanonisch(ueAlt)) { allgemeinUpdate.uebersetzungen = JSON.stringify(ueNeu); aenderungen.push('Übersetzungen geändert'); }
	}
	const pruefung = validieren({ ...alt, ...allgemeinUpdate }, [...pflichtNeu.values()].filter((z) => z.aktiv !== false));
	if (!pruefung.gueltig) return { ...leer, fehler: pruefung.fehler.map(lesbar) };
	for (const h of pruefung.hinweise || []) hinweise.push(lesbar(h));
	return { fehler, hinweise, allgemein_update: allgemeinUpdate, pflicht_ops: ops, aenderungen };
}

/** Technische Feldnamen der Config-Prüfung in Sheet-Bezeichnungen übersetzen. */
function lesbar(meldung) {
	let m = String(meldung);
	for (const [s, label] of EINSTELLUNGEN) m = m.replace(new RegExp(`^${s}(?=[:.])`), `"${label}"`);
	m = m.replace(/^geschaeftszeiten\.tage/, '"Arbeitstage"').replace(/^geschaeftszeiten\.von/, '"Geschäftszeit von"').replace(/^geschaeftszeiten\.bis/, '"Geschäftszeit bis"').replace(/^geschaeftszeiten/, 'Geschäftszeiten');
	m = m.replace(/^uebersetzungen\.([a-z]{2})\.textbausteine\.([^:]+): fehlt/, 'Pflichtfelder: "Rückfrage-Text ($1)" für $2 fehlt');
	m = m.replace(/^uebersetzungen\.([a-z]{2})\.signatur/, '"Signatur ($1)"').replace(/^uebersetzungen\.([a-z]{2})\.ki_hinweistext/, '"KI-Hinweis ($1)"');
	m = m.replace(/^pflichtfelder\[([^\]]*)\]/, 'Pflichtfelder ($1)').replace(/resolution_textbaustein/, 'Rückfrage-Text');
	return m;
}

/** Zeilen für den Reiter "Status" (feste Länge, damit alte Meldungen überschrieben werden). */
function statusZeilen({ zeit = '', ergebnis, meldungen = [], bereiche = [] }) {
	const z = [['Letzte Prüfung', zeit], ['Ergebnis', ergebnis], ['', '']];
	// Gebuchte Bereiche nur zur Info: geschaltet wird von IPS in der Config, nicht im Sheet.
	if (bereiche.length) {
		z.push(['Gebuchte Bereiche (nur Info, Änderung über IPS)', '']);
		for (const b of bereiche) z.push([b.name, b.aktiv ? 'Ja' : 'Nein']);
		z.push(['', '']);
	}
	z.push(['Meldungen', '']);
	for (const m of meldungen.slice(0, 30 - z.length)) z.push(['', m]);
	while (z.length < 30) z.push(['', '']);
	return z;
}

/** JSON mit sortierten Schlüsseln (Vergleich unabhängig von der Reihenfolge). */
function kanonisch(x) {
	if (Array.isArray(x)) return `[${x.map(kanonisch).join(',')}]`;
	if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${kanonisch(x[k])}`).join(',')}}`;
	return JSON.stringify(x);
}

/** Kurzer Fingerabdruck (FNV-1a), um gleiche Fehler nicht bei jedem Lauf erneut zu melden. */
function fingerabdruck(text) {
	let h = 0x811c9dc5;
	for (const c of new TextEncoder().encode(String(text))) { h ^= c; h = Math.imul(h, 0x01000193) >>> 0; }
	return h.toString(16).padStart(8, '0');
}

module.exports = { EINSTELLUNGEN, PFLICHT_SPALTEN, BEREICH_REITER, FELDTYPEN, sheetInhalt, sheetInhaltBereiche, anlegenBody, anlegenBodyBereiche, abgleichen, statusZeilen, fingerabdruck, lesbar };
