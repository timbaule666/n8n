'use strict';
// Statusmodell und erlaubte Übergänge (Masterprompt 4.4, Bauplan 2.2).
// Einzige Quelle der Wahrheit: wird in den Code-Node von "EPA SW Status setzen" eingebettet.

const STATUS = Object.freeze({
	NEU: 'Neu',
	ZUORDNUNG_UNKLAR: 'Zuordnung unklar',
	IGNORIERT: 'Ignoriert',
	KLASSIFIZIERUNG_UNKLAR: 'Klassifizierung unklar',
	IN_PRUEFUNG: 'In Prüfung',
	BEREIT: 'Bereit zur Bearbeitung',
	LUECKEN: 'Lücken erkannt',
	FREIGABE: 'Freigabe ausstehend',
	WARTEN: 'Warten auf Kunde',
	ESKALIERT: 'Eskaliert / Manuell',
	ABGESCHLOSSEN: 'Abgeschlossen',
});

const ALLE_STATUS = Object.freeze(Object.values(STATUS));
const ENDSTATUS = Object.freeze([STATUS.ABGESCHLOSSEN, STATUS.IGNORIERT]);

// Auslöser-Typen. Mitarbeiter werden als "Mitarbeiter:<Name oder UPN>" übergeben.
const AUSLOESER = Object.freeze(['KI', 'System', 'Cronjob', 'Mitarbeiter']);

const S = STATUS;
const MA = ['Mitarbeiter'];

// [von, nach, erlaubte Auslöser]
const UEBERGAENGE = [
	[null, S.NEU, ['System']],

	[S.NEU, S.IGNORIERT, ['KI', 'System']],
	[S.NEU, S.ZUORDNUNG_UNKLAR, ['System']],
	[S.NEU, S.KLASSIFIZIERUNG_UNKLAR, ['KI', 'System']],
	[S.NEU, S.IN_PRUEFUNG, ['KI', 'System']],

	[S.ZUORDNUNG_UNKLAR, S.IN_PRUEFUNG, MA],
	[S.ZUORDNUNG_UNKLAR, S.KLASSIFIZIERUNG_UNKLAR, ['KI', 'System']],
	[S.ZUORDNUNG_UNKLAR, S.IGNORIERT, MA],
	// Mitarbeiter ordnet die Mail einem bestehenden Vorgang zu: der temporäre Vorgang wird geschlossen.
	[S.ZUORDNUNG_UNKLAR, S.ABGESCHLOSSEN, MA],

	[S.KLASSIFIZIERUNG_UNKLAR, S.IN_PRUEFUNG, MA],
	[S.KLASSIFIZIERUNG_UNKLAR, S.IGNORIERT, MA],

	// Fehlklassifizierung korrigieren: nie löschen, Mitarbeiter kann zurückholen.
	[S.IGNORIERT, S.IN_PRUEFUNG, MA],

	[S.IN_PRUEFUNG, S.BEREIT, ['System']],
	[S.IN_PRUEFUNG, S.LUECKEN, ['System']],

	[S.LUECKEN, S.FREIGABE, ['System']],
	[S.LUECKEN, S.ESKALIERT, ['System']],

	[S.FREIGABE, S.WARTEN, MA],
	[S.FREIGABE, S.ESKALIERT, MA],
	// Neuer Kundeneingang, während noch eine Freigabe offen ist: Entwurf ist veraltet.
	[S.FREIGABE, S.IN_PRUEFUNG, ['System']],

	[S.WARTEN, S.IN_PRUEFUNG, ['System']],
	[S.WARTEN, S.FREIGABE, ['Cronjob']],
	[S.WARTEN, S.ESKALIERT, ['Cronjob', 'System']],

	[S.BEREIT, S.ABGESCHLOSSEN, MA],
	[S.BEREIT, S.IN_PRUEFUNG, ['System']],

	[S.ESKALIERT, S.IN_PRUEFUNG, MA],
	// Versand nach Freigabe fehlgeschlagen (z. B. Postfach gesperrt): EPA-05 sichert den Vorgang als eskaliert,
	// die Freigabe bleibt offen. Gibt der Mitarbeiter danach erneut frei, wartet der Vorgang wieder auf den Kunden.
	[S.ESKALIERT, S.WARTEN, MA],
	// Nachricht kam beim Kunden nicht an (Unzustellbarkeitsmeldung): Nach erfolgreichem Zustelltest legt EPA-04
	// eine neue Freigabe mit demselben Text an.
	[S.ESKALIERT, S.FREIGABE, ['Cronjob']],
	[S.ESKALIERT, S.ABGESCHLOSSEN, MA],
];

