#!/usr/bin/env node
'use strict';
// Testphase Stufe 2: eigene, anonymisierte Testmails (CSV aus Excel) prüfen und in epa_test_ki_faelle einspielen.
//
// Vorlage erzeugen (Spalten passend zu den Pflichtfeldern eines Kunden):
//   node tools/testfaelle-import.js --vorlage --config=config/datatables/beispiel-transport.json [--ziel=datei.csv]
//   N8N_URL=… N8N_API_KEY=… node tools/testfaelle-import.js --vorlage --kunde=<kunde_id> [--ziel=datei.csv]
// Datei prüfen (ohne Einspielen) bzw. einspielen:
//   node tools/testfaelle-import.js faelle.csv --config=config/datatables/beispiel-transport.json --probelauf
//   N8N_URL=… N8N_API_KEY=… node tools/testfaelle-import.js faelle.csv --kunde=<kunde_id> [--probelauf]
//
// Bei Fehlern wird nichts eingespielt. Vorhandene fall_id werden nie überschrieben.
const fs = require('node:fs');
const path = require('node:path');
const imp = require('../src/testfaelleImport');
const { feldPruefen } = require('../src/pflichtfelder');

const ROOT = path.resolve(__dirname, '..');
const VORLAGE_STANDARD = path.join(ROOT, 'config', 'testphase', 'vorlage-ki-testfaelle.csv');

// Beispielzeilen der Vorlage (erfunden). Sie zeigen die Schreibweise und werden beim Ausfüllen ersetzt.
const BEISPIELE = [
	{
		fall_id: 'R-001', betreff: 'Anfrage Transport', absender: 'einkauf@kunde-a.example', absender_name: 'Erika Muster', erwartete_klasse: 'anfrage',
		text: 'Guten Tag,\nbitte um ein Angebot: Abholung 50667 Köln, Lieferung 80331 München, am 20.11.2026.\n2 Paletten, ca. 900 kg.\nRückfragen gern an mich: Erika Muster, 0221 9876543\n\nMit freundlichen Grüßen\nErika Muster',
		soll: { Start_PLZ: '50667', Start_Ort: 'Köln', Ziel_PLZ: '80331', Ziel_Ort: 'München', Abholdatum: '20.11.2026', Gewicht_kg: '900', Packstuecke: '2', Ladungsart: 'Palette', Ansprechpartner: 'Erika Muster', Telefon: '0221 9876543' },
		notiz: 'Beispiel: alle Angaben vorhanden',
	},
	{
		fall_id: 'R-002', betreff: 'Transport nächste Woche', absender: 'info@kunde-b.example', absender_name: '', erwartete_klasse: 'anfrage',
		text: 'Hallo,\nwir müssen etwas von Hamburg nach Berlin bringen, Gewicht ca. 2 t.\nGruß\nIhr Logistik-Team',
		soll: { Start_PLZ: '-', Start_Ort: 'Hamburg', Ziel_PLZ: '-', Ziel_Ort: 'Berlin', Abholdatum: '-', Gewicht_kg: '2000', Ansprechpartner: '-', Telefon: '-' },
		notiz: 'Beispiel: Lücken („-“ = steht nicht in der Mail)',
	},
	{
		fall_id: 'R-003', betreff: 'Newsletter Oktober', absender: 'newsletter@anbieter.example', absender_name: 'Anbieter', erwartete_klasse: 'keine_anfrage',
		text: 'Unsere Angebote im Oktober …', soll: {}, notiz: 'Beispiel: keine Anfrage, keine Sollwerte',
	},
];

function arg(name) {
	const a = process.argv.find((x) => x.startsWith(`--${name}=`));
	return a ? a.slice(name.length + 3) : undefined;
}

async function pflichtfeldZeilen({ config, kunde }) {
	if (config) {
		const d = JSON.parse(fs.readFileSync(path.resolve(config), 'utf8'));
		return { zeilen: d.epa_config_pflichtfelder || [], kunde: kunde || (d.epa_config_allgemein && d.epa_config_allgemein[0].kunde_id) };
	}
	const { alleTabellen, alleZeilen } = require('./datatables-setup');
	const t = (await alleTabellen()).find((x) => x.name === 'epa_config_pflichtfelder');
	if (!t) throw new Error('Tabelle epa_config_pflichtfelder nicht gefunden');
	return { zeilen: await alleZeilen(t.id), kunde };
}

