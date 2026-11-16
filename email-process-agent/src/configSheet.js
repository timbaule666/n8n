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

// ---------------------------------------------------------------- Aufbau mit einem Reiter je Bereich
// Bereiche wie in src/configValidator.js BEREICHE (Module laden sich in n8n nicht gegenseitig; Gleichheit prüft
// test/configSheet.test.js). Ein Reiter je Bereich mit dessen Feldern; Vorgangstyp ergibt sich aus dem Reiter.
const BEREICH_REITER = Object.freeze([
	{ schluessel: 'angebot', spalte: 'bereich_angebot', name: 'Angebotsanfragen', typen: ['angebot', 'angebotsanfrage', 'transport'] },
	{ schluessel: 'bestellung', spalte: 'bereich_bestellung', name: 'Bestellungen', typen: ['bestellung'] },
	{ schluessel: 'termin', spalte: 'bereich_termin', name: 'Terminanfragen', typen: ['termin', 'terminanfrage'] },
	{ schluessel: 'reklamation', spalte: 'bereich_reklamation', name: 'Reklamationen', typen: ['reklamation'] },
]);
const WEITERE = 'Weitere Vorgangsarten';
const ABSCHNITT = '▸';
const FELDTYPEN = ['text', 'plz', 'datum', 'zahl', 'email', 'telefon', 'enum']; // wie configValidator.FELDTYPEN
const BEREICH_SPALTEN = PFLICHT_SPALTEN.filter(([s]) => s !== 'vorgangstyp');
const GRUPPEN = Object.freeze([
	['Texte und Anrede', ['anrede_stil', 'sprache', 'signatur', 'ki_hinweistext']],
	['Rückfragen an Ihre Kunden', ['frist_stunden', 'frist_nur_geschaeftszeit', 'vorgangsnummer_im_betreff', 'max_runden', 'erinnerung_intervall_stunden', 'anzahl_erinnerungen']],
	['Freigabe durch Ihre Mitarbeiter', ['freigabe_erinnerung_stunden', 'freigabe_ablauf_stunden']],
	['Geschäftszeiten', ['arbeitstage', 'geschaeftszeit_von', 'geschaeftszeit_bis', 'feiertage_region', 'zusaetzliche_feiertage']],
	['Absender', ['absender_allowlist', 'absender_blocklist']],
	['Outlook', ['markierung_bereit', 'markierung_rueckfrage', 'markierung_wartet', 'archivordner']],
	['Daten', ['aufbewahrung_tage']],
]);

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

/** Vorgangstyp, unter dem die Felder eines Bereichs-Reiters gespeichert werden (bestehender Typ des Kunden, sonst Standard). */
function typVonBereich(b, alt) {
	const vorhanden = (alt || []).map((z) => z.vorgangstyp).find((t) => b.typen.includes(String(t || '').toLowerCase()));
	return vorhanden || b.schluessel;
}

/** Führt die Bereichs-Reiter zu einer Tabelle im Aufbau des Reiters "Pflichtfelder" zusammen. */
function bereicheZusammenfuehren(reiter, alt, fehler) {
	const sprachen = new Set();
	const tabellen = [];
	for (const b of BEREICH_REITER) {
		const z = reiter[b.name];
		if (!z) { fehler.push(`Reiter "${b.name}" fehlt (bitte Reiter nicht löschen oder umbenennen)`); continue; }
		tabellen.push({ name: b.name, zeilen: z, typ: typVonBereich(b, alt) });
	}
	if (reiter[WEITERE]) tabellen.push({ name: WEITERE, zeilen: reiter[WEITERE], typ: null });
	for (const t of tabellen) {
		const kopf = (t.zeilen[0] || []).map((k) => zelle(k).toLowerCase());
		t.index = {};
		const spalten = t.typ ? BEREICH_SPALTEN : PFLICHT_SPALTEN;
		for (const [s, k] of spalten) {
			const i = kopf.indexOf(k.toLowerCase());
			if (i < 0 && s !== 'werte') fehler.push(`${t.name}: Spalte "${k}" fehlt in der Kopfzeile`);
			t.index[s] = i;
		}
		t.sprachen = [];
		kopf.forEach((k, i) => { const m = /^rückfrage-text \(([a-z]{2})\)$/.exec(k); if (m) { t.sprachen.push([m[1], i]); sprachen.add(m[1]); } });
	}
	const liste = [...sprachen];
	const kopf = [...PFLICHT_SPALTEN.map(([, k]) => k), ...liste.map((l) => `Rückfrage-Text (${l})`)];
	const zeilen = [kopf];
	const orte = [];
	for (const t of tabellen) {
		(t.zeilen || []).slice(1).forEach((z, i) => {
			const w = (s) => (t.index[s] >= 0 ? z[t.index[s]] : '');
			const zeile = PFLICHT_SPALTEN.map(([s]) => (s === 'vorgangstyp' && t.typ ? (PFLICHT_SPALTEN.slice(1).some(([x]) => zelle(w(x))) ? t.typ : '') : w(s)));
			const sp = Object.fromEntries(t.sprachen);
			zeilen.push([...zeile, ...liste.map((l) => (sp[l] !== undefined ? z[sp[l]] : ''))]);
			orte.push(`${t.name}, Zeile ${i + 2}`);
		});
	}
	return { zeilen, ort: (nr) => orte[nr - 2] || `Zeile ${nr}` };
}

