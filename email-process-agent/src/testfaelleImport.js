'use strict';
// Testphase Stufe 2: eigene, anonymisierte Testmails aus einer CSV-Datei (Excel) in epa_test_ki_faelle übernehmen.
// Je Pflichtfeld gibt es eine Spalte "soll_<Feldname>":
//   leer          -> dieses Feld wird nicht bewertet
//   "-" oder "leer" -> steht nicht in der Mail (die KI soll nichts liefern)
//   sonst         -> erwarteter Wert, wie ein Mensch ihn aus der Mail liest
// Die Prüfung ist bewusst streng bei Hinweisen auf echte Daten: echte E-Mail-Adressen und IBANs führen zum Abbruch.

const KLASSEN = ['anfrage', 'keine_anfrage', 'unklar'];
const PFLICHT_SPALTEN = ['fall_id', 'betreff', 'absender', 'absender_name', 'erwartete_klasse', 'text'];
const SOLL = 'soll_';
const NICHT_DRIN = ['-', '–', '—', 'leer'];
// Reservierte Test-Domains (RFC 2606/6761) und ihre üblichen Formen.
const TEST_DOMAIN = /(^|\.)(example|test|invalid|localhost)$|^example\.(com|org|net)$/i;
const EMAIL = /[A-Za-z0-9._%+'-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/;

/** CSV lesen (Trennzeichen ; oder , automatisch, Anführungszeichen und Zeilenumbrüche in Zellen, BOM). */
function csvLesen(text) {
	const s = String(text).replace(/^﻿/, '');
	const ersteZeile = s.slice(0, s.search(/\r?\n|$/));
	const trenn = (ersteZeile.match(/;/g) || []).length > (ersteZeile.match(/,/g) || []).length ? ';' : ',';
	const zeilen = [];
	let zeile = [];
	let zelle = '';
	let inQuote = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inQuote) {
			if (c === '"' && s[i + 1] === '"') { zelle += '"'; i++; }
			else if (c === '"') inQuote = false;
			else zelle += c;
		} else if (c === '"') inQuote = true;
		else if (c === trenn) { zeile.push(zelle); zelle = ''; }
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && s[i + 1] === '\n') i++;
			zeile.push(zelle); zelle = '';
			if (zeile.some((z) => z !== '')) zeilen.push(zeile);
			zeile = [];
		} else zelle += c;
	}
	if (inQuote) throw new Error('CSV: Anführungszeichen nicht geschlossen');
	zeile.push(zelle);
	if (zeile.some((z) => z !== '')) zeilen.push(zeile);
	if (!zeilen.length) return { spalten: [], daten: [], trenn };
	const spalten = zeilen[0].map((x) => x.trim());
	const daten = zeilen.slice(1).map((z, i) => ({ _zeile: i + 2, ...Object.fromEntries(spalten.map((sp, j) => [sp, (z[j] ?? '').trim()])) }));
	return { spalten, daten, trenn };
}

/** Felddefinitionen aus Zeilen von epa_config_pflichtfelder (nur aktive, Feldname eindeutig über alle Vorgangstypen). */
function felderAusConfig(pflichtfeldZeilen, kundeId) {
	const felder = new Map();
	for (const z of pflichtfeldZeilen) {
		if (kundeId && z.kunde_id !== kundeId) continue;
		if (z.aktiv === false || z.aktiv === 'false') continue;
		if (felder.has(z.feldname)) continue;
		let regel = z.validierungsregel || {};
		if (typeof regel === 'string') regel = regel.trim() ? JSON.parse(regel) : {};
		felder.set(z.feldname, { feldname: z.feldname, typ: z.typ, validierungsregel: regel, reihenfolge: Number(z.reihenfolge) || 0 });
	}
	return [...felder.values()].sort((a, b) => a.reihenfolge - b.reihenfolge);
}

function vorlageSpalten(felder) {
	return [...PFLICHT_SPALTEN, ...felder.map((f) => SOLL + f.feldname), 'notiz'];
}

function fremdeAdressen(text) {
	return [...String(text).matchAll(EMAIL)].map((m) => m[0]).filter((a) => !TEST_DOMAIN.test(a.split('@')[1]));
}

