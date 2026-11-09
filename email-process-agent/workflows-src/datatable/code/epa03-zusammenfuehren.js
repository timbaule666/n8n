const config = $('Config laden').first().json.config;
const v = $('Vorgang lesen').first().json.vorgang;
const mail = $('Bei Aufruf').first().json.mail;
const llm = $('Daten extrahieren').first().json;
const plzInfo = $input.first().json;
const felder = config.vorgangstypen[v.vorgangstyp];
if (!llm.ok) return [{ json: { weg: 'extraktion_fehlgeschlagen', fehlercode: llm.code, fehler: llm.fehler } }];
const heute = DateTime.now().setZone(config.zeitzone).toISODate();
const neu = pflichtfelder.pruefen(llm.ergebnis.felder, felder, { heute, quelltext: pflichtfelder.quelltextAus(mail), absenderName: mail.absender_name, plzInfo });
const m = antwort.zusammenfuehren(v.extrahierte_daten, neu, felder, {
	istPlatzhalter: pflichtfelder.istPlatzhalter, konflikteBisher: v.konflikte, message_id: mail.message_id, runde: Number(v.rundenzaehler || 0),
	// Name des Antwortenden bzw. des ursprünglichen Absenders (z. B. Weiterleitender) ist kein neuer Ansprechpartner
	absenderNamen: [mail.absender_name, v.absender_name],
});
const ent = antwort.entscheiden(m, v);
let fristNeu = null;
if (ent.weg === 'keine_daten' && v.status === 'Warten auf Kunde' && Number(config.leerantwort_fristverlaengerung_stunden) > 0) {
	const kandidat = fristen.berechneFrist(new Date().toISOString(), config.leerantwort_fristverlaengerung_stunden, config);
	const f = antwort.fristVerlaengern(v.antwort_frist, kandidat);
	if (f !== v.antwort_frist) fristNeu = f;
}
// KI-Einschätzung + feste Musterprüfung (eingang.manipulationBewerten). Bestätigter Verdacht: keine neue Rückfrage,
// keine Freigabe, Vorgang auf "Eskaliert / Manuell" – nur die Systemwarnung (EPA-01), ein Mensch prüft.
// Meldet nur die KI etwas, wird die Antwort normal ausgewertet und die Meldung trägt einen Hinweis.
const bewertung = eingang.manipulationBewerten(llm.ergebnis.verdacht_manipulation === true, mail);
const sperren = bewertung.stufe === 'sperren';
const manipulation = sperren;
// Wichtige Zusatzinformation aus der Antwort (z. B. Gefahrgut, Hebebühne): immer melden, auch ohne neue Feldwerte.
const besonderheiten = typeof llm.ergebnis.besonderheiten === 'string' && llm.ergebnis.besonderheiten.trim() ? llm.ergebnis.besonderheiten.trim().slice(0, 400) : null;
return [{ json: {
	weg: ent.weg === 'keine_daten' && !sperren ? 'keine_daten' : 'auswerten',
	ergebnis: sperren ? 'manipulation' : ent.weg,
	zielstatus: sperren ? 'Eskaliert / Manuell' : ent.zielstatus,
	freigabe_ersetzen: ent.freigabe_ersetzen,
	merge: m,
	frist_neu: fristNeu,
	verdacht_manipulation: manipulation,
	manipulation_hinweis: bewertung.stufe === 'hinweis',
	manipulation: bewertung,
	besonderheiten,
	speichern: { extrahierte_daten: m.daten, fehlende_felder: m.fehlende, konflikte: m.konflikte },
	details: {
		anlass: 'Kundenantwort', message_id: mail.message_id,
		uebernommen: m.uebernommen.map((u) => u.feldname), konflikte_neu: m.konflikte_neu.map((k) => k.feldname),
		fehlende: m.fehlende.map((f) => f.feldname), verdacht_manipulation: manipulation, manipulation: bewertung, besonderheiten,
		llm: { modell: llm.modell, prompt_version: llm.prompt_version, versuche: llm.versuche, korrekturen: llm.korrekturen },
	},
} }];
