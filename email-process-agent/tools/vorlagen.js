#!/usr/bin/env node
'use strict';
// Erzeugt die Config-Vorlagen für neue Kunden aus config/datatables/schema.json (Teil von npm run build):
//   config/datatables/vorlage-leer.json      leere Vorlage (alle Pflichtwerte als <Platzhalter>)
//   config/vorlagen/*.csv                    CSV-Dateien zum Import in die n8n Data Tables (leer und Beispiel)
// Solange Platzhalter <…> drinstehen, lehnt "EPA SW Config laden" die Config bewusst ab (424).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'datatables', 'schema.json'), 'utf8')).tabellen;
const beispiel = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'datatables', 'beispiel-transport.json'), 'utf8'));

// Leere Vorlage: was fachlich pro Kunde festgelegt werden muss, steht als Platzhalter; technische Standardwerte
// (Fristen, Schwellen, LLM-Profil) sind mit den empfohlenen Werten vorbelegt und können übernommen werden.
const ALLGEMEIN = {
	kunde_id: '<kunden-kuerzel, z. B. mueller-logistik>',
	aktiv: false,
	postfach: '<anfragen@kunde.de>',
	anrede_stil: 'Sie',
	sprache: 'de',
	signatur: '<Mit freundlichen Grüßen\nTeam …\nFirma …\nTel. …>',
	ki_hinweistext: 'Diese Nachricht wurde KI-gestützt vorbereitet und von einem Mitarbeiter geprüft und freigegeben.',
	frist_stunden: 48,
	frist_nur_geschaeftszeit: true,
	max_runden: 3,
	erinnerung_intervall_stunden: 24,
	anzahl_erinnerungen: 2,
	zeitzone: 'Europe/Berlin',
	geschaeftszeiten: '{"tage": [1, 2, 3, 4, 5], "von": "08:00", "bis": "17:00"}',
	feiertage_region: '<Bundesland-Kürzel, z. B. NW>',
	zusaetzliche_feiertage: '[]',
	benachrichtigung: '{"kanal": "teams", "team_id": "<TEAM_ID (GUID)>", "channel_id": "<CHANNEL_ID (19:…@thread.tacv2)>"}',
	freigeber: '["<freigeber@kunde.de>"]',
	vertreter: '[]',
	zustaendigkeit: '{}',
	absender_allowlist: '[]',
	absender_blocklist: '[]',
	konfidenz_schwelle: 0.75,
	zuordnung_schwellen: '{"eindeutig": 80, "abstand": 50, "neu": 40}',
	llm_profil: beispiel.epa_config_allgemein[0].llm_profil,
	prompt_versionen: '{"klassifizierung": "v1", "extraktion": "v1", "entwurf": "v1"}',
	archivordner: 'EPA-Archiv',
	aufbewahrung_tage: 365,
	anhang_limits: beispiel.epa_config_allgemein[0].anhang_limits,
	leerantwort_fristverlaengerung_stunden: 24,
	freigabe_erinnerung_stunden: 4,
	freigabe_ablauf_stunden: 48,
	postfach_workflow_id: '<ID der EPA-00-Kopie dieses Postfachs>',
	freigabe_basis_url: '',
	stille_alarm_stunden: 0,
	uebersetzungen: '',
};

const PFLICHTFELD = {
	kunde_id: '<kunden-kuerzel>',
	vorgangstyp: '<vorgangstyp, z. B. transport>',
	feldname: '<Feldname_ohne_Leerzeichen>',
	anzeigename: '<Anzeigename für Mitarbeiter>',
	typ: '<text | plz | datum | zahl | email | telefon | enum>',
	pflicht: true,
	validierungsregel: '{}',
	resolution_textbaustein: '<Fester Satz an den Kunden, z. B. "Bitte nennen Sie uns …">',
	extraktions_hinweis: '<Was die KI suchen soll>',
	platzhalter_muster: '[]',
	reihenfolge: 10,
	aktiv: true,
};

function pruefeVollstaendig(tabelle, zeile) {
	const soll = Object.keys(schema[tabelle]);
	const fehlt = soll.filter((k) => !(k in zeile));
	const zuviel = Object.keys(zeile).filter((k) => !soll.includes(k));
	if (fehlt.length || zuviel.length) throw new Error(`Vorlage ${tabelle}: fehlt [${fehlt}] zu viel [${zuviel}]`);
}

function csv(tabelle, zeilen) {
	const spalten = Object.keys(schema[tabelle]);
	const zelle = (v) => {
		if (v === null || v === undefined) return '';
		const s = typeof v === 'string' ? v : String(v);
		return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	return [spalten.join(','), ...zeilen.map((z) => spalten.map((s) => zelle(z[s])).join(','))].join('\n') + '\n';
}

function vorlagenBauen() {
	pruefeVollstaendig('epa_config_allgemein', ALLGEMEIN);
	pruefeVollstaendig('epa_config_pflichtfelder', PFLICHTFELD);
	for (const z of beispiel.epa_config_allgemein) pruefeVollstaendig('epa_config_allgemein', z);
	for (const z of beispiel.epa_config_pflichtfelder) pruefeVollstaendig('epa_config_pflichtfelder', z);
	const leer = {
		_hinweis: 'Leere Vorlage für einen neuen Kunden. Alle <Platzhalter> ersetzen, aktiv erst nach dem Test auf true setzen. Schritt-für-Schritt: docs/Onboarding-Neukunde.md',
		epa_config_allgemein: [ALLGEMEIN],
		epa_config_pflichtfelder: [PFLICHTFELD],
	};
	fs.writeFileSync(path.join(ROOT, 'config', 'datatables', 'vorlage-leer.json'), JSON.stringify(leer, null, 1) + '\n');
	const ordner = path.join(ROOT, 'config', 'vorlagen');
	fs.mkdirSync(ordner, { recursive: true });
	fs.writeFileSync(path.join(ordner, 'epa_config_allgemein_leer.csv'), csv('epa_config_allgemein', [ALLGEMEIN]));
	fs.writeFileSync(path.join(ordner, 'epa_config_pflichtfelder_leer.csv'), csv('epa_config_pflichtfelder', [PFLICHTFELD]));
	fs.writeFileSync(path.join(ordner, 'epa_config_allgemein_beispiel.csv'), csv('epa_config_allgemein', beispiel.epa_config_allgemein));
	fs.writeFileSync(path.join(ordner, 'epa_config_pflichtfelder_beispiel.csv'), csv('epa_config_pflichtfelder', beispiel.epa_config_pflichtfelder));
	return { ALLGEMEIN, PFLICHTFELD };
}

if (require.main === module) {
	vorlagenBauen();
	console.log('Vorlagen erzeugt: config/datatables/vorlage-leer.json, config/vorlagen/*.csv');
}

module.exports = { vorlagenBauen, ALLGEMEIN, PFLICHTFELD, csv };
