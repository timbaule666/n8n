'use strict';
// Teams-Kanäle je Kunde (gleich bei jedem Kunden). Jede Meldung trägt einen "anlass"; diese Tabelle legt fest,
// in welchen Kanal sie gehört. Neue Meldungsarten MÜSSEN hier eingetragen werden (test/kanaele.test.js prüft das).

const KANAELE = Object.freeze([
	{ art: 'anfragen', name: '1 Vollständige Anfragen', text: 'Anfragen, Bestellungen, Termine und Reklamationen mit allen Pflichtangaben – bereit zur Bearbeitung' },
	{ art: 'rueckfragen', name: '2 Rückfragen', text: 'Offene Rückfragen an Kunden freigeben, bearbeiten oder ablehnen; Antworten mit weiter fehlenden Angaben' },
	{ art: 'warten', name: '3 Warten auf Kunde', text: 'Rückfrage ist verschickt, die Antwort des Kunden steht aus. Die Karte verschwindet, sobald der Kunde antwortet.' },
	{ art: 'ansehen', name: '4 Bitte ansehen', text: 'Keine normale Anfrage, aber ein Mitarbeiter muss entscheiden: Stornierung, Reklamation, Rückruf, Manipulationsverdacht, Kunde reagiert nicht, Unklares' },
	{ art: 'system', name: '5 Systemmeldungen', text: 'Technik und Betrieb: Zustellfehler, Zustelltest, Regel-Abgleich, Tagesübersicht' },
	{ art: 'logs', name: '6 Logs', text: 'Protokoll: eine Abschlusskarte pro Vorgang' },
]);
const ARTEN = KANAELE.map((k) => k.art);

/** anlass -> Kanal. Feste Einträge zuerst, danach Präfixe. */
const ZUORDNUNG = Object.freeze({
	// Vollständig
	bereit: 'anfragen',
	antwort_bereit: 'anfragen',
	kalender_frei: 'anfragen',
	kalender_belegt: 'anfragen',
	kalender_keine_freie_zeit: 'anfragen',
	// Rückfrage verschickt, Antwort steht aus (Karte wird beim Eingang der Antwort entfernt)
	rueckfrage_verschickt: 'warten',
	// Wartet auf Freigabe
	freigabe: 'rueckfragen',
	luecken: 'rueckfragen',
	antwort_luecken: 'rueckfragen',
	antwort_keine_daten: 'rueckfragen',
	// Ein Mensch muss entscheiden
	antwort_gemeldet: 'ansehen',
	antwort_storno: 'ansehen',
	antwort_zusatzinfo: 'ansehen',
	antwort_manipulation: 'ansehen',
	manipulation: 'ansehen',
	systemwarnung_manipulation: 'ansehen',
	zuordnung_unklar: 'ansehen',
	klassifizierung_unklar: 'ansehen',
	weiteres_anliegen: 'ansehen',
	extraktion_fehlgeschlagen: 'ansehen',
	max_runden: 'ansehen',
	keine_reaktion: 'ansehen',
	nicht_zugestellt: 'ansehen',
	// Technik und Betrieb
	freigabe_nicht_zugestellt: 'system',
	zustelltest_fehlgeschlagen: 'system',
	regeln_google_sheet: 'system',
	tagesuebersicht: 'system',
	// Betreiber-Info: Entwurf wurde direkt in Outlook gesendet (die Warten-Karte kommt trotzdem)
	manuell_gesendet: 'system',
	kalender_kalender_fehler: 'system',
	// Protokoll
	log_karte: 'logs',
});
const PRAEFIXE = Object.freeze([
	['keine_anfrage_', 'ansehen'],
]);

/** Kanal-Art für einen Anlass. Unbekannt -> system (fällt auf, landet nicht bei den Sachbearbeitern). */
function kanalArt(anlass) {
	const a = String(anlass || '').trim();
	if (Object.prototype.hasOwnProperty.call(ZUORDNUNG, a)) return ZUORDNUNG[a];
	for (const [p, art] of PRAEFIXE) if (a.startsWith(p)) return art;
	return 'system';
}

function istBekannt(anlass) {
	const a = String(anlass || '');
	return Object.prototype.hasOwnProperty.call(ZUORDNUNG, a) || PRAEFIXE.some(([p]) => a.startsWith(p));
}

/** Config-Wert kanaele (JSON-Text oder Objekt) lesen. */
function lesen(kanaele) {
	if (!kanaele) return {};
	if (typeof kanaele === 'object') return kanaele;
	try { const o = JSON.parse(kanaele); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
}

/**
 * Channel-ID für einen Anlass. Ältere Configs ohne "ansehen"/"warten": dann der Systemkanal; ohne kanaele: '' (der Aufrufer
 * nimmt dann benachrichtigung.channel_id).
 */
function kanalId(kanaele, anlass) {
	const k = lesen(kanaele);
	const art = kanalArt(anlass);
	// Ältere Configs: ohne "ansehen" bzw. "warten" der Systemkanal.
	return String(k[art] || (art === 'ansehen' || art === 'warten' ? k.system : '') || '');
}

/** Freigaben laufen über den Kanal "Rückfragen", sobald er eingerichtet ist; sonst wie bisher im 1:1-Chat. */
function freigabeImKanal(kanaele) {
	return Boolean(lesen(kanaele).rueckfragen);
}

module.exports = { KANAELE, ARTEN, ZUORDNUNG, PRAEFIXE, kanalArt, istBekannt, lesen, kanalId, freigabeImKanal };
