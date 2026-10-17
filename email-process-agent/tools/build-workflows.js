#!/usr/bin/env node
'use strict';
// Erzeugt die Workflow-JSONs aus workflows-src/<variante>/*.js (bettet src/-Module und SQL ein).
//   workflows/           Speicher: n8n Data Tables (Standard)
//   workflows-postgres/  Speicher: PostgreSQL
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./lib/n8n');

const M1 = [
	['sw-config-laden', 'EPA_SW_Config_laden.json'],
	['sw-audit-schreiben', 'EPA_SW_Audit_schreiben.json'],
	['sw-status-setzen', 'EPA_SW_Status_setzen.json'],
	['sw-vorgang-verwalten', 'EPA_SW_Vorgang_verwalten.json'],
	['epa-05-error-handler', 'EPA-05_Error-Handler.json'],
];
const M2 = [
	['sw-llm-aufrufen', 'EPA_SW_LLM_aufrufen.json'],
	['sw-benachrichtigen', 'EPA_SW_Benachrichtigen.json'],
	['epa-01-eingang-verarbeiten', 'EPA-01_Eingang_verarbeiten.json'],
	['epa-00-postfach', 'EPA-00_Postfach_Vorlage.json'],
	['sw-freigabe-senden', 'EPA_SW_Freigabe_senden.json'],
	['epa-02-rueckfrage', 'EPA-02_Rueckfrage_anfordern.json'],
	['epa-07-freigabe', 'EPA-07_Freigabe-Endpunkt.json'],
	['epa-03-antwort', 'EPA-03_Antwort_verarbeiten.json'],
	['sw-nachfassen', 'EPA_SW_Nachfassen.json'],
	['sw-kategorie', 'EPA_SW_Outlook-Kategorie.json'],
	['epa-04-nachfassen', 'EPA-04_Nachfassen_und_Eskalation.json'],
	['epa-06-watchdog', 'EPA-06_Watchdog.json'],
	['epa-08-loeschjob', 'EPA-08_Loeschjob.json'],
	// Kunden-Regeln aus Google Sheets
	['sw-regeln-abgleichen', 'EPA_SW_Regeln_abgleichen.json'],
	['epa-09-regeln-sheets', 'EPA-09_Regeln_aus_Google_Sheets.json'],
	['epa-10-regel-sheet-anlegen', 'EPA-10_Regel-Sheet_anlegen.json'],
	['epa-11-zustelltest', 'EPA-11_Zustelltest.json'],
	// Übersicht je Kunde (geheimer Link) und tägliche Zusammenfassung
	['epa-12-uebersicht', 'EPA-12_Uebersicht-Seite.json'],
	['epa-13-tagesuebersicht', 'EPA-13_Tagesuebersicht.json'],
	// Testphase: KI-Qualitäts-Prüfstand (keine Nebenwirkungen)
	['epa-t1-ki-qualitaet', 'EPA-T1_KI-Qualitaet_pruefen.json'],
	// Nur interne Tests ohne Microsoft-365-Lizenz (Kunden nutzen Teams)
	['epa-t2-telegram', 'EPA-T2_Telegram_senden_Test.json'],
];
// Die Postgres-Variante bleibt auf dem Stand von M1 (Speicher-Standard sind Data Tables).
const DATEIEN = { datatable: [...M1, ...M2], postgres: M1 }; // M2 enthält ab M3 auch EPA-02/EPA-07
const VARIANTEN = { datatable: 'workflows', postgres: 'workflows-postgres' };

function bauen() {
	const ergebnis = [];
	for (const [variante, ordner] of Object.entries(VARIANTEN)) {
		const ziel = path.join(ROOT, ordner);
		fs.mkdirSync(ziel, { recursive: true });
		for (const [quelle, datei] of DATEIEN[variante]) {
			const json = require(path.join(ROOT, 'workflows-src', variante, `${quelle}.js`))().json();
			fs.writeFileSync(path.join(ziel, datei), JSON.stringify(json, null, 2) + '\n');
			ergebnis.push({ ordner, datei, name: json.name, nodes: json.nodes.length });
		}
	}
	// Prompts als Datei für den Import in die Data Table epa_prompts (Quelle bleibt prompts/<version>/*.md)
	const { allePrompts } = require('./lib/prompts');
	fs.writeFileSync(path.join(ROOT, 'config', 'datatables', 'prompts.json'), JSON.stringify(allePrompts(), null, 1) + '\n');
	// Config-Vorlagen (leer und CSV) aus dem Schema
	require('./vorlagen').vorlagenBauen();
	return ergebnis;
}

if (require.main === module) {
	for (const r of bauen()) console.log(`${(r.ordner + '/' + r.datei).padEnd(52)} ${String(r.nodes).padStart(3)} Nodes`);
}

module.exports = { bauen, DATEIEN, VARIANTEN };
