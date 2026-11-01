'use strict';
// Kalenderprüfung für Terminanfragen (Config "kalender"): Ist der Wunschtermin im Outlook-Kalender des Kunden frei?
// Das Team bekommt eine Meldung mit Link; eingetragen wird erst nach Klick (EPA-15). Der Agent trägt nie selbst ein
// und schreibt dem Kunden nichts. Reine Funktionen, keine Abhängigkeiten (Zeitzonen über Intl).

const STANDARD = Object.freeze({ dauer_minuten: 60, gueltig_stunden: 72 });
const ZEITRAEUME = Object.freeze({
	vormittag: ['08:00', '12:00'],
	mittag: ['11:00', '14:00'],
	nachmittag: ['13:00', '17:00'],
	abend: ['17:00', '20:00'],
});
const MAX_VORSCHLAEGE = 3;
const RASTER_MINUTEN = 30;
const TAGE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

function zwei(n) {
	return String(n).padStart(2, '0');
}

function zeitOk(h, m) {
	return Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function hhmm(h, m) {
	return `${zwei(h)}:${zwei(m)}`;
}

function minuten(zeit) {
	const [h, m] = String(zeit).split(':').map(Number);
	return h * 60 + m;
}

function ausMinuten(n) {
	return hhmm(Math.floor(n / 60), n % 60);
}

function mitAmPm(h, ampm) {
	if (!ampm) return h;
	const a = ampm.toLowerCase().replace(/\./g, '');
	if (a === 'pm' && h < 12) return h + 12;
	if (a === 'am' && h === 12) return 0;
	return h;
}

/**
 * Liest eine frei geschriebene Uhrzeit ("10 Uhr", "10:30", "14.00", "2 pm", "zwischen 9 und 11", "vormittags").
 * @returns {{ art: 'exakt', von: string } | { art: 'zeitraum', von: string, bis: string } | null}
 */
function uhrzeitLesen(text) {
	const t = String(text ?? '').toLowerCase().trim();
	if (!t) return null;
	const AP = '\\s*(a\\.?m\\.?|p\\.?m\\.?)?';
	// Spanne: "9-11 Uhr", "9:30 – 11", "zwischen 9 und 11 Uhr", "from 9 to 11 am"
	const spanne = t.match(new RegExp(`(\\d{1,2})(?:[:.](\\d{2}))?${AP}\\s*(?:-|–|bis|und|to)\\s*(\\d{1,2})(?:[:.](\\d{2}))?${AP}\\s*(?:uhr|h\\b)?`));
	if (spanne && (/zwischen|between|from|von|uhr|h\b|[:.]\d{2}|am|pm/.test(t))) {
		const h1 = mitAmPm(Number(spanne[1]), spanne[3] || spanne[6]);
		const m1 = Number(spanne[2] || 0);
		const h2 = mitAmPm(Number(spanne[4]), spanne[6]);
		const m2 = Number(spanne[5] || 0);
		if (zeitOk(h1, m1) && zeitOk(h2, m2) && h2 * 60 + m2 > h1 * 60 + m1) return { art: 'zeitraum', von: hhmm(h1, m1), bis: hhmm(h2, m2) };
	}
	const mitMinuten = t.match(new RegExp(`(\\d{1,2})[:.](\\d{2})${AP}`));
	if (mitMinuten) {
		const h = mitAmPm(Number(mitMinuten[1]), mitMinuten[3]);
		const m = Number(mitMinuten[2]);
		if (zeitOk(h, m)) return { art: 'exakt', von: hhmm(h, m) };
	}
	const volle = t.match(/(\d{1,2})\s*(uhr|h\b|a\.?m\.?|p\.?m\.?|o'?clock)/) || t.match(/(?:^|\b)(?:um|ab|gegen|at|around)\s+(\d{1,2})\b/) || t.match(/^(\d{1,2})$/);
	if (volle) {
		const h = mitAmPm(Number(volle[1]), /^[ap]/.test(volle[2] || '') ? volle[2] : null);
		if (zeitOk(h, 0)) return { art: 'exakt', von: hhmm(h, 0) };
	}
	const WOERTER = [
		[/vormittag|morgens|morning/, 'vormittag'],
		[/nachmittag|afternoon/, 'nachmittag'],
		[/mittag|noon|lunch/, 'mittag'],
		[/abend|evening/, 'abend'],
	];
	for (const [re, name] of WOERTER) if (re.test(t)) return { art: 'zeitraum', von: ZEITRAEUME[name][0], bis: ZEITRAEUME[name][1], name };
	return null;
}

/** Abstand der Zeitzone zu UTC in Minuten an diesem Tag und dieser Uhrzeit (Sommerzeit beachtet). */
function offsetMinuten(datum, zeit, zone) {
	const [j, mo, t] = datum.split('-').map(Number);
	const [h, mi] = zeit.split(':').map(Number);
	let utc = Date.UTC(j, mo - 1, t, h, mi);
	// Zweimal annähern, damit auch Zeiten kurz nach der Umstellung stimmen.
	for (let i = 0; i < 2; i++) {
		const teile = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
			.formatToParts(new Date(utc)).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
		const lokal = Date.UTC(Number(teile.year), Number(teile.month) - 1, Number(teile.day), Number(teile.hour), Number(teile.minute));
		const off = Math.round((lokal - utc) / 60000);
		utc = Date.UTC(j, mo - 1, t, h, mi) - off * 60000;
		if (i === 1) return off;
	}
	return 0;
}

/** Lokale Zeit -> ISO mit Offset, z. B. 2026-12-03T10:00:00+01:00 */
function zuIso(datum, zeit, zone) {
	const off = offsetMinuten(datum, zeit, zone);
	const v = off < 0 ? '-' : '+';
	const a = Math.abs(off);
	return `${datum}T${zeit}:00${v}${zwei(Math.floor(a / 60))}:${zwei(a % 60)}`;
}

/** Zeitpunkt (ms) -> lokale "HH:MM" bzw. "JJJJ-MM-TT" in der Zone */
function lokal(ms, zone) {
	const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
		.formatToParts(new Date(ms)).reduce((o, x) => ({ ...o, [x.type]: x.value }), {});
	return { datum: `${p.year}-${p.month}-${p.day}`, zeit: `${p.hour}:${p.minute}` };
}

function wochentag(datum) {
	const [j, m, t] = datum.split('-').map(Number);
	return new Date(Date.UTC(j, m - 1, t)).getUTCDay();
}

function datumText(datum) {
	const [j, m, t] = datum.split('-');
	return `${TAGE[wochentag(datum)]} ${t}.${m}.${j}`;
}

function wert(vorgang, feld) {
	if (!feld) return null;
	const d = vorgang && vorgang.extrahierte_daten && vorgang.extrahierte_daten[feld];
	const w = d && typeof d === 'object' ? d.wert : d;
	return w === null || w === undefined || w === '' ? null : String(w).trim();
}

/** Config "kalender" (bereits geprüft) mit Standardwerten. */
function einstellungen(config) {
	const k = (config && config.kalender) || null;
	if (!k || k.aktiv !== true) return null;
	return { ...STANDARD, ...k };
}

/**
 * Was soll geprüft werden? Liefert { relevant: false, grund } oder den Plan mit Prüffenster (ISO mit Offset).
 * @param {object} config geprüfte Kunden-Config (kalender, zeitzone, geschaeftszeiten)
 * @param {object} vorgang Vorgang mit vorgangstyp und extrahierte_daten
 * @param {string} jetztIso aktueller Zeitpunkt
 */
function plan(config, vorgang, jetztIso) {
	const k = einstellungen(config);
	if (!k) return { relevant: false, grund: 'Kalender nicht eingerichtet' };
	if (!vorgang || vorgang.vorgangstyp !== k.vorgangstyp) return { relevant: false, grund: 'andere Vorgangsart' };
	const datum = wert(vorgang, k.datum_feld);
	if (!datum || !/^\d{4}-\d{2}-\d{2}$/.test(datum)) return { relevant: false, grund: 'kein Datum' };
	const zone = config.zeitzone || 'Europe/Berlin';
	const gz = config.geschaeftszeiten || { tage: [1, 2, 3, 4, 5], von: '08:00', bis: '17:00' };
	const uhr = uhrzeitLesen(wert(vorgang, k.uhrzeit_feld));
	const dauer = Number(k.dauer_minuten);
	const hinweise = [];
	let art;
	let von;
	let bis;
	if (uhr && uhr.art === 'exakt') {
		art = 'exakt';
		von = uhr.von;
		bis = ausMinuten(Math.min(minuten(von) + dauer, 23 * 60 + 59));
	} else {
		art = 'zeitraum';
		von = uhr ? uhr.von : gz.von;
		bis = uhr ? uhr.bis : gz.bis;
		if (!uhr) hinweise.push('Keine genaue Uhrzeit genannt – geprüft wurde die Geschäftszeit an diesem Tag.');
		if (minuten(bis) - minuten(von) < dauer) bis = ausMinuten(Math.min(minuten(von) + dauer, 23 * 60 + 59));
	}
	const startIso = zuIso(datum, von, zone);
	const endeIso = zuIso(datum, bis, zone);
	if (new Date(endeIso).getTime() <= new Date(jetztIso).getTime()) hinweise.push('Der Wunschtermin liegt in der Vergangenheit.');
	if (Array.isArray(gz.tage) && !gz.tage.includes(wochentag(datum) === 0 ? 7 : wochentag(datum))) hinweise.push('Der Wunschtermin liegt außerhalb Ihrer Geschäftstage.');
	else if (art === 'exakt' && (minuten(von) < minuten(gz.von) || minuten(bis) > minuten(gz.bis))) hinweise.push('Der Wunschtermin liegt außerhalb Ihrer Geschäftszeit.');
	return {
		relevant: true,
		art,
		datum,
		von,
		bis,
		dauer_minuten: dauer,
		zone,
		start_iso: startIso,
		ende_iso: endeIso,
		titel: wert(vorgang, k.titel_feld) || 'Termin',
		ort: wert(vorgang, k.ort_feld),
		uhrzeit_text: wert(vorgang, k.uhrzeit_feld),
		hinweise,
	};
}

/** Graph-Zeitangabe ({ dateTime, timeZone }) -> ms. Ohne Prefer-Header liefert Graph UTC. */
function graphZeit(z) {
	if (!z || !z.dateTime) return NaN;
	const s = String(z.dateTime).replace(/(\.\d{3})\d*$/, '$1');
	const utc = !z.timeZone || /^(utc|etc\/utc|gmt)$/i.test(z.timeZone);
	return new Date(utc && !/[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? `${s}Z` : s).getTime();
}

/** Belegte Zeiten aus der Graph-Antwort (calendarView). "Frei" markierte und abgesagte Termine zählen nicht. */
function belegt(ereignisse) {
	return (Array.isArray(ereignisse) ? ereignisse : [])
		.filter((e) => e && e.isCancelled !== true && String(e.showAs || 'busy').toLowerCase() !== 'free')
		.map((e) => ({ von: graphZeit(e.start), bis: graphZeit(e.end), ganztags: e.isAllDay === true }))
		.filter((e) => Number.isFinite(e.von) && Number.isFinite(e.bis) && e.bis > e.von)
		.sort((a, b) => a.von - b.von);
}

/**
 * Bewertet die Kalenderdaten zum Plan.
 * @returns {{ frei: boolean, konflikte: Array<{von: string, bis: string, ganztags: boolean}>, vorschlaege: Array<{start_iso: string, ende_iso: string, text: string}> }}
 */
function bewerten(p, ereignisse) {
	const zone = p.zone;
	const b = belegt(ereignisse);
	const ueberschneidet = (s, e) => b.some((x) => x.von < e && x.bis > s);
	const start = new Date(p.start_iso).getTime();
	const ende = new Date(p.ende_iso).getTime();
	const dauer = p.dauer_minuten * 60000;
	const konflikte = b.filter((x) => x.von < ende && x.bis > start).map((x) => ({ von: lokal(x.von, zone).zeit, bis: lokal(x.bis, zone).zeit, ganztags: x.ganztags }));
	const vorschlaege = [];
	const slot = (s) => {
		const e = s + dauer;
		vorschlaege.push({ start_iso: new Date(s).toISOString(), ende_iso: new Date(e).toISOString(), text: `${datumText(p.datum)}, ${lokal(s, zone).zeit}–${lokal(e, zone).zeit} Uhr` });
	};
	if (p.art === 'exakt') {
		const frei = !ueberschneidet(start, start + dauer);
		if (frei) slot(start);
		return { frei, konflikte, vorschlaege };
	}
	for (let s = start; s + dauer <= ende && vorschlaege.length < MAX_VORSCHLAEGE; s += RASTER_MINUTEN * 60000) {
		if (!ueberschneidet(s, s + dauer)) slot(s);
	}
	return { frei: vorschlaege.length > 0, konflikte, vorschlaege };
}

/** Freie Zeiten außerhalb des Wunschfensters am selben Tag (nur wenn der Wunsch belegt ist). */
function ausweichen(p, ereignisse, gz) {
	const zone = p.zone;
	const g = gz || { von: '08:00', bis: '17:00' };
	const b = belegt(ereignisse);
	const dauer = p.dauer_minuten * 60000;
	const anfang = new Date(zuIso(p.datum, g.von, zone)).getTime();
	const schluss = new Date(zuIso(p.datum, g.bis, zone)).getTime();
	const out = [];
	for (let s = anfang; s + dauer <= schluss && out.length < MAX_VORSCHLAEGE; s += RASTER_MINUTEN * 60000) {
		if (!b.some((x) => x.von < s + dauer && x.bis > s)) {
			out.push({ start_iso: new Date(s).toISOString(), ende_iso: new Date(s + dauer).toISOString(), text: `${datumText(p.datum)}, ${lokal(s, zone).zeit}–${lokal(s + dauer, zone).zeit} Uhr` });
		}
	}
	return out;
}

/** Graph-Body zum Anlegen des Termins (POST /users/{postfach}/events). transactionId verhindert Doppelanlage. */
function ereignis({ termin, slot, zone }) {
	const s = lokal(new Date(slot.start_iso).getTime(), zone);
	const e = lokal(new Date(slot.ende_iso).getTime(), zone);
	const zeilen = [
		`Vorgang: ${termin.vorgangs_id}`,
		termin.kontakt ? `Ansprechpartner: ${termin.kontakt}` : null,
		termin.telefon ? `Telefon: ${termin.telefon}` : null,
		termin.absender ? `E-Mail: ${termin.absender}` : null,
		'',
		'Eingetragen über den Email Process Agent nach Bestätigung im Team.',
	].filter((z) => z !== null);
	const body = {
		subject: `${termin.titel}${termin.kontakt ? ` – ${termin.kontakt}` : ''}`.slice(0, 250),
		start: { dateTime: `${s.datum}T${s.zeit}:00`, timeZone: zone },
		end: { dateTime: `${e.datum}T${e.zeit}:00`, timeZone: zone },
		body: { contentType: 'text', content: zeilen.join('\n') },
		showAs: 'busy',
		transactionId: termin.termin_id,
	};
	if (termin.ort) body.location = { displayName: String(termin.ort).slice(0, 250) };
	return body;
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function wunschText(p) {
	const zeit = p.art === 'exakt' ? `${p.von}–${p.bis} Uhr` : `zwischen ${p.von} und ${p.bis} Uhr`;
	return `${datumText(p.datum)}, ${zeit}`;
}

/** Teams-Meldung zur Kalenderprüfung (bereits escaped). */
function meldung({ vorgangs_id: vid, plan: p, ergebnis: r, link, ablaufText, fehler }) {
	const z = [`<b>📅 Terminanfrage – Kalender geprüft</b>`, `Vorgang: <b>${esc(vid)}</b>`, `Anlass: ${esc(p.titel)}`, `Wunsch: ${esc(wunschText(p))}`];
	if (p.ort) z.push(`Ort: ${esc(p.ort)}`);
	if (fehler) {
		z.push('', `⚠️ <b>Der Kalender konnte nicht gelesen werden.</b> Bitte den Termin selbst prüfen.`, `<i>${esc(fehler)}</i>`);
		return z.join('<br>');
	}
	z.push('');
	if (p.art === 'exakt' && r.frei) z.push('✅ <b>Der Termin ist frei.</b>');
	else if (p.art === 'exakt') z.push(`❌ <b>Der Termin ist belegt</b> (${r.konflikte.map((k) => (k.ganztags ? 'ganztägig' : `${esc(k.von)}–${esc(k.bis)}`)).join(', ')}).`);
	else if (r.frei) z.push('✅ <b>Freie Zeiten im Wunschzeitraum:</b>');
	else z.push('❌ <b>Im Wunschzeitraum ist nichts frei.</b>');
	const vor = r.vorschlaege || [];
	const alt = r.ausweichen || [];
	if (p.art !== 'exakt' && vor.length) z.push(...vor.map((v) => `• ${esc(v.text)}`));
	if (!r.frei && alt.length) z.push('', 'Freie Zeiten am selben Tag:', ...alt.map((v) => `• ${esc(v.text)}`));
	for (const h of p.hinweise || []) z.push(`ℹ️ ${esc(h)}`);
	if (link) {
		z.push('', `<a href="${esc(link)}">Termin in den Kalender eintragen</a>`, `<i>Erst nach Ihrem Klick wird eingetragen. Der Kunde bekommt dadurch keine Nachricht. Gültig bis ${esc(ablaufText)}.</i>`);
	}
	return z.join('<br>');
}

/** Auswahlmöglichkeiten für die Eintragen-Seite: Wunschtermin (falls frei), Vorschläge, Ausweichzeiten. */
function optionen(termin) {
	const liste = [];
	const gesehen = new Set();
	for (const v of [...(termin.vorschlaege || []), ...(termin.ausweichen || [])]) {
		if (gesehen.has(v.start_iso)) continue;
		gesehen.add(v.start_iso);
		liste.push(v);
	}
	return liste.slice(0, 6);
}

/** Formular hinter dem Link (EPA-15). seite = freigabe.seite */
function seiteFormular(seite, { token, termin }) {
	const opt = optionen(termin);
	const auswahl = opt.length
		? opt.map((v, i) => `<label style="display:block;margin:6px 0"><input type="radio" name="slot" value="${i}"${i === 0 ? ' checked' : ''}> ${esc(v.text)}</label>`).join('')
		: '<p class="hinweis">Es wurde keine freie Zeit gefunden. Bitte den Termin direkt in Outlook planen.</p>';
	return seite(`Termin ${termin.vorgangs_id}`, `
<div class="karte"><h1>Termin eintragen – ${esc(termin.vorgangs_id)}</h1>
<dl><dt>Anlass</dt><dd>${esc(termin.titel)}</dd><dt>Wunsch</dt><dd>${esc(termin.wunsch_text)}</dd>${termin.ort ? `<dt>Ort</dt><dd>${esc(termin.ort)}</dd>` : ''}${termin.kontakt ? `<dt>Kontakt</dt><dd>${esc(termin.kontakt)}</dd>` : ''}</dl></div>
<form class="karte" method="post" onsubmit="var f=this;setTimeout(function(){var b=f.querySelectorAll('button');for(var i=0;i<b.length;i++)b[i].disabled=true},0)">
<input type="hidden" name="t" value="${esc(token)}">
<p><b>Zeit auswählen</b></p>${auswahl}
<div class="knoepfe">${opt.length ? '<button class="senden" name="aktion" value="eintragen">In den Kalender eintragen</button>' : ''}
<button class="ablehnen" name="aktion" value="verwerfen">Nicht eintragen</button></div>
<p class="hinweis">Der Termin wird nur im Kalender des Postfachs angelegt. Der Kunde bekommt dadurch keine Nachricht.</p></form>`);
}

const AKTIONEN = ['eintragen', 'verwerfen'];

function formularLesen(body, anzahl) {
	const b = body && typeof body === 'object' ? body : {};
	const aktion = String(b.aktion || '');
	if (!AKTIONEN.includes(aktion)) return { ok: false, meldung: 'Unbekannte Aktion.' };
	if (aktion === 'verwerfen') return { ok: true, aktion };
	const i = Number(b.slot);
	if (!Number.isInteger(i) || i < 0 || i >= anzahl) return { ok: false, meldung: 'Bitte eine Zeit auswählen.' };
	return { ok: true, aktion, slot: i };
}

/** Prüft die Termin-Zeile vor Anzeige bzw. Entscheidung. */
function terminPruefen(termin, jetztIso) {
	const nein = (status, meldung) => ({ ok: false, status, meldung });
	if (!termin || termin.id === undefined) return nein(404, 'Dieser Link ist ungültig.');
	if (termin.status === 'eingetragen') return nein(409, 'Dieser Termin wurde bereits eingetragen.');
	if (termin.status === 'verworfen') return nein(409, 'Dieser Termin wurde bereits verworfen.');
	if (termin.status === 'in_arbeit') return nein(409, 'Dieser Termin wird gerade eingetragen.');
	if (termin.status === 'fehler') return nein(409, 'Das Eintragen ist fehlgeschlagen. Bitte den Termin direkt in Outlook anlegen.');
	if (termin.status !== 'offen') return nein(409, 'Dieser Link ist nicht mehr gültig.');
	if (new Date(termin.ablauf).getTime() <= new Date(jetztIso).getTime()) return nein(410, 'Dieser Link ist abgelaufen. Bitte den Termin direkt in Outlook anlegen.');
	return { ok: true };
}

module.exports = {
	STANDARD, ZEITRAEUME, uhrzeitLesen, offsetMinuten, zuIso, lokal, datumText, einstellungen, plan, belegt, bewerten, ausweichen,
	ereignis, meldung, wunschText, optionen, seiteFormular, formularLesen, terminPruefen, AKTIONEN,
};
