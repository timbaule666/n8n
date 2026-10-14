'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');
const { LOCK_SCHLUESSEL } = require('../../src/nachfassen');

const L = "$('Lauf vorbereiten').first().json";

module.exports = function () {
	const wf = new Workflow('EPA-04 Nachfassen und Eskalation');
	// Läuft höchstens 50 Minuten. Der Lauf-Lock gilt 55 Minuten und verfällt damit vor dem nächsten Lauf,
	// auch wenn ein Lauf abbricht, ohne ihn freizugeben.
	wf.settings.executionTimeout = 3000;

	wf.notiz('Notiz Zweck', [-120, -620], [
		'## EPA-04 Nachfassen und Eskalation (Phase E, Cronjob)',
		'**Zweck:** Stündlich überfällige Vorgänge und offene Freigaben finden und je Fall genau eine Aufgabe an "EPA SW Nachfassen" geben. Entschieden wird im Code (src/nachfassen.js), nicht durch die KI.',
		'**Fall 1:** "Warten auf Kunde", Frist abgelaufen, Erinnerungen < anzahl_erinnerungen → Erinnerungsentwurf mit Freigabe (EPA-02). Nach dem Versand: Frist = erinnerung_intervall_stunden, Zähler +1, Status wieder "Warten auf Kunde".',
		'**Fall 2:** Alle Erinnerungen gesendet und Frist wieder abgelaufen → "Eskaliert / Manuell" und Teams-Nachricht: bitte telefonisch kontaktieren.',
		'**Freigeber:** Nach freigabe_erinnerung_stunden Erinnerung mit neuem Link, nach freigabe_ablauf_stunden neue Links (alte ungültig). Nie automatischer Versand.',
		'**Geschäftszeiten:** Aufgaben eines Kunden laufen nur innerhalb seiner Geschäftszeiten (inkl. Feiertage); außerhalb wird nichts verloren, der nächste Lauf holt es nach.',
		'**Lauf-Lock:** Zeile "' + LOCK_SCHLUESSEL + '" in epa_system_status, atomar übernommen (bedingtes Update auf lock_bis < jetzt). Überlappende Läufe brechen sofort ab. Max. 50 Aufgaben je Lauf, der Rest folgt im nächsten Lauf.',
		'**Trigger:** Zeitplan stündlich (Minute 5; Intervall im Node "Stündlich" anpassbar, 1–2 h empfohlen). Zusätzlich Aufruf mit Eingabe "jetzt" für Tests und manuelle Läufe.',
	].join('\n'), { breite: 960, hoehe: 420 });

	const zeitplan = wf.node('Stündlich', 'n8n-nodes-base.scheduleTrigger', [0, -100], {
		rule: { interval: [{ field: 'hours', hoursInterval: 1, triggerAtMinute: 5 }] },
	});
	const manuell = wf.trigger('Bei Aufruf (Test/manuell)', [0, 100], [['jetzt', 'string']]);

	const vorbereiten = wf.code('Lauf vorbereiten', [220, 0], ['fehlerklassen'], `
// "jetzt" nur für Tests/manuelle Läufe überschreibbar (Fristen, Geschäftszeit). Der Lock nutzt immer die echte Zeit.
const e = $input.first().json || {};
const echt = new Date().toISOString();
let jetzt = echt;
if (typeof e.jetzt === 'string' && e.jetzt.trim()) {
	if (!Number.isFinite(new Date(e.jetzt).getTime())) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', null, 'Eingabe "jetzt" ist kein gültiger Zeitpunkt');
	jetzt = new Date(e.jetzt).toISOString();
}
return [{ json: { jetzt, echt, lauf_id: String($execution.id) } }];
`);
	const lockDaten = wf.code('Lock-Daten', [440, 0], ['nachfassen'], `
const l = $input.first().json;
return [{ json: nachfassen.lockHolen(l.lauf_id, l.echt) }];
`);
	const lockHolen = wf.tabelle('Lauf-Lock holen', [660, 0], 'update', 'epa_system_status', {
		bedingungen: [['schluessel', 'eq', LOCK_SCHLUESSEL], ['lock_bis', 'lt', `={{ ${L}.echt }}`]],
	}, { alwaysOutputData: true });
	const lockOk = wf.node('Lock erhalten?', 'n8n-nodes-base.if', [880, 0], {
		conditions: bedingungen([bedingung('={{ $json.lock_durch }}', { type: 'string', operation: 'equals' }, `={{ ${L}.lauf_id }}`)]),
		options: { looseTypeValidation: true },
	});

	// ---------------------------------------------------------------- Lock belegt (oder Zeile fehlt)
	const lockZeile = wf.tabelle('Lock-Zeile lesen', [1100, 260], 'get', 'epa_system_status', { bedingungen: [['schluessel', 'eq', LOCK_SCHLUESSEL]] }, { alwaysOutputData: true });
	const uebersprungen = wf.code('Lauf übersprungen', [1320, 260], [], `
const z = $input.first().json;
const fehlt = !(z && z.id !== undefined);
// Keine personenbezogenen Daten: nur Lauf-IDs und Zeitpunkte.
return [{ json: { ergebnis: fehlt ? 'lock_zeile_angelegt' : 'uebersprungen_lauf_aktiv', anlegen: fehlt, aktiver_lauf: fehlt ? null : z.lock_durch, lock_bis: fehlt ? null : z.lock_bis } }];
`);
	const anlegen = wf.node('Lock-Zeile anlegen?', 'n8n-nodes-base.if', [1540, 260], {
		conditions: bedingungen([bedingung('={{ $json.anlegen }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const neueZeile = wf.code('Lock-Zeile (neu)', [1760, 200], ['nachfassen'], `
// Erstinstallation ohne Setup-Skript: Zeile frei anlegen, der nächste Lauf arbeitet.
return [{ json: { schluessel: '${LOCK_SCHLUESSEL}', lock_bis: nachfassen.EPOCHE, lock_durch: '' } }];
`);
	const zeileSpeichern = wf.tabelle('Lock-Zeile speichern', [1980, 200], 'insert', 'epa_system_status');
	const ergUebersprungen = wf.code('Ergebnis: übersprungen', [2200, 260], [], `
const { anlegen, ...rest } = $('Lauf übersprungen').first().json;
return [{ json: rest }];
`);

	// ---------------------------------------------------------------- Lauf
	const vorgaenge = wf.tabelle('Überfällige Vorgänge lesen', [1100, -100], 'get', 'epa_vorgaenge', {
		bedingungen: [['status', 'eq', 'Warten auf Kunde'], ['antwort_frist', 'lt', `={{ ${L}.jetzt }}`]],
		alle: true,
	}, { alwaysOutputData: true, executeOnce: true });
	const freigaben = wf.tabelle('Offene Freigaben lesen', [1320, -100], 'get', 'epa_freigaben', {
		bedingungen: [['status', 'eq', 'offen']],
		alle: true,
	}, { alwaysOutputData: true, executeOnce: true });
	const configs = wf.tabelle('Configs lesen', [1540, -100], 'get', 'epa_config_allgemein', { alle: true }, { alwaysOutputData: true, executeOnce: true });
	const felder = wf.tabelle('Pflichtfelder lesen', [1760, -100], 'get', 'epa_config_pflichtfelder', {
		bedingungen: [['aktiv', 'isTrue']],
		alle: true,
	}, { alwaysOutputData: true, executeOnce: true });

	const planen = wf.code('Aufgaben planen', [1980, -100], ['configValidator', 'fristen', 'nachfassen'], `
const l = $('Lauf vorbereiten').first().json;
const zeilen = (n) => $(n).all().map((i) => i.json).filter((z) => z && z.id !== undefined);
const pflicht = zeilen('Pflichtfelder lesen');
const configs = {};
const ungueltig = [];
for (const a of zeilen('Configs lesen')) {
	if (a.aktiv !== true) { configs[a.kunde_id] = null; continue; }
	const r = configValidator.validiereConfig(a, pflicht.filter((p) => p.kunde_id === a.kunde_id), { zeitzoneGueltig: (zone) => DateTime.now().setZone(zone).isValid });
	if (r.gueltig) configs[a.kunde_id] = r.config;
	else ungueltig.push(a.kunde_id);
}
const plan = nachfassen.planen({ vorgaenge: zeilen('Überfällige Vorgänge lesen'), freigaben: zeilen('Offene Freigaben lesen'), configs, jetzt: l.jetzt, fristen });
return [{ json: { ...plan, ungueltige_configs: ungueltig } }];
`);
	const vorhanden = wf.node('Aufgaben vorhanden?', 'n8n-nodes-base.if', [2200, -100], {
		conditions: bedingungen([bedingung('={{ $json.aufgaben.length }}', { type: 'number', operation: 'gt' }, 0)]),
		options: {},
	});
	const aufteilen = wf.code('Aufgaben aufteilen', [2420, -180], [], `
const l = $('Lauf vorbereiten').first().json;
return $input.first().json.aufgaben.map((a) => ({ json: { ...a, jetzt: l.jetzt, referenz: 'EPA-04:' + l.lauf_id } }));
`);
	// Je Aufgabe ein eigener Aufruf: ein Fehler bei einem Vorgang hält die anderen nicht auf (Fehler protokolliert EPA-05).
	const ausfuehren = wf.aufruf('Nachfassen ausführen', [2640, -180], 'EPA SW Nachfassen', [
		['aktion', 'string', '={{ $json.aktion }}'],
		['kunde_id', 'string', '={{ $json.kunde_id }}'],
		['vorgangs_id', 'string', '={{ $json.vorgangs_id }}'],
		['freigabe_id', 'string', "={{ $json.freigabe_id || '' }}"],
		['jetzt', 'string', '={{ $json.jetzt }}'],
		['referenz', 'string', '={{ $json.referenz }}'],
	], { onError: 'continueRegularOutput', alwaysOutputData: true }, 'each');

	const abschliessen = wf.code('Lauf abschließen', [2860, -100], ['nachfassen'], `
const plan = $('Aufgaben planen').first().json;
const ergebnisse = $('Nachfassen ausführen').isExecuted ? $('Nachfassen ausführen').all().map((i) => i.json) : [];
const zusammenfassung = { ...nachfassen.laufAuswerten(plan, ergebnisse), ungueltige_configs: plan.ungueltige_configs };
return [{ json: nachfassen.lockFreigeben(new Date().toISOString(), zusammenfassung) }];
`);
	const lockFrei = wf.tabelle('Lauf-Lock freigeben', [3080, -100], 'update', 'epa_system_status', {
		bedingungen: [['schluessel', 'eq', LOCK_SCHLUESSEL], ['lock_durch', 'eq', `={{ ${L}.lauf_id }}`]],
	}, { alwaysOutputData: true });
	const ergebnis = wf.code('Ergebnis melden', [3300, -100], ['fehlerklassen'], `
const z = JSON.parse($('Lauf abschließen').first().json.letztes_ergebnis);
const plan = $('Aufgaben planen').first().json;
// Ungültige Config blockiert das Nachfassen dieses Kunden: laut melden (EPA-05), nicht still überspringen.
const blockiert = plan.uebersprungen.filter((u) => u.grund === 'keine_gueltige_config');
if (blockiert.length) {
	throw fehlerklassen.epaFehler('KONFIGURATIONSFEHLER', null, 'Nachfassen blockiert: Config ungültig oder fehlt für ' + [...new Set(blockiert.map((u) => u.kunde_id))].join(', ') + ' (' + blockiert.length + ' Aufgabe(n) offen)');
}
return [{ json: { ergebnis: 'lauf_beendet', ...z } }];
`);

	wf.kette(zeitplan, vorbereiten);
	wf.kette(manuell, vorbereiten);
	wf.kette(vorbereiten, lockDaten, lockHolen, lockOk);
	wf.verbinde(lockOk, vorgaenge, 0);
	wf.verbinde(lockOk, lockZeile, 1);
	wf.kette(lockZeile, uebersprungen, anlegen);
	wf.verbinde(anlegen, neueZeile, 0);
	wf.verbinde(anlegen, ergUebersprungen, 1);
	wf.kette(neueZeile, zeileSpeichern, ergUebersprungen);
	wf.kette(vorgaenge, freigaben, configs, felder, planen, vorhanden);
	wf.verbinde(vorhanden, aufteilen, 0);
	wf.verbinde(vorhanden, abschliessen, 1);
	wf.kette(aufteilen, ausfuehren, abschliessen, lockFrei, ergebnis);
	return wf;
};
