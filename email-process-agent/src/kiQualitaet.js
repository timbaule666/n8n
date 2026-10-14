'use strict';
// Testphase: Qualität der KI messen (Klassifizierung und Extraktion) gegen von Menschen festgelegte Sollwerte.
// Verglichen werden die geprüften Werte nach src/pflichtfelder.js (also das, was der Vorgang tatsächlich speichern würde),
// nicht die rohe KI-Antwort. Ergebnis je Fall und als Zusammenfassung je Feld.

/** Testfall-Zeile (Data Table epa_test_ki_faelle) -> Graph-ähnliche Mail für mailNormalisieren.normalisieren. */
function testMail(fall) {
	return {
		id: `ki-test-${fall.fall_id}`,
		internetMessageId: `<ki-test-${fall.fall_id}@epa.test>`,
		subject: String(fall.betreff || ''),
		body: { contentType: 'Text', content: String(fall.text || '') },
		from: { emailAddress: { address: String(fall.absender || 'test@absender.example').toLowerCase(), name: String(fall.absender_name || '') } },
		internetMessageHeaders: [],
		toRecipients: [],
		ccRecipients: [],
	};
}

function sollFelder(fall) {
	if (!fall.erwartete_felder) return {};
	const s = typeof fall.erwartete_felder === 'string' ? JSON.parse(fall.erwartete_felder) : fall.erwartete_felder;
	if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`Fall ${fall.fall_id}: erwartete_felder muss ein JSON-Objekt sein`);
	return s;
}

/** Freitext tolerant vergleichen (Groß-/Kleinschreibung, Leerraum, Anrede); alles andere exakt nach Normalisierung. */
function gleich(feld, a, b) {
	if (feld.typ !== 'text') return String(a) === String(b);
	const n = (x) => String(x).toLowerCase().replace(/^(herr|frau|hr\.|fr\.)\s+/, '').replace(/\s+/g, ' ').trim();
	return n(a) === n(b);
}

/**
 * Vergleicht einen Fall.
 * @param {object} p
 * @param {object} p.fall          Zeile mit erwartete_klasse ('anfrage' | 'keine_anfrage' | 'unklar') und erwartete_felder
 * @param {object|null} p.klasse   Ergebnis von eingang.klasseAuswerten (weg: pruefen | ignoriert | unklar)
 * @param {object|null} p.pruefung Ergebnis von pflichtfelder.pruefen (nur wenn extrahiert)
 * @param {object[]} p.felder      Feld-Config des Vorgangstyps
 * @param {Function} p.feldPruefen pflichtfelder.feldPruefen (normalisiert den Sollwert gleich wie den Istwert)
 */
function vergleichen({ fall, klasse, pruefung, felder, feldPruefen, heute }) {
	const klasseIst = !klasse ? 'fehler' : klasse.weg === 'pruefen' ? 'anfrage' : klasse.weg === 'ignoriert' ? 'keine_anfrage' : 'unklar';
	const klasseSoll = fall.erwartete_klasse || 'anfrage';
	const ergebnis = { fall_id: fall.fall_id, klasse_soll: klasseSoll, klasse_ist: klasseIst, klasse_ok: klasseSoll === klasseIst, felder: [] };
	if (klasseSoll !== 'anfrage' || !pruefung) return ergebnis;
	const soll = sollFelder(fall);
	for (const f of felder) {
		if (!(f.feldname in soll)) continue; // nur Felder vergleichen, für die ein Sollwert festgelegt ist
		const sRoh = soll[f.feldname];
		let sWert = null;
		if (sRoh !== null && sRoh !== '') {
			const r = feldPruefen(f, sRoh, { heute });
			sWert = r.ok ? r.wert : String(sRoh);
		}
		const i = pruefung.daten[f.feldname] || {};
		const iWert = i.wert ?? null;
		let art;
		if (sWert === null && iWert === null) art = 'richtig_leer';
		else if (sWert === null) art = 'zuviel'; // KI liefert etwas, das nicht in der Mail steht
		else if (iWert === null) art = 'fehlend';
		else art = gleich(f, sWert, iWert) ? 'richtig' : 'falsch';
		ergebnis.felder.push({ feldname: f.feldname, soll: sWert, ist: iWert, art });
	}
	return ergebnis;
}

/** Zusammenfassung über alle Fälle: Klassifizierung und je Feld. */
function zusammenfassen(ergebnisse) {
	const k = { faelle: ergebnisse.length, richtig: 0, falsch: [] };
	const felder = {};
	for (const e of ergebnisse) {
		if (e.klasse_ok) k.richtig += 1;
		else k.falsch.push(`${e.fall_id}: ${e.klasse_soll} → ${e.klasse_ist}`);
		for (const f of e.felder) {
			const z = (felder[f.feldname] = felder[f.feldname] || { richtig: 0, richtig_leer: 0, falsch: 0, fehlend: 0, zuviel: 0 });
			z[f.art] += 1;
		}
	}
	const quote = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
	const feldTabelle = Object.entries(felder).map(([feldname, z]) => {
		const geprueft = z.richtig + z.richtig_leer + z.falsch + z.fehlend + z.zuviel;
		return { feldname, ...z, geprueft, trefferquote: quote(z.richtig + z.richtig_leer, geprueft) };
	}).sort((a, b) => (a.trefferquote ?? 101) - (b.trefferquote ?? 101) || a.feldname.localeCompare(b.feldname));
	return { klassifizierung: { ...k, trefferquote: quote(k.richtig, k.faelle) }, felder: feldTabelle };
}

/** Markdown-Bericht (für Teams bzw. Dokumentation). */
function bericht(z, { lauf, modell, prompt_version }) {
	const zeilen = [
		`**KI-Qualität – Lauf ${lauf}** (Modell ${modell || '?'}, Prompts ${prompt_version || '?'})`,
		'',
		`Klassifizierung: ${z.klassifizierung.richtig}/${z.klassifizierung.faelle} richtig (${z.klassifizierung.trefferquote ?? '–'} %)`,
		...z.klassifizierung.falsch.map((x) => `- falsch: ${x}`),
		'',
		'| Feld | geprüft | richtig | richtig leer | falsch | fehlend | zu viel | Trefferquote |',
		'|---|---|---|---|---|---|---|---|',
		...z.felder.map((f) => `| ${f.feldname} | ${f.geprueft} | ${f.richtig} | ${f.richtig_leer} | ${f.falsch} | ${f.fehlend} | ${f.zuviel} | ${f.trefferquote ?? '–'} % |`),
	];
	return zeilen.join('\n');
}

module.exports = { testMail, sollFelder, gleich, vergleichen, zusammenfassen, bericht };
