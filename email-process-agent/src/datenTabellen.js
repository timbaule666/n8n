'use strict';
// Hilfsfunktionen für den Speicher-Adapter "n8n Data Tables".
// Data Tables kennen nur string/number/boolean/date. JSON-Felder werden als Text gespeichert und hier
// beim Lesen geparst bzw. beim Schreiben serialisiert. Der Data-Table-Node übernimmt im Modus
// "autoMapInputData" genau die Felder des Eingabe-Items; deshalb erzeugen diese Funktionen nur
// gültige Spalten (unbekannte Spalten würden den Node abbrechen lassen).

const SPALTEN = {
	epa_vorgaenge: [
		'vorgangs_id', 'kunde_id', 'vorgangstyp', 'status', 'conversation_id', 'erste_message_id', 'letzte_message_id',
		'bekannte_message_ids', 'absender_adresse', 'absender_name', 'betreff', 'betreff_normalisiert', 'extrahierte_daten',
		'fehlende_felder', 'konflikte', 'rundenzaehler', 'antwort_frist', 'erinnerungen_gesendet', 'bearbeiter',
		'freigabe_id_aktuell', 'spoofing_hinweis', 'version', 'lock_bis', 'lock_durch', 'loeschen_ab', 'sprache',
		'erste_mail_am', 'erste_mail_link',
	],
	epa_audit_log: ['kunde_id', 'vorgangs_id', 'typ', 'alt', 'neu', 'ausloeser', 'details', 'referenz'],
};

const JSON_SPALTEN = {
	epa_vorgaenge: { bekannte_message_ids: [], extrahierte_daten: {}, fehlende_felder: [], konflikte: [] },
	epa_audit_log: { details: {} },
};

const OFFEN_AUSGESCHLOSSEN = ['Abgeschlossen', 'Ignoriert'];

function parseJsonSpalte(wert, standard) {
	if (wert === null || wert === undefined || wert === '') return Array.isArray(standard) ? [] : { ...standard };
	if (typeof wert === 'object') return wert;
	try {
		return JSON.parse(wert);
	} catch {
		return Array.isArray(standard) ? [] : { ...standard };
	}
}

/** Item eines Data-Table-Lesezugriffs -> Objekt (oder null, wenn leer, z. B. bei alwaysOutputData). */
function zeileLesen(row, tabelle) {
	if (!row || row.id === undefined || row.id === null) return null;
	const out = { ...row };
	for (const [spalte, standard] of Object.entries(JSON_SPALTEN[tabelle] || {})) out[spalte] = parseJsonSpalte(row[spalte], standard);
	return out;
}

/** Objekt -> schreibbare Zeile (nur bekannte Spalten, JSON als Text, undefined entfernt). */
function zeileSchreiben(obj, tabelle) {
	const erlaubt = SPALTEN[tabelle];
	if (!erlaubt) throw new Error(`Unbekannte Tabelle ${tabelle}`);
	const json = JSON_SPALTEN[tabelle] || {};
	const out = {};
	for (const [k, v] of Object.entries(obj || {})) {
		if (!erlaubt.includes(k)) throw new Error(`Spalte "${k}" gibt es in ${tabelle} nicht`);
		if (v === undefined) continue;
		out[k] = k in json && v !== null && typeof v !== 'string' ? JSON.stringify(v) : v;
	}
	return out;
}

/** Kollisionsfreie Vorgangs-ID aus der fortlaufenden Zeilen-ID der Data Table. */
function vorgangsIdAusZeile(zeilenId, jahr) {
	const n = Number(zeilenId);
	if (!Number.isInteger(n) || n < 1) throw new Error(`Ungültige Zeilen-ID ${zeilenId}`);
	return `V-${jahr}-${String(n).padStart(4, '0')}`;
}

/** Neuer Vorgang (Status "Neu") aus den erlaubten Anlage-Feldern. */
function neuerVorgang(kundeId, daten, { aufbewahrungTage, jetzt, platzhalterId }) {
	const d = daten || {};
	const loeschen = new Date(new Date(jetzt).getTime() + Number(aufbewahrungTage) * 86400000).toISOString();
	return zeileSchreiben({
		vorgangs_id: platzhalterId,
		kunde_id: kundeId,
		vorgangstyp: d.vorgangstyp ?? null,
		status: 'Neu',
		conversation_id: d.conversation_id ?? null,
		erste_message_id: d.erste_message_id ?? null,
		letzte_message_id: d.erste_message_id ?? null,
		bekannte_message_ids: d.erste_message_id ? [d.erste_message_id] : [],
		absender_adresse: d.absender_adresse ? String(d.absender_adresse).toLowerCase() : null,
		absender_name: d.absender_name ?? null,
		betreff: d.betreff ?? null,
		betreff_normalisiert: d.betreff_normalisiert ?? null,
		extrahierte_daten: {},
		fehlende_felder: [],
		konflikte: [],
		rundenzaehler: 0,
		erinnerungen_gesendet: 0,
		spoofing_hinweis: d.spoofing_hinweis ?? null,
		// Eingang und Outlook-Link der ersten Mail, damit die Abschluss-Meldung darauf verweisen kann
		erste_mail_am: d.erste_mail_am ?? null,
		erste_mail_link: d.erste_mail_link ?? null,
		version: 1,
		loeschen_ab: loeschen,
	}, 'epa_vorgaenge');
}