/**
 * Inhalt des Regel-Sheets mit einem Reiter je Bereich:
 * [{ titel, zeilen, art: 'info'|'allgemein'|'bereich'|'weitere'|'status', gebucht? }]
 */
function sheetInhaltBereiche(allgemein, pflichtfelder) {
	const a = allgemein || {};
	const w = einstellungsWerte(a);
	const ue = jsonOder(a.uebersetzungen, {}) || {};
	const sprachen = Object.keys(ue);
	const gebucht = bereicheGebucht(a);
	const nachSpalte = Object.fromEntries(EINSTELLUNGEN.map((e) => [e[0], e]));
	const allg = [['Einstellung', 'Wert', 'Erklärung']];
	for (const [titel, spalten] of GRUPPEN) {
		allg.push([`${ABSCHNITT} ${titel}`, '', '']);
		for (const s of spalten) { const [, label, , erkl] = nachSpalte[s]; allg.push([label, w[s] ?? '', erkl]); }
		if (titel === 'Texte und Anrede') {
			for (const l of sprachen) {
				allg.push([`Signatur (${l})`, ue[l].signatur || '', `Signatur für Rückfragen auf Mails in der Sprache "${l}"`]);
				allg.push([`KI-Hinweis (${l})`, ue[l].ki_hinweistext || '', `KI-Hinweis für Rückfragen in der Sprache "${l}"`]);
			}
		}
	}
	const felder = (pflichtfelder || []).slice().sort((x, y) => (x.reihenfolge || 0) - (y.reihenfolge || 0));
	const zeileVon = (z, spalten) => {
		const regel = jsonOder(z.validierungsregel, {}) || {};
		const v = { ...z, pflicht: z.pflicht ? 'ja' : 'nein', aktiv: z.aktiv === false ? 'nein' : 'ja', werte: Array.isArray(regel.werte) ? regel.werte.join(', ') : '' };
		const basis = spalten.map(([s]) => (v[s] === null || v[s] === undefined ? '' : String(v[s])));
		const i = spalten.findIndex(([s]) => s === 'resolution_textbaustein') + 1;
		const texte = sprachen.map((l) => ((ue[l].textbausteine || {})[z.feldname] || ''));
		return [...basis.slice(0, i), ...texte, ...basis.slice(i)];
	};
	const kopfVon = (spalten) => { const k = spalten.map(([, x]) => x); const i = spalten.findIndex(([s]) => s === 'resolution_textbaustein') + 1; return [...k.slice(0, i), ...sprachen.map((l) => `Rückfrage-Text (${l})`), ...k.slice(i)]; };
	const reiter = [{ titel: 'Anleitung', art: 'info', zeilen: anleitung(gebucht) }, { titel: 'Allgemein', art: 'allgemein', zeilen: allg }];
	for (const b of gebucht) {
		reiter.push({ titel: b.name, art: 'bereich', gebucht: b.aktiv, zeilen: [kopfVon(BEREICH_SPALTEN), ...felder.filter((z) => bereichVon(z.vorgangstyp) && bereichVon(z.vorgangstyp).schluessel === b.schluessel).map((z) => zeileVon(z, BEREICH_SPALTEN))] });
	}
	const rest = felder.filter((z) => !bereichVon(z.vorgangstyp));
	if (rest.length) reiter.push({ titel: WEITERE, art: 'weitere', zeilen: [kopfVon(PFLICHT_SPALTEN), ...rest.map((z) => zeileVon(z, PFLICHT_SPALTEN))] });
	reiter.push({ titel: 'Status', art: 'status', zeilen: statusZeilen({ ergebnis: 'Angelegt', meldungen: [], bereiche: gebucht }) });
	return reiter;
}

