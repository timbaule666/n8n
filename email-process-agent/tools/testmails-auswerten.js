#!/usr/bin/env node
'use strict';
// Wertet einen Live-Testlauf mit den Vorlagen aus config/testphase/testmails.json aus.
// Eingaben sind Exporte der Data Tables (JSON mit { rows: [...] } oder einer Liste):
//   node tools/testmails-auswerten.js --vorgaenge=v.json --mails=m.json [--ab=2026-10-15T09:30:00Z] [--nr=M01,M02]
// Zuordnung Vorlage -> Vorgang über den (eindeutigen) Betreff; Ergebnis aus epa_verarbeitete_mails.
// Mails ohne Vorgang (z. B. Abwesenheitsnotizen) werden über die Anzahl der Ergebnisse ohne Vorgangs-ID geprüft.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function arg(name) {
	const a = process.argv.find((x) => x.startsWith(`--${name}=`));
	return a ? a.slice(name.length + 3) : undefined;
}

function zeilen(datei) {
	const d = JSON.parse(fs.readFileSync(datei, 'utf8'));
	return Array.isArray(d) ? d : d.rows || [];
}

const ziffern = (s) => String(s ?? '').replace(/[^\d+]/g, '');
const klein = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Vergleich je Feldtyp; soll "-" = darf keinen Wert haben. */
function vergleiche(feld, soll, ist) {
	const leer = ist === null || ist === undefined || ist === '';
	if (soll === '-') return leer ? 'ok' : 'zu viel';
	if (leer) return 'fehlt';
	switch (feld) {
		case 'Telefon':
			return ziffern(ist).replace(/^\+/, '') === ziffern(soll).replace(/^\+/, '') ? 'ok' : 'falsch';
		case 'Start_PLZ': case 'Ziel_PLZ': case 'Abholdatum':
			return String(ist) === String(soll) ? 'ok' : 'falsch';
		case 'Gewicht_kg': case 'Packstuecke':
			return Number(ist) === Number(soll) ? 'ok' : 'falsch';
		case 'Start_Ort': case 'Ziel_Ort': {
			const a = klein(ist); const b = klein(soll);
			return a === b || a.startsWith(b) || b.startsWith(a) ? 'ok' : 'falsch';
		}
		case 'Ansprechpartner':
			return klein(ist).includes(klein(soll)) ? 'ok' : 'falsch';
		default:
			return klein(ist) === klein(soll) ? 'ok' : 'falsch';
	}
}

function auswerten({ vorlagen, vorgaenge, mails, ab, nummern }) {
	const abZeit = ab ? Date.parse(ab) : 0;
	const v = vorgaenge.filter((x) => Date.parse(x.createdAt) >= abZeit);
	const m = mails.filter((x) => Date.parse(x.createdAt) >= abZeit);
	const ergebnisJeVorgang = new Map();
	for (const x of m.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))) {
		if (x.vorgangs_id && !ergebnisJeVorgang.has(x.vorgangs_id)) ergebnisJeVorgang.set(x.vorgangs_id, x.ergebnis);
	}
	const ohneVorgang = m.filter((x) => !x.vorgangs_id).map((x) => x.ergebnis);
	const out = [];
	for (const nr of nummern) {
		const t = vorlagen[nr];
		const treffer = v.filter((x) => (x.betreff || '') === t.betreff);
		const r = { nr, betreff: t.betreff, erwartet: t.erwartet, vorgaenge: treffer.map((x) => x.vorgangs_id), ergebnis: null, felder: {}, ok: false, hinweise: [] };
		if (!treffer.length) {
			const i = ohneVorgang.findIndex((e) => t.erwartet.includes(e));
			if (i >= 0) { r.ergebnis = ohneVorgang.splice(i, 1)[0]; r.ok = true; } else r.hinweise.push('kein Vorgang/Ergebnis gefunden');
			out.push(r);
			continue;
		}
		if (treffer.length > 1) r.hinweise.push(`${treffer.length} Vorgänge mit diesem Betreff`);
		const vg = treffer[0];
		r.ergebnis = ergebnisJeVorgang.get(vg.vorgangs_id) || null;
		// Rückfrage schon freigegeben oder versendet: Ergebnis war "luecken"
		if (['Warten auf Kunde', 'Freigabe ausstehend', 'Lücken erkannt'].includes(vg.status) && t.erwartet.includes('luecken')) r.ergebnis = 'luecken';
		r.status = vg.status;
		const daten = typeof vg.extrahierte_daten === 'string' ? JSON.parse(vg.extrahierte_daten || '{}') : vg.extrahierte_daten || {};
		let felderOk = true;
		for (const [feld, soll] of Object.entries(t.soll || {})) {
			const ist = daten[feld] ? daten[feld].wert : null;
			const b = vergleiche(feld, soll, ist);
			r.felder[feld] = { soll, ist, bewertung: b };
			if (b !== 'ok') felderOk = false;
		}
		r.ok = t.erwartet.includes(r.ergebnis) && felderOk;
		if (!t.erwartet.includes(r.ergebnis)) r.hinweise.push(`Ergebnis ${r.ergebnis}, erwartet ${t.erwartet.join(' oder ')}`);
		out.push(r);
	}
	return out;
}

function main() {
	const vorlagen = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'testphase', 'testmails.json'), 'utf8'));
	const nummern = arg('nr') ? arg('nr').split(',') : Object.keys(vorlagen).filter((k) => /^M\d+$/.test(k));
	const r = auswerten({ vorlagen, vorgaenge: zeilen(arg('vorgaenge')), mails: zeilen(arg('mails')), ab: arg('ab'), nummern });
	let felderGesamt = 0; let felderOk = 0;
	for (const x of r) {
		const fehler = Object.entries(x.felder).filter(([, f]) => f.bewertung !== 'ok');
		felderGesamt += Object.keys(x.felder).length; felderOk += Object.keys(x.felder).length - fehler.length;
		console.log(`${x.ok ? 'OK    ' : 'ABWEI.'} ${x.nr} ${x.vorgaenge.join(',') || '-'} ${x.ergebnis || '-'}${x.hinweise.length ? ' | ' + x.hinweise.join('; ') : ''}`);
		for (const [feld, f] of fehler) console.log(`         ${feld}: ${f.bewertung} (soll ${f.soll}, ist ${f.ist})`);
	}
	console.log(`\n${r.filter((x) => x.ok).length}/${r.length} Mails wie erwartet, Felder ${felderOk}/${felderGesamt} richtig.`);
}

if (require.main === module) main();
module.exports = { vergleiche, auswerten };
