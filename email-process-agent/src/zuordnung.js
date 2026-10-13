'use strict';
// Deterministische Vorgangszuordnung (Masterprompt A3, Bauplan 5.2): Entscheidungsliste mit Gewichtung.
// Jede Entscheidung liefert die Einzelpunkte je Kandidat, damit sie im Audit nachvollziehbar ist.

const GEWICHTE = Object.freeze({
	BEZUG_MESSAGE_ID: 60, // In-Reply-To/References enthält eine bekannte Message-ID
	CONVERSATION_ID: 40,
	ABSENDER_GLEICH: 25,
	DOMAIN_GLEICH: 10, // nur wenn die Adresse abweicht
	BETREFF_GLEICH: 15,
	VORGANGS_ID_GENANNT: 60, // Bauplan 5.2 sah 50 vor; mit 60 reicht "ID genannt + gleicher Absender" (85) für eindeutig
	THREAD_FREMDE_DOMAIN: -40, // Konfliktmarker
});

const STANDARD_SCHWELLEN = Object.freeze({ eindeutig: 80, abstand: 50, neu: 40 });

function domain(adr) {
	const s = String(adr || '').toLowerCase();
	return s.includes('@') ? s.slice(s.lastIndexOf('@') + 1) : null;
}

/** Punkte eines Kandidaten für eine Mail. */
function bewerteKandidat(mail, k) {
	const punkte = [];
	const add = (signal, wert) => punkte.push({ signal, punkte: wert });
	const bezug = new Set(mail.bezug_message_ids || []);
	const bekannt = Array.isArray(k.bekannte_message_ids) ? k.bekannte_message_ids : [];
	const thread = bekannt.some((id) => bezug.has(id));
	if (thread) add('Bezug auf bekannte Message-ID', GEWICHTE.BEZUG_MESSAGE_ID);
	const konv = Boolean(mail.conversation_id && k.conversation_id && mail.conversation_id === k.conversation_id);
	if (konv) add('gleiche Conversation-ID', GEWICHTE.CONVERSATION_ID);
	const a = String(mail.absender_adresse || '').toLowerCase();
	const b = String(k.absender_adresse || '').toLowerCase();
	const domainGleich = Boolean(domain(a) && domain(a) === domain(b));
	if (a && a === b) add('gleicher Absender', GEWICHTE.ABSENDER_GLEICH);
	else if (domainGleich) add('gleiche Absender-Domain', GEWICHTE.DOMAIN_GLEICH);
	if (mail.betreff_normalisiert && mail.betreff_normalisiert === k.betreff_normalisiert) add('gleicher Betreff', GEWICHTE.BETREFF_GLEICH);
	if ((mail.vorgangs_ids_erwaehnt || []).includes(k.vorgangs_id)) add('Vorgangs-ID genannt', GEWICHTE.VORGANGS_ID_GENANNT);
	const konflikt = (thread || konv) && a !== b && !domainGleich;
	if (konflikt) add('Thread passt, Absender-Domain fremd', GEWICHTE.THREAD_FREMDE_DOMAIN);
	return {
		vorgangs_id: k.vorgangs_id,
		status: k.status,
		version: k.version,
		summe: punkte.reduce((s, p) => s + p.punkte, 0),
		konflikt,
		punkte,
	};
}

/**
 * @param {object} mail normalisierte Mail (src/mailNormalisieren.js)
 * @param {object[]} kandidaten offene Vorgänge (EPA SW Vorgang verwalten, aktion kandidaten_suchen)
 * @param {{eindeutig:number, abstand:number, neu:number}} [schwellen]
 * @returns {{ ergebnis: 'eindeutig'|'neu'|'unklar', vorgangs_id: string|null, grund: string, bewertung: object[] }}
 */
function zuordnen(mail, kandidaten, schwellen) {
	const s = { ...STANDARD_SCHWELLEN, ...(schwellen || {}) };
	const bewertung = (kandidaten || [])
		.filter((k) => k && k.vorgangs_id)
		.map((k) => bewerteKandidat(mail, k))
		.sort((x, y) => y.summe - x.summe || String(y.vorgangs_id).localeCompare(String(x.vorgangs_id)));
	const [erster, zweiter] = bewertung;
	if (erster && erster.summe >= s.eindeutig && !erster.konflikt && (!zweiter || zweiter.summe < s.abstand)) {
		return { ergebnis: 'eindeutig', vorgangs_id: erster.vorgangs_id, grund: `${erster.summe} Punkte, nächster Kandidat ${zweiter ? zweiter.summe : 0}`, bewertung };
	}
	// Ein Konfliktmarker (Thread passt, Absender fremd) führt nie zu einem neuen Vorgang ohne Rückfrage.
	if (!bewertung.some((b) => b.summe >= s.neu || b.konflikt)) {
		return { ergebnis: 'neu', vorgangs_id: null, grund: bewertung.length ? `höchstens ${erster.summe} Punkte (< ${s.neu})` : 'kein offener Vorgang passt', bewertung };
	}
	let grund;
	if (bewertung.some((b) => b.konflikt)) grund = 'Thread passt, aber der Absender gehört zu einer fremden Domain';
	else if (zweiter && zweiter.summe >= s.abstand) grund = `mehrere Kandidaten (${erster.summe} und ${zweiter.summe} Punkte)`;
	else grund = `bester Kandidat nur ${erster.summe} Punkte (< ${s.eindeutig})`;
	return { ergebnis: 'unklar', vorgangs_id: null, grund, bewertung: bewertung.slice(0, 3) };
}

module.exports = { GEWICHTE, STANDARD_SCHWELLEN, bewerteKandidat, zuordnen };