// Error-Handler darf jeden laufenden Vorgang sichern (Masterprompt Phase F).
const SYSTEM_ESKALATION_VON = ALLE_STATUS.filter(
	(s) => !ENDSTATUS.includes(s) && s !== S.ESKALIERT,
);

function ausloeserTyp(ausloeser) {
	if (typeof ausloeser !== 'string' || ausloeser.trim() === '') return null;
	const typ = ausloeser.split(':')[0].trim();
	if (typ === 'Mitarbeiter') {
		const name = ausloeser.slice(ausloeser.indexOf(':') + 1).trim();
		return ausloeser.includes(':') && name ? 'Mitarbeiter' : null;
	}
	return AUSLOESER.includes(typ) && !ausloeser.includes(':') ? typ : null;
}

/**
 * Prüft einen Statusübergang.
 * @returns {{erlaubt: boolean, statuscode: number, code: string, grund: string}}
 */
function pruefeUebergang(alt, neu, ausloeser) {
	const ablehnen = (code, grund) => ({ erlaubt: false, statuscode: 409, code, grund });
	const typ = ausloeserTyp(ausloeser);
	if (!typ) {
		return { erlaubt: false, statuscode: 400, code: 'UNGUELTIGER_AUSLOESER', grund: `Auslöser "${ausloeser}" ist ungültig` };
	}
	if (!ALLE_STATUS.includes(neu)) {
		return { erlaubt: false, statuscode: 400, code: 'UNBEKANNTER_STATUS', grund: `Status "${neu}" ist unbekannt` };
	}
	if (alt !== null && !ALLE_STATUS.includes(alt)) {
		return { erlaubt: false, statuscode: 400, code: 'UNBEKANNTER_STATUS', grund: `Status "${alt}" ist unbekannt` };
	}
	if (alt === neu) return ablehnen('UNZULAESSIGER_STATUSWECHSEL', `Status ist bereits "${neu}"`);

	if (neu === S.ESKALIERT && typ === 'System' && SYSTEM_ESKALATION_VON.includes(alt)) {
		return { erlaubt: true, statuscode: 200, code: 'OK', grund: 'Systemeskalation' };
	}
	const regel = UEBERGAENGE.find(([v, n]) => v === alt && n === neu);
	if (!regel) return ablehnen('UNZULAESSIGER_STATUSWECHSEL', `"${alt}" -> "${neu}" ist nicht erlaubt`);
	if (!regel[2].includes(typ)) {
		return ablehnen('UNZULAESSIGER_AUSLOESER', `"${alt}" -> "${neu}" ist für Auslöser "${typ}" nicht erlaubt`);
	}
	return { erlaubt: true, statuscode: 200, code: 'OK', grund: '' };
}

function erlaubteFolgestatus(alt, ausloeser) {
	return ALLE_STATUS.filter((neu) => pruefeUebergang(alt, neu, ausloeser).erlaubt);
}

module.exports = {
	STATUS,
	ALLE_STATUS,
	ENDSTATUS,
	AUSLOESER,
	UEBERGAENGE,
	pruefeUebergang,
	erlaubteFolgestatus,
	ausloeserTyp,
};
