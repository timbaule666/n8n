'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const P = "$('Löschplan').first().json";
const KEINER = '__keiner__';

module.exports = function () {
	const wf = new Workflow('EPA-08 Löschjob');
	wf.settings.timezone = 'Europe/Berlin';

	wf.notiz('Notiz Zweck', [-120, -620], [
		'## EPA-08 Löschjob (Datenschutz, Phase F)',
		'**Zweck:** Löscht Daten nach Ablauf der Aufbewahrung (src/loeschen.js). Nichts wird gelöscht, was noch bearbeitet wird.',
		'**Vorgänge:** nur Status "Abgeschlossen" oder "Ignoriert" und seit aufbewahrung_tage (Config je Kunde) unverändert. Danach die zugehörigen Freigaben, Freigabe-Links und Audit-Einträge. Offene und eskalierte Vorgänge bleiben immer erhalten.',
		'**Weitere Daten:** Dedupe-Einträge (epa_verarbeitete_mails) nach aufbewahrung_tage, Fehlerlog nach 90 Tagen.',
		'**Postfach:** Ersetzte Rückfrage-Entwürfe (nie gesendet, nicht mehr gültig) werden über die EPA-00-Kopie gelöscht, aber nur, wenn es nachweislich ein Entwurf mit der passenden Freigabe-Kennung ist (landet in "Gelöschte Elemente"). Eingegangene Mails werden nie gelöscht.',
		'**Grenzen je Lauf:** 200 Vorgänge, 50 Entwürfe; der Rest folgt in der nächsten Nacht. Ergebnis (nur Zähler) in epa_system_status, Zeile "loeschjob".',
		'**Trigger:** täglich 02:15 (Europe/Berlin). Zusätzlich Aufruf mit "jetzt" und "probelauf" (true = nur anzeigen, nichts löschen).',
		'**Nicht hier:** n8n-Ausführungsdaten (enthalten Mail-Inhalte) über die Aufbewahrung in den n8n-Einstellungen begrenzen, siehe Inbetriebnahme.',
	].join('\n'), { breite: 960, hoehe: 420 });

	const zeitplan = wf.node('Täglich nachts', 'n8n-nodes-base.scheduleTrigger', [0, -100], {
		rule: { interval: [{ field: 'cronExpression', expression: '15 2 * * *' }] },
	});
	const manuell = wf.trigger('Bei Aufruf (Test/manuell)', [0, 100], [['jetzt', 'string'], ['probelauf', 'boolean']]);
	const vorbereiten = wf.code('Lauf vorbereiten', [220, 0], ['fehlerklassen'], `
const e = $input.first().json || {};
let jetzt = new Date().toISOString();
if (typeof e.jetzt === 'string' && e.jetzt.trim()) {
	if (!Number.isFinite(new Date(e.jetzt).getTime())) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', null, 'Eingabe "jetzt" ist kein gültiger Zeitpunkt');
	jetzt = new Date(e.jetzt).toISOString();
}
return [{ json: { jetzt, probelauf: e.probelauf === true } }];
`);
	const einmal = { alwaysOutputData: true, executeOnce: true };
	const vorgaenge = wf.tabelle('Abgeschlossene Vorgänge lesen', [440, 0], 'get', 'epa_vorgaenge', {
		match: 'anyCondition',
		bedingungen: [['status', 'eq', 'Abgeschlossen'], ['status', 'eq', 'Ignoriert']],
		alle: true,
	}, einmal);
	const freigaben = wf.tabelle('Freigaben lesen', [660, 0], 'get', 'epa_freigaben', { alle: true }, einmal);
	const configs = wf.tabelle('Configs lesen', [880, 0], 'get', 'epa_config_allgemein', { alle: true }, einmal);

	const plan = wf.code('Löschplan', [1100, 0], ['loeschen'], `
// Auch inaktive Kunden: die Aufbewahrungsfrist gilt weiter. Ohne gültige Frist wird für den Kunden nichts gelöscht.
const l = $('Lauf vorbereiten').first().json;
const zeilen = (n) => $(n).all().map((i) => i.json).filter((z) => z && z.id !== undefined);
const configs = {};
for (const c of zeilen('Configs lesen')) {
	const pwf = /^[A-Za-z0-9]{8,32}$/.test(String(c.postfach_workflow_id || '')) ? c.postfach_workflow_id : null;
	const postfach = /^[^@<>\\s]+@[^@<>\\s]+$/.test(String(c.postfach || '')) ? String(c.postfach).toLowerCase() : null;
	configs[c.kunde_id] = { aufbewahrung_tage: Number(c.aufbewahrung_tage), postfach, postfach_workflow_id: pwf };
}
const p = loeschen.planen({ jetzt: l.jetzt, vorgaenge: zeilen('Abgeschlossene Vorgänge lesen'), freigaben: zeilen('Freigaben lesen'), configs });
const grenzen = {};
for (const g of p.mail_grenzen) grenzen[g.kunde_id] = g.grenze;
return [{ json: { ...p, grenzen, probelauf: l.probelauf, zusammenfassung: loeschen.zusammenfassung(p) } }];
`);
	const probe = wf.node('Probelauf?', 'n8n-nodes-base.if', [1320, 0], {
		conditions: bedingungen([bedingung('={{ $json.probelauf }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const probeErgebnis = wf.code('Ergebnis: Probelauf', [1540, -200], [], `
const p = $('Löschplan').first().json;
return [{ json: { ergebnis: 'probelauf', ...p.zusammenfassung, vorgaenge_ids: p.vorgaenge.map((v) => v.vorgangs_id), entwuerfe_freigaben: p.entwuerfe.map((e) => e.freigabe_id) } }];
`);

	// ---------------------------------------------------------------- 1. ersetzte Entwürfe im Postfach
	const entwuerfe = wf.code('Entwürfe aufteilen', [1540, 0], [], `
const p = $('Löschplan').first().json;
return p.entwuerfe.length ? p.entwuerfe.map((e) => ({ json: { ...e, vorhanden: true } })) : [{ json: { vorhanden: false } }];
`);
	const entwurfDa = wf.node('Entwürfe zu löschen?', 'n8n-nodes-base.if', [1760, 0], {
		conditions: bedingungen([bedingung('={{ $json.vorhanden }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const entwurfLoeschen = wf.aufrufDynamisch('Entwurf im Postfach löschen', [1980, -100], '={{ $json.postfach_workflow_id }}', [
		['aktion', 'string', 'entwurf_loeschen'],
		['postfach', 'string', '={{ $json.postfach }}'],
		['graph_id', 'string', ''],
		['internet_message_id', 'string', ''],
		['entwurf_id', 'string', '={{ $json.entwurf_id }}'],
		['freigabe_id', 'string', '={{ $json.freigabe_id }}'],
		['vorgangs_id', 'string', '={{ $json.vorgangs_id }}'],
		['html', 'string', ''],
	], { onError: 'continueRegularOutput', alwaysOutputData: true }, 'each');
	const entwurfDaten = wf.code('Entwürfe vermerken (Daten)', [2200, -100], [], `
// Erledigt = gelöscht, schon weg oder kein passender Entwurf (dann nie wieder anfassen). Fehler: nächste Nacht erneut.
const auftraege = $('Entwürfe aufteilen').all().map((i) => i.json);
const jetzt = new Date().toISOString();
const erledigt = $input.all().map((it, i) => ({ r: it.json || {}, a: auftraege[i] })).filter((x) => x.a && !x.r.error && x.r.erledigt === true);
return erledigt.length ? erledigt.map((x) => ({ json: { freigabe_id: x.a.freigabe_id, entwurf_entfernt_am: jetzt } })) : [{ json: { freigabe_id: '${KEINER}', entwurf_entfernt_am: jetzt } }];
`);
	const entwurfVermerken = wf.tabelle('Entwürfe vermerken', [2420, -100], 'update', 'epa_freigaben', {
		bedingungen: [['freigabe_id', 'eq', '={{ $json.freigabe_id }}'], ['status', 'eq', 'ersetzt']],
	}, { alwaysOutputData: true });

	// ---------------------------------------------------------------- 2. Vorgänge (mit Sicherung: unverändert seit der Frist)
	const vAuftraege = wf.code('Vorgänge (Aufträge)', [2640, 0], [], `
const p = $('Löschplan').first().json;
const liste = p.vorgaenge.map((v) => ({ json: { ...v, grenze: p.grenzen[v.kunde_id] } }));
return liste.length ? liste : [{ json: { kunde_id: '${KEINER}', vorgangs_id: '${KEINER}', grenze: new Date(0).toISOString() } }];
`, { executeOnce: true });
	const vLoeschen = wf.tabelle('Vorgänge löschen', [2860, 0], 'deleteRows', 'epa_vorgaenge', {
		bedingungen: [['kunde_id', 'eq', '={{ $json.kunde_id }}'], ['vorgangs_id', 'eq', '={{ $json.vorgangs_id }}'], ['updatedAt', 'lt', '={{ $json.grenze }}']],
	}, { alwaysOutputData: true });

	// ---------------------------------------------------------------- 3. abhängige Daten nur der tatsächlich gelöschten Vorgänge
	// Nur Vorgänge, die "Vorgänge löschen" tatsächlich entfernt hat (die Ausgabe sind die gelöschten Zeilen).
	const geloeschteVorgaenge = `const weg = new Set($('Vorgänge löschen').all().map((i) => i.json).filter((z) => z && z.id !== undefined).map((z) => z.kunde_id + '|' + z.vorgangs_id));`;
	const tAuftraege = wf.code('Links (Aufträge)', [3080, 0], [], `
${geloeschteVorgaenge}
const p = $('Löschplan').first().json;
const liste = p.freigaben.filter((f) => weg.has(f.kunde_id + '|' + f.vorgangs_id)).map((f) => ({ json: { kunde_id: f.kunde_id, freigabe_id: f.freigabe_id } }));
return liste.length ? liste : [{ json: { kunde_id: '${KEINER}', freigabe_id: '${KEINER}' } }];
`, { executeOnce: true });
	const tLoeschen = wf.tabelle('Links löschen', [3300, 0], 'deleteRows', 'epa_freigabe_tokens', {
		bedingungen: [['kunde_id', 'eq', '={{ $json.kunde_id }}'], ['freigabe_id', 'eq', '={{ $json.freigabe_id }}']],
	}, { alwaysOutputData: true });
	const abhaengig = `${geloeschteVorgaenge}
const liste = [...weg].map((k) => { const [kunde_id, vorgangs_id] = k.split('|'); return { json: { kunde_id, vorgangs_id } }; });
return liste.length ? liste : [{ json: { kunde_id: '${KEINER}', vorgangs_id: '${KEINER}' } }];`;
	const fAuftraege = wf.code('Freigaben (Aufträge)', [3520, 0], [], abhaengig, { executeOnce: true });
	const fLoeschen = wf.tabelle('Freigaben löschen', [3740, 0], 'deleteRows', 'epa_freigaben', {
		bedingungen: [['kunde_id', 'eq', '={{ $json.kunde_id }}'], ['vorgangs_id', 'eq', '={{ $json.vorgangs_id }}']],
	}, { alwaysOutputData: true });
	const aAuftraege = wf.code('Audit (Aufträge)', [3960, 0], [], abhaengig, { executeOnce: true });
	const aLoeschen = wf.tabelle('Audit löschen', [4180, 0], 'deleteRows', 'epa_audit_log', {
		bedingungen: [['kunde_id', 'eq', '={{ $json.kunde_id }}'], ['vorgangs_id', 'eq', '={{ $json.vorgangs_id }}']],
	}, { alwaysOutputData: true });

	// ---------------------------------------------------------------- 4. Dedupe-Einträge und Fehlerlog nach Frist
	const mAuftraege = wf.code('Dedupe (Aufträge)', [4400, 0], [], `
const p = $('Löschplan').first().json;
const liste = p.mail_grenzen.map((g) => ({ json: g }));
return liste.length ? liste : [{ json: { kunde_id: '${KEINER}', grenze: new Date(0).toISOString() } }];
`, { executeOnce: true });
	const mLoeschen = wf.tabelle('Dedupe-Einträge löschen', [4620, 0], 'deleteRows', 'epa_verarbeitete_mails', {
		bedingungen: [['kunde_id', 'eq', '={{ $json.kunde_id }}'], ['createdAt', 'lt', '={{ $json.grenze }}']],
	}, { alwaysOutputData: true });
	const feAuftrag = wf.code('Fehlerlog (Auftrag)', [4840, 0], [], `
return [{ json: { grenze: $('Löschplan').first().json.fehler_grenze } }];
`, { executeOnce: true });
	const feLoeschen = wf.tabelle('Fehlerlog löschen', [5060, 0], 'deleteRows', 'epa_fehler_log', {
		bedingungen: [['createdAt', 'lt', '={{ $json.grenze }}']],
	}, { alwaysOutputData: true });

	const abschluss = wf.code('Lauf abschließen', [5280, 0], [], `
// Nur Zähler speichern, keine Inhalte.
const zahl = (n) => $(n).isExecuted ? $(n).all().filter((i) => i.json && i.json.id !== undefined).length : 0;
const p = $('Löschplan').first().json;
const ergebnis = {
	vorgaenge: zahl('Vorgänge löschen'), freigaben: zahl('Freigaben löschen'), links: zahl('Links löschen'), audit: zahl('Audit löschen'),
	dedupe: zahl('Dedupe-Einträge löschen'), fehlerlog: zahl('Fehlerlog löschen'), entwuerfe: zahl('Entwürfe vermerken'),
	zurueckgestellt: p.zurueckgestellt, verschoben: p.verschoben, ohne_config: p.ohne_config,
};
return [{ json: { schluessel: 'loeschjob', letzter_lauf: new Date().toISOString(), letztes_ergebnis: JSON.stringify(ergebnis) } }];
`, { executeOnce: true });
	const vermerken = wf.tabelle('Ergebnis vermerken', [5500, 0], 'upsert', 'epa_system_status', { bedingungen: [['schluessel', 'eq', 'loeschjob']] });
	const ergebnis = wf.code('Ergebnis melden', [5720, 0], [], `
return [{ json: { ergebnis: 'geloescht', ...JSON.parse($('Lauf abschließen').first().json.letztes_ergebnis) } }];
`);

	wf.kette(zeitplan, vorbereiten);
	wf.kette(manuell, vorbereiten);
	wf.kette(vorbereiten, vorgaenge, freigaben, configs, plan, probe);
	wf.verbinde(probe, probeErgebnis, 0);
	wf.verbinde(probe, entwuerfe, 1);
	wf.kette(entwuerfe, entwurfDa);
	wf.verbinde(entwurfDa, entwurfLoeschen, 0);
	wf.verbinde(entwurfDa, vAuftraege, 1);
	wf.kette(entwurfLoeschen, entwurfDaten, entwurfVermerken, vAuftraege);
	wf.kette(vAuftraege, vLoeschen, tAuftraege, tLoeschen, fAuftraege, fLoeschen, aAuftraege, aLoeschen, mAuftraege, mLoeschen, feAuftrag, feLoeschen, abschluss, vermerken, ergebnis);
	return wf;
};
