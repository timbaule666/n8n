const config = $('Config laden').first().json.config;
const k = $('Klasse auswerten').first().json;
const n = $('Mail normalisieren').first().json;
const llm = $('Daten extrahieren').first().json;
const plzInfo = $input.first().json;
const felder = config.vorgangstypen[k.vorgangstyp];
if (!llm.ok) {
	return [{ json: {
		weg: 'extraktion_fehlgeschlagen', status: 'Eskaliert / Manuell', fehlercode: llm.code,
		speichern: { vorgangstyp: k.vorgangstyp, sprache: k.details.sprache || null },
		details: { grund: 'Extraktion fehlgeschlagen', fehlercode: llm.code, fehler: llm.fehler },
	} }];
}
const p = pflichtfelder.pruefen(llm.ergebnis.felder, felder, { heute: n.heute, quelltext: pflichtfelder.quelltextAus(n.mail), absenderName: n.mail.absender_name, plzInfo });
const kiVerdacht = llm.ergebnis.verdacht_manipulation === true || k.details.verdacht_manipulation === true;
// KI-Einschätzung + feste Musterprüfung: Bei bestätigtem Verdacht keine Rückfrage, keine Freigabe – nur die
// Systemwarnung, ein Mensch prüft die Mail. Meldet nur die KI etwas, läuft die Mail normal mit Hinweis weiter.
const bewertung = eingang.manipulationBewerten(kiVerdacht, n.mail);
const manipulation = bewertung.stufe === 'sperren';
const weg = manipulation ? 'manipulation' : p.vollstaendig ? 'bereit' : 'luecken';
return [{ json: {
	weg,
	status: { manipulation: 'Eskaliert / Manuell', bereit: 'Bereit zur Bearbeitung', luecken: 'Lücken erkannt' }[weg],
	pruefung: p,
	besonderheiten: typeof llm.ergebnis.besonderheiten === 'string' ? llm.ergebnis.besonderheiten : null,
	verdacht_manipulation: manipulation,
	manipulation_hinweis: bewertung.stufe === 'hinweis',
	manipulation_quellen: eingang.manipulationQuellen(bewertung, k.details.verdacht_manipulation === true ? 'Klassifizierung' : 'Datenauslesen'),
	speichern: { vorgangstyp: k.vorgangstyp, sprache: k.details.sprache || null, extrahierte_daten: p.daten, fehlende_felder: p.fehlende },
	details: {
		fehlende: p.fehlende.map((f) => f.feldname),
		verworfen: p.hinweise.map((f) => f.feldname),
		unsicher: p.unsicher.map((f) => f.feldname),
		verdacht_manipulation: manipulation,
		manipulation: bewertung,
		llm: { modell: llm.modell, prompt_version: llm.prompt_version, versuche: llm.versuche, korrekturen: llm.korrekturen },
	},
} }];