function anleitung(gebucht) {
	return [
		['Ihre Regeln für den E-Mail-Agenten', ''],
		['', ''],
		['So funktioniert es', 'Sie pflegen hier selbst, wie der Agent arbeitet: Texte, Fristen, Geschäftszeiten und je Bereich die Angaben, die er bei Ihren Kunden prüft und nachfragt. Änderungen werden täglich um 06:20 Uhr geprüft und übernommen.'],
		['Ergebnis', 'Steht im Reiter „Status“. Ist etwas falsch eingetragen, wird nichts übernommen und es gelten die bisherigen Regeln, bis der Fehler behoben ist. Sie bekommen dazu eine Meldung in Teams.'],
		['', ''],
		['Gebuchte Bereiche', 'Der Agent bearbeitet nur gebuchte Bereiche. Nicht gebuchte Bereiche können Sie schon vorbereiten; sie werden genutzt, sobald IPS sie freischaltet.'],
		...gebucht.map((b) => [`   ${b.name}`, b.aktiv ? 'gebucht' : 'nicht gebucht']),
		['', ''],
		['Reiter „Allgemein“', 'Anrede, Signatur, Fristen, Erinnerungen, Freigaben, Geschäftszeiten, Absender und Outlook-Markierungen.'],
		['Reiter je Bereich', 'Eine Zeile je Angabe, die der Agent aus der Mail ausliest und prüft.'],
		['   Pflicht', '„ja“: Fehlt die Angabe, bereitet der Agent eine Rückfrage vor. „nein“: wird ausgelesen, aber nicht nachgefragt.'],
		['   Rückfrage-Text', 'Dieser Satz geht wortgleich an Ihren Kunden, wenn die Angabe fehlt (nach Freigabe durch Ihre Mitarbeiter). Bitte keine Zusagen zu Preisen, Terminen oder Gutschriften.'],
		['   Hinweis für die KI', 'Beschreibt, wonach der Agent in der Mail suchen soll.'],
		['   Typ', 'text, plz, datum, zahl, email, telefon oder enum (nur Werte aus „Erlaubte Werte“).'],
		['   Reihenfolge', 'Reihenfolge der Angaben in Meldungen und Rückfragen.'],
		['   Aktiv', '„nein“: Angabe wird nicht mehr verwendet (bleibt aber gespeichert).'],
		['', ''],
		['Bitte nicht', 'Reiter umbenennen oder löschen, die Kopfzeilen ändern oder Feldnamen ändern. Für eine neue Angabe eine neue Zeile anlegen. Gelöschte Zeilen werden nur deaktiviert, nie gelöscht.'],
		['Nicht hier', 'Postfach, Freigeber, Teams und gebuchte Bereiche ändert IPS für Sie.'],
	];
}