const AENDERBAR = ['vorgangstyp', 'conversation_id', 'letzte_message_id', 'neue_message_ids', 'absender_name', 'betreff',
	'betreff_normalisiert', 'extrahierte_daten', 'fehlende_felder', 'konflikte', 'rundenzaehler', 'antwort_frist',
	'erinnerungen_gesendet', 'bearbeiter', 'freigabe_id_aktuell', 'spoofing_hinweis', 'sprache'];

/**
 * Teil-Update eines Vorgangs. Gibt nur geänderte Spalten + neue Version zurück.
 * neue_message_ids werden an bekannte_message_ids angehängt (ohne Duplikate).
 */
function aktualisierungBerechnen(vorgang, daten) {
	const patch = {};
	for (const [k, v] of Object.entries(daten || {})) {
		if (!AENDERBAR.includes(k)) throw new Error(`Feld "${k}" ist nicht änderbar`);
		if (k === 'neue_message_ids') {
			const alle = [...(vorgang.bekannte_message_ids || []), ...(v || [])];
			patch.bekannte_message_ids = [...new Set(alle)];
		} else {
			patch[k] = v;
		}
	}
	patch.version = Number(vorgang.version) + 1;
	return zeileSchreiben(patch, 'epa_vorgaenge');
}

/** Filtert offene Vorgänge eines Kunden nach Zuordnungskriterien (wie die SQL-Variante). */
/** Erfasste Werte eines Vorgangs als Texte (höchstens 15). */
function erfassteWerte(daten) {
	const out = [];
	for (const d of Object.values(daten && typeof daten === 'object' ? daten : {})) {
		const w = d && typeof d === 'object' ? d.wert : null;
		if (w !== null && w !== undefined && w !== '') out.push(String(w));
	}
	return out.slice(0, 15);
}

function kandidatenFiltern(zeilen, kriterien) {
	const k = kriterien || {};
	const ids = new Set(k.message_ids || []);
	const vids = new Set(k.vorgangs_ids || []);
	const absender = k.absender_adresse ? String(k.absender_adresse).toLowerCase() : null;
	// Starke Hinweise (Bezug auf Message-ID, genannte Vorgangs-ID, gleiche Konversation) sind immer Kandidaten.
	// Schwache (nur Absender oder Betreff) werden nach Aktualität auf insgesamt 20 aufgefüllt. Sonst fällt bei
	// Absendern mit vielen offenen Vorgängen ausgerechnet der genannte Vorgang heraus (Live-Test T04b).
	const stark = (v) => (v.bekannte_message_ids || []).some((m) => ids.has(m)) || vids.has(v.vorgangs_id) ||
		Boolean(k.conversation_id && v.conversation_id === k.conversation_id);
	const passend = (zeilen || [])
		.map((z) => zeileLesen(z, 'epa_vorgaenge'))
		.filter((v) => v && !OFFEN_AUSGESCHLOSSEN.includes(v.status))
		.filter((v) => stark(v) ||
			(absender && String(v.absender_adresse || '').toLowerCase() === absender) ||
			(k.betreff_normalisiert && v.betreff_normalisiert === k.betreff_normalisiert))
		.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
	const starke = passend.filter(stark);
	const schwache = passend.filter((v) => !stark(v)).slice(0, Math.max(0, 20 - starke.length));
	return [...starke, ...schwache]
		.map((v) => ({
			vorgangs_id: v.vorgangs_id, status: v.status, conversation_id: v.conversation_id,
			bekannte_message_ids: v.bekannte_message_ids, absender_adresse: v.absender_adresse,
			betreff_normalisiert: v.betreff_normalisiert, version: v.version, geaendert_am: v.updatedAt,
			// Für Meldungen zu Mails ohne Bezug (z. B. Stornierung): Betreff und erfasste Werte zum Abgleich mit dem Text
			betreff: v.betreff, werte: erfassteWerte(v.extrahierte_daten),
		}));
}

/**
 * Entscheidet über eine Sperre. Ergebnis enthält die Werte für ein bedingtes Update
 * (Compare-and-Set auf lock_durch): Nur wenn lock_durch noch den gelesenen Wert hat, wird gesperrt.
 */
function sperreEntscheiden(vorgang, wer, sekunden, jetzt) {
	const t = new Date(jetzt).getTime();
	const bis = vorgang.lock_bis ? new Date(vorgang.lock_bis).getTime() : null;
	const frei = !vorgang.lock_durch || bis === null || bis < t || vorgang.lock_durch === wer;
	return {
		moeglich: frei,
		vorher_durch: vorgang.lock_durch || null,
		vorher_bis: vorgang.lock_bis || null,
		neu: { lock_durch: wer, lock_bis: new Date(t + sekunden * 1000).toISOString() },
	};
}

module.exports = {
	SPALTEN,
	JSON_SPALTEN,
	AENDERBAR,
	zeileLesen,
	zeileSchreiben,
	vorgangsIdAusZeile,
	neuerVorgang,
	aktualisierungBerechnen,
	kandidatenFiltern,
	sperreEntscheiden,
};