/**
 * Prüft die gelesenen Zeilen und baut die Datensätze für epa_test_ki_faelle.
 * @returns {{ faelle: object[], fehler: string[], warnungen: string[] }}
 */
function zeilenPruefen({ spalten, daten }, felder, { feldPruefen, heute, vorhandeneIds = [] }) {
	const fehler = [];
	const warnungen = [];
	const erlaubt = new Set(vorlageSpalten(felder));
	for (const sp of PFLICHT_SPALTEN) if (!spalten.includes(sp)) fehler.push(`Spalte "${sp}" fehlt`);
	for (const sp of spalten) if (!erlaubt.has(sp)) fehler.push(`Spalte "${sp}" ist unbekannt (Tippfehler? erlaubt: ${[...erlaubt].join(', ')})`);
	if (fehler.length) return { faelle: [], fehler, warnungen };

	const gesehen = new Set(vorhandeneIds);
	const faelle = [];
	for (const z of daten) {
		const wo = `Zeile ${z._zeile}${z.fall_id ? ` (${z.fall_id})` : ''}`;
		const f = [];
		if (!/^[A-Za-z0-9_-]{1,40}$/.test(z.fall_id || '')) f.push('fall_id fehlt oder enthält ungültige Zeichen (erlaubt: Buchstaben, Ziffern, - und _)');
		else if (gesehen.has(z.fall_id)) f.push(`fall_id "${z.fall_id}" gibt es schon`);
		else if (/^S\d+$/.test(z.fall_id)) warnungen.push(`${wo}: fall_id S… ist für die synthetischen Fälle gedacht, besser R-001 …`);
		if (!z.text) f.push('text fehlt');
		const klasse = String(z.erwartete_klasse || '').toLowerCase().replace(/\s+/g, '_');
		if (!KLASSEN.includes(klasse)) f.push(`erwartete_klasse muss ${KLASSEN.join(', ')} sein`);
		const absender = String(z.absender || '').toLowerCase();
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(absender)) f.push('absender ist keine E-Mail-Adresse');
		else if (!TEST_DOMAIN.test(absender.split('@')[1])) f.push(`absender "${absender}" ist keine Test-Adresse (bitte z. B. …@kunde-a.example verwenden)`);
		for (const a of new Set(fremdeAdressen(`${z.betreff}\n${z.text}`))) f.push(`echte E-Mail-Adresse im Text? "${a}" (bitte durch …@….example ersetzen)`);
		if (IBAN.test(`${z.betreff}\n${z.text}`)) f.push('IBAN im Text? Bitte entfernen oder ersetzen');

		const soll = {};
		for (const feld of felder) {
			const roh = z[SOLL + feld.feldname];
			if (roh === undefined || roh === '') continue;
			if (NICHT_DRIN.includes(roh.toLowerCase())) { soll[feld.feldname] = null; continue; }
			const r = feldPruefen(feld, roh, { heute });
			if (!r.ok) warnungen.push(`${wo}: Sollwert ${feld.feldname} "${roh}" besteht die Feldprüfung nicht (${r.grund}); die KI kann hier nie „richtig“ liegen`);
			soll[feld.feldname] = roh;
		}
		if (klasse && klasse !== 'anfrage' && Object.keys(soll).length) warnungen.push(`${wo}: Sollwerte werden nur bei erwartete_klasse = anfrage bewertet`);
		if (klasse === 'anfrage' && !Object.keys(soll).length) warnungen.push(`${wo}: keine Sollwerte, es wird nur die Klassifizierung bewertet`);

		if (f.length) { fehler.push(...f.map((x) => `${wo}: ${x}`)); continue; }
		gesehen.add(z.fall_id);
		faelle.push({
			fall_id: z.fall_id, betreff: z.betreff || '', text: z.text, absender, absender_name: z.absender_name || '',
			erwartete_klasse: klasse, erwartete_felder: JSON.stringify(soll), notiz: z.notiz || 'anonymisiert', aktiv: true,
		});
	}
	if (!daten.length) fehler.push('Die Datei enthält keine Testfälle');
	return { faelle, fehler, warnungen };
}

module.exports = { csvLesen, felderAusConfig, vorlageSpalten, zeilenPruefen, KLASSEN, TEST_DOMAIN };