/** Body für POST /v4/spreadsheets und Formatierung (batchUpdate) für das Regel-Sheet mit Bereichs-Reitern. */
function anlegenBodyBereiche(titel, reiter) {
	const GRAU = { red: 0.45, green: 0.47, blue: 0.52 }, BLAU = { red: 0.16, green: 0.45, blue: 0.85 }, GRUEN = { red: 0.2, green: 0.62, blue: 0.35 }, HELL = { red: 0.91, green: 0.94, blue: 0.99 };
	const farbe = (r) => (r.art === 'bereich' ? (r.gebucht ? GRUEN : GRAU) : r.art === 'allgemein' || r.art === 'weitere' ? BLAU : GRAU);
	const zeile = (werte) => ({ values: werte.map((v) => ({ userEnteredValue: { stringValue: String(v ?? '') } })) });
	const body = {
		properties: { title: titel, locale: 'de_DE' },
		sheets: reiter.map((r, i) => ({ properties: { sheetId: i, index: i, title: r.titel, tabColor: farbe(r), gridProperties: { frozenRowCount: r.art === 'info' || r.art === 'status' ? 0 : 1 } }, data: [{ startRow: 0, startColumn: 0, rowData: r.zeilen.map(zeile) }] })),
	};
	const req = [];
	const bereich = (id, r0, r1, c0, c1) => ({ sheetId: id, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
	const auswahl = (id, r0, r1, c, werte) => ({ setDataValidation: { range: bereich(id, r0, r1, c, c + 1), rule: { condition: { type: 'ONE_OF_LIST', values: werte.map((x) => ({ userEnteredValue: x })) }, strict: true, showCustomUi: true } } });
	const breite = (id, i, px) => ({ updateDimensionProperties: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } });
	reiter.forEach((r, id) => {
		const n = Math.max(...r.zeilen.map((z) => z.length));
		const m = r.zeilen.length;
		req.push({ repeatCell: { range: bereich(id, 0, m, 0, n), cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)' } });
		if (r.art === 'info') {
			req.push({ repeatCell: { range: bereich(id, 0, 1, 0, 2), cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } }, fields: 'userEnteredFormat.textFormat' } });
			req.push({ repeatCell: { range: bereich(id, 1, m, 0, 1), cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } });
			req.push(breite(id, 0, 220), breite(id, 1, 820));
			return;
		}
		if (r.art === 'status') { req.push(breite(id, 0, 320), breite(id, 1, 620)); return; }
		req.push({ repeatCell: { range: bereich(id, 0, 1, 0, n), cell: { userEnteredFormat: { backgroundColor: farbe(r), textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
		if (r.art === 'allgemein') {
			req.push(breite(id, 0, 300), breite(id, 1, 360), breite(id, 2, 560));
			r.zeilen.forEach((z, i) => {
				if (String(z[0]).startsWith(ABSCHNITT)) req.push({ repeatCell: { range: bereich(id, i, i + 1, 0, 3), cell: { userEnteredFormat: { backgroundColor: HELL, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
				const e = EINSTELLUNGEN.find((x) => x[1] === z[0]);
				if (e && e[2] === 'janein') req.push(auswahl(id, i, i + 1, 1, ['ja', 'nein']));
			});
			return;
		}
		const kopf = r.zeilen[0];
		const zeilenBis = Math.max(m + 30, 60); // Platz für neue Angaben
		const spalte = (k) => kopf.indexOf(k);
		const breiten = { Vorgangstyp: 120, Feldname: 150, Anzeigename: 200, Typ: 90, Pflicht: 70, 'Rückfrage-Text': 380, 'Hinweis für die KI': 360, 'Erlaubte Werte': 180, Reihenfolge: 90, Aktiv: 70 };
		kopf.forEach((k, i) => req.push(breite(id, i, breiten[k] || 320)));
		req.push(auswahl(id, 1, zeilenBis, spalte('Typ'), FELDTYPEN), auswahl(id, 1, zeilenBis, spalte('Pflicht'), ['ja', 'nein']), auswahl(id, 1, zeilenBis, spalte('Aktiv'), ['ja', 'nein']));
	});
	return { body, format: { requests: req } };
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
		if (!label || label.startsWith(ABSCHNITT)) return; // leer oder Abschnittsüberschrift
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
	const bereichsReiter = reiterBereiche && BEREICH_REITER.some((b) => reiterBereiche[b.name]);
	let pflicht;
	if (bereichsReiter) {
		if (reiterPflicht) hinweise.push('Reiter "Pflichtfelder" wird ignoriert, es gelten die Reiter je Bereich');
		const z = bereicheZusammenfuehren(reiterBereiche, pflichtfelder, fehler);
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

module.exports = { EINSTELLUNGEN, PFLICHT_SPALTEN, BEREICH_REITER, GRUPPEN, FELDTYPEN, WEITERE, sheetInhalt, sheetInhaltBereiche, anlegenBody, anlegenBodyBereiche, abgleichen, statusZeilen, fingerabdruck, lesbar };
