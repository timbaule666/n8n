'use strict';
const { Workflow } = require('../tools/lib/n8n');

module.exports = function () {
	const wf = new Workflow('EPA SW Audit schreiben');

	wf.notiz('Notiz Zweck', [-80, -320], [
		'## EPA SW Audit schreiben',
		'**Zweck:** Append-only-Eintrag in epa_audit_log (Merges, Freigabe-Entscheidungen, Zuordnungen, Systemereignisse). Statuswechsel schreibt "EPA SW Status setzen" selbst.',
		'**Trigger:** Aufruf durch andere Workflows.',
		'**Eingaben:** kunde_id, vorgangs_id (optional), typ (STATUS | MERGE | FREIGABE | ZUORDNUNG | DEDUPE | SYSTEM), alt, neu, ausloeser, details (Objekt), referenz.',
		'**Ausgabe:** { audit_id, zeitstempel }',
		'**Hinweis:** Die Tabelle verhindert UPDATE/DELETE per Trigger.',
	].join('\n'), { breite: 600, hoehe: 260 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['kunde_id', 'string'],
		['vorgangs_id', 'string'],
		['typ', 'string'],
		['alt', 'string'],
		['neu', 'string'],
		['ausloeser', 'string'],
		['details', 'object'],
		['referenz', 'string'],
	]);

	const pruefen = wf.code('Eintrag prüfen', [220, 0], ['fehlerklassen', 'statusMatrix'], `
const TYPEN = ['STATUS', 'MERGE', 'FREIGABE', 'ZUORDNUNG', 'DEDUPE', 'SYSTEM'];
const e = $input.first().json;
const vorgangsId = typeof e.vorgangs_id === 'string' && e.vorgangs_id.trim() ? e.vorgangs_id.trim() : null;
if (typeof e.kunde_id !== 'string' || !e.kunde_id.trim()) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', vorgangsId, 'kunde_id fehlt');
if (!TYPEN.includes(e.typ)) throw fehlerklassen.epaFehler('UNGUELTIGES_FORMAT', vorgangsId, \`Audit-Typ "\${e.typ}" ist unbekannt\`);
if (!statusMatrix.ausloeserTyp(e.ausloeser)) throw fehlerklassen.epaFehler('UNGUELTIGER_AUSLOESER', vorgangsId, \`Auslöser "\${e.ausloeser}" ist ungültig\`);
const text = (w) => (w === undefined || w === null || w === '' ? null : String(w));
return [{ json: {
	kunde_id: e.kunde_id.trim(),
	vorgangs_id: vorgangsId,
	typ: e.typ,
	alt: text(e.alt),
	neu: text(e.neu),
	ausloeser: e.ausloeser.trim(),
	details: e.details && typeof e.details === 'object' && !Array.isArray(e.details) ? e.details : {},
	referenz: text(e.referenz) ?? String($execution.id),
} }];
`);

	const schreiben = wf.postgres('Audit schreiben', [440, 0], 'audit_schreiben',
		'[ $json.kunde_id, $json.vorgangs_id, $json.typ, $json.alt, $json.neu, $json.ausloeser, $json.details, $json.referenz ]',
		{ retryOnFail: false });

	wf.kette(trigger, pruefen, schreiben);
	return wf;
};