function csvSchreiben(spalten, zeilen) {
	const zelle = (v) => {
		const s = v === null || v === undefined ? '' : String(v);
		return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	// Semikolon und BOM: so öffnet deutsches Excel die Datei direkt richtig.
	return '﻿' + [spalten.join(';'), ...zeilen.map((z) => spalten.map((s) => zelle(z[s])).join(';'))].join('\r\n') + '\r\n';
}

function vorlageInhalt(felder) {
	const spalten = imp.vorlageSpalten(felder);
	const zeilen = BEISPIELE.map((b) => {
		const z = { ...b };
		for (const f of felder) z[`soll_${f.feldname}`] = b.soll[f.feldname] ?? '';
		return z;
	});
	return csvSchreiben(spalten, zeilen);
}

async function main() {
	const config = arg('config');
	const kundeArg = arg('kunde');
	if (!config && !kundeArg) throw new Error('--config=<datei.json> oder --kunde=<kunde_id> angeben');
	if (!config && (!process.env.N8N_URL || !process.env.N8N_API_KEY)) throw new Error('Für --kunde N8N_URL und N8N_API_KEY setzen');
	const { zeilen, kunde } = await pflichtfeldZeilen({ config, kunde: kundeArg });
	const felder = imp.felderAusConfig(zeilen, kunde);
	if (!felder.length) throw new Error(`Keine aktiven Pflichtfelder für Kunde "${kunde}" gefunden`);

	if (process.argv.includes('--vorlage')) {
		const ziel = path.resolve(arg('ziel') || VORLAGE_STANDARD);
		fs.writeFileSync(ziel, vorlageInhalt(felder));
		console.log(`Vorlage geschrieben: ${path.relative(process.cwd(), ziel)} (${felder.length} Sollwert-Spalten für ${kunde})`);
		return 0;
	}

	const datei = process.argv.slice(2).find((a) => !a.startsWith('--'));
	if (!datei) throw new Error('CSV-Datei angeben');
	const probelauf = process.argv.includes('--probelauf') || Boolean(config);
	let tabelle;
	let vorhanden = [];
	if (!probelauf) {
		const { alleTabellen, alleZeilen } = require('./datatables-setup');
		tabelle = (await alleTabellen()).find((x) => x.name === 'epa_test_ki_faelle');
		if (!tabelle) throw new Error('Tabelle epa_test_ki_faelle nicht gefunden (tools/datatables-setup.js ausführen)');
		vorhanden = (await alleZeilen(tabelle.id)).map((z) => z.fall_id);
	}
	const heute = new Date().toISOString().slice(0, 10);
	const r = imp.zeilenPruefen(imp.csvLesen(fs.readFileSync(path.resolve(datei), 'utf8')), felder, { feldPruefen, heute, vorhandeneIds: vorhanden });
	for (const w of r.warnungen) console.log(`Hinweis: ${w}`);
	for (const f of r.fehler) console.log(`FEHLER:  ${f}`);
	if (r.fehler.length) {
		console.log(`\n${r.fehler.length} Fehler, nichts eingespielt.`);
		return 1;
	}
	if (probelauf) {
		console.log(`\nProbelauf: ${r.faelle.length} Testfälle in Ordnung${config ? ' (mit --config wird nie eingespielt)' : ''}.`);
		return 0;
	}
	const { api } = require('./datatables-setup');
	await api('POST', `/data-tables/${tabelle.id}/rows`, { data: r.faelle, returnType: 'count' });
	console.log(`\n${r.faelle.length} Testfälle eingespielt. Danach EPA-T1 mit kunde_id = ${kunde} ausführen.`);
	return 0;
}

if (require.main === module) {
	main().then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(2); });
}

module.exports = { vorlageInhalt, csvSchreiben, BEISPIELE };
