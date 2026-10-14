'use strict';
// M5-Szenarien (Phase E: Nachfassen, Eskalation, Freigeber-Erinnerung, Lauf-Lock) für tools/e2e-eingang.js.
// EPA-04 wird mit einem simulierten Zeitpunkt "jetzt" aufgerufen (nächster Werktag, Geschäftszeit). Fristen
// werden dazu in der Tabelle vorgezogen. Freigabe-Links prüft EPA-07 weiter gegen die echte Uhrzeit.
const { DateTime } = require('luxon');
const { mail, kl, ex, VOLL } = require('../../test/daten/testmails');
const { seite, tokenAus, unescapeHtml } = require('./e2e-freigabe');
const { LOCK_SCHLUESSEL, EPOCHE } = require('../../src/nachfassen');
const fristen = require('../../src/fristen');

/** Nächster Werktag (NRW) mindestens `abTagen` nach heute, Uhrzeit Berlin. */
function werktag(abTagen, stunde) {
	let d = DateTime.now().setZone('Europe/Berlin').plus({ days: abTagen }).set({ hour: stunde, minute: 0, second: 0, millisecond: 0 });
	const cfg = { zeitzone: 'Europe/Berlin', geschaeftszeiten: { tage: [1, 2, 3, 4, 5], von: '08:00', bis: '17:00' }, feiertage_region: 'NW' };
	while (!fristen.istGeschaeftszeit(d.toISO(), cfg)) d = d.plus({ days: 1 });
	return d;
}

async function nachfassSzenarien(ctx) {
	const { mock, aufrufen, tabelle, api, ids, KUNDE, POSTFACH, FREIGEBER, nur } = ctx;
	const zeilen = [];
	const S = werktag(2, 10); // simuliertes "jetzt" für EPA-04
	const iso = (d) => d.toUTC().toISO();

	const zeile = async (id, szenario, fn) => {
		if (nur.length && !nur.includes(id) && !nur.includes('N')) return;
		const soll = [];
		const ist = [];
		const pruef = [];
		const check = (name, erwartet, tatsaechlich) => {
			soll.push(`${name}: ${erwartet}`);
			ist.push(`${name}: ${tatsaechlich}`);
			pruef.push(String(erwartet) === String(tatsaechlich));
		};
		try {
			await fn(check);
		} catch (e) {
			check('Ablauf', 'ohne Ausnahme', `Ausnahme: ${e.message}`);
		}
		const ok = pruef.length > 0 && pruef.every(Boolean);
		zeilen.push({ id, szenario, soll: soll.join('; '), ist: ist.join('; '), ok });
		console.log(`${ok ? 'ok    ' : 'FEHLER'} ${id} ${szenario}${ok ? '' : `\n       soll: ${soll.join('; ')}\n       ist:  ${ist.join('; ')}`}`);
	};

	const lesen = async (t, spalte, wert) => (await tabelle(t)).filter((r) => r[spalte] === wert);
	const vorgang = async (vid) => (await lesen('epa_vorgaenge', 'vorgangs_id', vid))[0] || null;
	const freigabe = async (fid) => (await lesen('epa_freigaben', 'freigabe_id', fid))[0] || null;
	const aktualisieren = (t, spalte, wert, daten) => api('PATCH', `/data-tables/${ids[t]}/rows/update`, {
		filter: { type: 'and', filters: [{ columnName: spalte, condition: 'eq', value: wert }] }, data: daten,
	});
	const lockSetzen = (daten) => aktualisieren('epa_system_status', 'schluessel', LOCK_SCHLUESSEL, daten);
	const lock = async () => (await lesen('epa_system_status', 'schluessel', LOCK_SCHLUESSEL))[0] || null;
	const lauf = async (jetzt = S) => (await aufrufen('nachfassen', { jetzt: iso(jetzt) })).json;
	const json = (s, d) => {
		try {
			return JSON.parse(s || '');
		} catch {
			return d;
		}
	};
	/** Fristen anderer Test-Vorgänge in die Zukunft schieben, damit jeder Lauf nur den eigenen Fall sieht. */
	async function andereRuhigstellen(vid) {
		for (const v of (await tabelle('epa_vorgaenge')).filter((x) => x.status === 'Warten auf Kunde' && x.vorgangs_id !== vid)) {
			await aktualisieren('epa_vorgaenge', 'vorgangs_id', v.vorgangs_id, { antwort_frist: iso(S.plus({ days: 30 })) });
		}
		for (const f of (await tabelle('epa_freigaben')).filter((x) => x.status === 'offen' && x.vorgangs_id !== vid)) {
			await aktualisieren('epa_freigaben', 'freigabe_id', f.freigabe_id, { status: 'ersetzt' });
		}
	}
	const linksSeit = (vorher, vid) => {
		const links = {};
		for (const c of mock.zustand.chats.slice(vorher)) {
			const href = (String(c.content).match(/href="([^"]+)"/) || [])[1];
			if (href && String(c.content).includes(vid)) links[c.freigeber] = { link: unescapeHtml(href), text: String(c.content) };
		}
		return links;
	};

	async function anfrage(id, fehlt) {
		const m = mail(id, { betreff: `Transportanfrage ${id}`, von: `kunde-${id.toLowerCase()}@kunde-n.example`, name: 'Erika Mustermann', text: 'Bitte Angebot, Details folgen.' });
		mock.zustand.graphMails.set(m.id, { mail: m, anhaenge: [] });
		mock.fall({ klassifizierung: [kl('anfrage')], extraktion: [ex({ ...VOLL, ...Object.fromEntries(fehlt.map((f) => [f, null])) })] });
		const vorher = mock.zustand.chats.length;
		const r = await aufrufen('eingang', { postfach: POSTFACH, mail: m, anhaenge: [] });
		const vid = r.json.vorgangs_id;
		const v = await vorgang(vid);
		return { mail: m, vid, freigabe_id: v.freigabe_id_aktuell, links: linksSeit(vorher, vid) };
	}

	async function freigeben(link, fid) {
		const fg = await freigabe(fid);
		const s = await seite(link, { t: tokenAus(link), aktion: 'senden', text: fg.entwurf_text, grund: '' });
		if (s.status !== 200) throw new Error(`Freigabe fehlgeschlagen (${s.status} ${s.titel})`);
		return s;
	}

	/** Vorgang mit gesendeter Rückfrage im Status "Warten auf Kunde", Frist vor S. */
	async function wartenderVorgang(id, fehlt) {
		const a = await anfrage(id, fehlt);
		await freigeben(a.links[FREIGEBER[0]].link, a.freigabe_id);
		await aktualisieren('epa_vorgaenge', 'vorgangs_id', a.vid, { antwort_frist: iso(S.minus({ hours: 1 })) });
		await andereRuhigstellen(a.vid);
		return a;
	}

	await lockSetzen({ lock_bis: EPOCHE, lock_durch: '' });

	// ---------------------------------------------------------------- N01–N03 Kunde antwortet nie
	const n = {};
	await zeile('N01', 'Frist abgelaufen: Erinnerung als Entwurf mit Freigabe (Vorlage, keine KI), Versand erst nach Freigabe', async (check) => {
		const a = await wartenderVorgang('N01', ['Telefon', 'Gewicht_kg']);
		n.a = a;
		const gesendetVorher = mock.zustand.gesendet.length;
		const chatsVorher = mock.zustand.chats.length;
		mock.fall({});
		const r = await lauf();
		check('Lauf', 'lauf_beendet', r.ergebnis);
		check('Aufgaben', 'erinnerung:erinnerung_freigabe_angefordert=1', Object.entries(r.ergebnisse || {}).map(([k, v]) => `${k}=${v}`).join(', '));
		const v = await vorgang(a.vid);
		check('Status', 'Freigabe ausstehend', v.status);
		const fg = await freigabe(v.freigabe_id_aktuell);
		check('Freigabe Art/Runde', 'erinnerung/1', `${fg.art}/${fg.runde}`);
		check('Text aus Vorlage', 'ja', /freundlich an unsere letzte Nachricht erinnern/.test(fg.entwurf_text) ? 'ja' : 'nein');
		check('Bausteine offener Felder', 'ja', /Telefonnummer/.test(fg.entwurf_text) && /Gesamtgewicht/.test(fg.entwurf_text) ? 'ja' : 'nein');
		check('KI-Aufrufe', 0, mock.zustand.llmAnfragen.length);
		check('Nichts gesendet vor Freigabe', gesendetVorher, mock.zustand.gesendet.length);
		const links = linksSeit(chatsVorher, a.vid);
		check('Freigeber benachrichtigt', 2, Object.keys(links).length);
		check('Nachricht: Erinnerung', 'ja', /Erinnerung an den Kunden freigeben/.test(links[FREIGEBER[0]]?.text || '') ? 'ja' : 'nein');
		const audit = (await lesen('epa_audit_log', 'vorgangs_id', a.vid)).find((x) => x.typ === 'STATUS' && x.neu === 'Freigabe ausstehend' && x.ausloeser === 'Cronjob');
		check('Audit Auslöser Cronjob', 'ja', audit ? 'ja' : 'nein');
		const formular = await seite(links[FREIGEBER[1]].link);
		check('Formular-Titel', `Erinnerung freigeben – ${a.vid}`, formular.titel);
		const s = await freigeben(links[FREIGEBER[1]].link, fg.freigabe_id);
		check('Seite', 'Erinnerung gesendet', s.titel);
		const nach = await vorgang(a.vid);
		check('Status nach Versand', 'Warten auf Kunde', nach.status);
		check('Erinnerungen/Runde', '1/1', `${nach.erinnerungen_gesendet}/${nach.rundenzaehler}`);
		check('Gesendet', gesendetVorher + 1, mock.zustand.gesendet.length);
		const cfg = { zeitzone: 'Europe/Berlin', frist_nur_geschaeftszeit: true, geschaeftszeiten: { tage: [1, 2, 3, 4, 5], von: '08:00', bis: '17:00' }, feiertage_region: 'NW' };
		const erwartet = new Date(fristen.berechneFrist(new Date().toISOString(), 24, cfg)).getTime();
		check('Neue Frist = Erinnerungsintervall (±5 min)', 'ja', Math.abs(new Date(nach.antwort_frist).getTime() - erwartet) < 300000 ? 'ja' : 'nein');
	});

	await zeile('N02', 'Zweite Frist verpasst: zweite Erinnerung (Zähler 2), Rundenzähler bleibt', async (check) => {
		const a = n.a;
		await aktualisieren('epa_vorgaenge', 'vorgangs_id', a.vid, { antwort_frist: iso(S.minus({ hours: 1 })) });
		const chatsVorher = mock.zustand.chats.length;
		const r = await lauf();
		check('Aufgabe', 'erinnerung', Object.keys(r.ergebnisse || {}).join(',').split(':')[0]);
		const links = linksSeit(chatsVorher, a.vid);
		const v = await vorgang(a.vid);
		await freigeben(links[FREIGEBER[0]].link, v.freigabe_id_aktuell);
		const nach = await vorgang(a.vid);
		check('Erinnerungen/Runde', '2/1', `${nach.erinnerungen_gesendet}/${nach.rundenzaehler}`);
		check('Status', 'Warten auf Kunde', nach.status);
	});

	await zeile('N03', 'Alle Erinnerungen gesendet und Frist verpasst: Eskaliert / Manuell, Meldung „telefonisch kontaktieren“', async (check) => {
		const a = n.a;
		await aktualisieren('epa_vorgaenge', 'vorgangs_id', a.vid, { antwort_frist: iso(S.minus({ hours: 1 })) });
		const fehlerVorher = Math.max(0, ...(await tabelle('epa_fehler_log')).map((z) => z.id));
		const gesendetVorher = mock.zustand.gesendet.length;
		const r = await lauf();
		check('Aufgaben', 'eskalation:eskaliert=1', Object.entries(r.ergebnisse || {}).map(([k, v]) => `${k}=${v}`).join(', '));
		const v = await vorgang(a.vid);
		check('Status', 'Eskaliert / Manuell', v.status);
		const audit = (await lesen('epa_audit_log', 'vorgangs_id', a.vid)).find((x) => x.typ === 'STATUS' && x.neu === 'Eskaliert / Manuell');
		const d = json(audit && audit.details, {});
		const erste = (await lesen('epa_freigaben', 'vorgangs_id', a.vid)).find((f) => f.art === 'rueckfrage' && f.status === 'gesendet');
		const tage = Math.floor((S.toMillis() - new Date(erste.gesendet_am).getTime()) / 86400000);
		check('Audit Cronjob, Grund, Erinnerungen, Tage seit Rückfrage', `Cronjob/Kunde reagiert nicht auf Nachfragen/2/${tage}`, `${audit && audit.ausloeser}/${d.grund}/${d.erinnerungen_gesendet}/${d.tage_ohne_reaktion}`);
		check('Keine weitere Mail', gesendetVorher, mock.zustand.gesendet.length);
		// Lokal ist Teams nur ein Dummy: die Meldung an den Kanal wird versucht und als Zustellfehler protokolliert.
		const teams = (await tabelle('epa_fehler_log')).filter((z) => z.id > fehlerVorher && z.vorgangs_id === a.vid && z.node === 'Teams-Nachricht senden');
		check('Kanalmeldung versucht', 'ja', teams.length ? 'ja' : 'nein');
		const r2 = await lauf();
		check('Nächster Lauf: nichts mehr zu tun', 0, r2.aufgaben);
	});

	// ---------------------------------------------------------------- N04 Geschäftszeit
	await zeile('N04', 'Außerhalb der Geschäftszeit (Samstag, nachts): nichts passiert, wird später nachgeholt', async (check) => {
		const a = await wartenderVorgang('N04', ['Telefon']);
		n.n04 = a;
		let samstag = S;
		while (samstag.weekday !== 6) samstag = samstag.plus({ days: 1 });
		const r1 = await lauf(samstag);
		const r2 = await lauf(S.set({ hour: 22 }));
		check('Aufgaben Samstag/nachts', '0/0', `${r1.aufgaben}/${r2.aufgaben}`);
		check('Übersprungen gezählt', '1/1', `${r1.uebersprungen}/${r2.uebersprungen}`);
		check('Status unverändert', 'Warten auf Kunde', (await vorgang(a.vid)).status);
	});

	// ---------------------------------------------------------------- N05/N06 Lauf-Lock
	await zeile('N05', 'Lauf-Lock belegt (anderer Lauf aktiv): sofort beenden, nichts doppelt', async (check) => {
		const a = n.n04;
		await lockSetzen({ lock_bis: iso(DateTime.now().plus({ minutes: 30 })), lock_durch: 'fremder-lauf' });
		const r = await lauf();
		check('Ergebnis', 'uebersprungen_lauf_aktiv', r.ergebnis);
		check('Aktiver Lauf', 'fremder-lauf', r.aktiver_lauf);
		check('Status unverändert', 'Warten auf Kunde', (await vorgang(a.vid)).status);
		const l = await lock();
		check('Fremder Lock bleibt', 'fremder-lauf', l.lock_durch);
		// abgelaufener Lock (Lauf abgestürzt) wird übernommen
		await lockSetzen({ lock_bis: iso(DateTime.now().minus({ minutes: 1 })), lock_durch: 'abgestuerzt' });
		const r2 = await lauf(S.set({ hour: 22 }));
		check('Abgelaufener Lock übernommen', 'lauf_beendet', r2.ergebnis);
		const l2 = await lock();
		check('Lock danach frei', `${EPOCHE}/`, `${new Date(l2.lock_bis).toISOString()}/${l2.lock_durch}`);
		check('Ergebnis ohne Personendaten', 'ja', !String(l2.letztes_ergebnis).includes('@') ? 'ja' : 'nein');
	});

	await zeile('N06', 'Zwei Läufe gleichzeitig: genau einer arbeitet, genau eine Erinnerung', async (check) => {
		const a = n.n04;
		const freigabenVorher = (await lesen('epa_freigaben', 'vorgangs_id', a.vid)).length;
		const [r1, r2] = await Promise.all([lauf(), lauf()]);
		check('Ergebnisse', 'lauf_beendet, uebersprungen_lauf_aktiv', [r1.ergebnis, r2.ergebnis].sort().join(', '));
		const neu = (await lesen('epa_freigaben', 'vorgangs_id', a.vid)).length - freigabenVorher;
		check('Neue Freigaben', 1, neu);
		check('Status', 'Freigabe ausstehend', (await vorgang(a.vid)).status);
	});

	// ---------------------------------------------------------------- N07 Antwort während offener Erinnerung
	await zeile('N07', 'Kunde antwortet, während die Erinnerung auf Freigabe wartet: Erinnerung ersetzt, Link 409', async (check) => {
		const a = n.n04;
		const v = await vorgang(a.vid);
		const fgId = v.freigabe_id_aktuell;
		const chats = mock.zustand.chats.filter((c) => String(c.content).includes(a.vid) && /Erinnerung an den Kunden/.test(c.content));
		const link = unescapeHtml((String(chats[chats.length - 1].content).match(/href="([^"]+)"/) || [])[1]);
		const m = mail('N07R', { betreff: `AW: ${a.mail.subject}`, von: a.mail.from.emailAddress.address, name: 'Erika Mustermann', text: 'Telefon 0221 444555.', conversation: a.mail.conversationId, headers: [{ name: 'In-Reply-To', value: a.mail.internetMessageId }] });
		mock.zustand.graphMails.set(m.id, { mail: m, anhaenge: [] });
		mock.fall({ extraktion: [ex({ Telefon: '0221 444555' })] });
		const r = await aufrufen('eingang', { postfach: POSTFACH, mail: m, anhaenge: [] });
		check('Ergebnis', 'antwort_bereit', r.json.ergebnis);
		check('Erinnerung ersetzt', 'ersetzt', (await freigabe(fgId)).status);
		check('Alter Link', 409, (await seite(link)).status);
		check('Status', 'Bereit zur Bearbeitung', (await vorgang(a.vid)).status);
	});

	// ---------------------------------------------------------------- N08/N09 Freigeber
	await zeile('N08', 'Freigabe seit freigabe_erinnerung_stunden offen: Erinnerung mit neuem Link, alter Link gilt weiter, nur einmal', async (check) => {
		const a = await anfrage('N08', ['Telefon']);
		n.n08 = a;
		await andereRuhigstellen(a.vid);
		const T = S.set({ hour: 15 });
		await aktualisieren('epa_freigaben', 'freigabe_id', a.freigabe_id, { erneuert_am: iso(T.minus({ hours: 5 })), ablauf: iso(T.plus({ days: 1 })) });
		const chatsVorher = mock.zustand.chats.length;
		const r = await lauf(T);
		check('Aufgaben', 'freigabe_erinnerung:freigeber_erinnert=1', Object.entries(r.ergebnisse || {}).map(([k, v]) => `${k}=${v}`).join(', '));
		const links = linksSeit(chatsVorher, a.vid);
		check('Neue Links', 2, Object.keys(links).length);
		check('Hinweis „noch offen“', 'ja', /noch offen/.test(links[FREIGEBER[0]]?.text || '') ? 'ja' : 'nein');
		const fg = await freigabe(a.freigabe_id);
		check('erinnert_am gesetzt', 'ja', fg.erinnert_am ? 'ja' : 'nein');
		const tokens = await lesen('epa_freigabe_tokens', 'freigabe_id', a.freigabe_id);
		check('Tokens (alt + neu)', 4, tokens.length);
		check('Alter Link', 200, (await seite(a.links[FREIGEBER[0]].link)).status);
		check('Neuer Link', 200, (await seite(links[FREIGEBER[0]].link)).status);
		const r2 = await lauf(T.plus({ minutes: 30 }));
		check('Zweiter Lauf: keine weitere Erinnerung', 0, r2.aufgaben);
		n.n08links = links;
	});

	await zeile('N09', 'Freigabe abgelaufen: neue Ablaufzeit, alle alten Links 410, neue Links funktionieren, Versand danach möglich', async (check) => {
		const a = n.n08;
		await aktualisieren('epa_freigaben', 'freigabe_id', a.freigabe_id, { ablauf: iso(S.minus({ minutes: 1 })) });
		const chatsVorher = mock.zustand.chats.length;
		const r = await lauf();
		check('Aufgaben', 'freigabe_erneuern:links_erneuert=1', Object.entries(r.ergebnisse || {}).map(([k, v]) => `${k}=${v}`).join(', '));
		const fg = await freigabe(a.freigabe_id);
		check('Neue Ablaufzeit', iso(S.plus({ hours: 48 })), DateTime.fromISO(new Date(fg.ablauf).toISOString()).toUTC().toISO());
		check('Erneuert/erinnert', 'ja/leer', `${fg.erneuert_am ? 'ja' : 'nein'}/${fg.erinnert_am ? 'gesetzt' : 'leer'}`);
		const links = linksSeit(chatsVorher, a.vid);
		check('Hinweis „abgelaufen“', 'ja', /bisherige Link ist abgelaufen/.test(links[FREIGEBER[0]]?.text || '') ? 'ja' : 'nein');
		check('Erster Link (M3)', 410, (await seite(a.links[FREIGEBER[0]].link)).status);
		check('Link aus Erinnerung', 410, (await seite(n.n08links[FREIGEBER[1]].link)).status);
		check('Neuer Link', 200, (await seite(links[FREIGEBER[1]].link)).status);
		const s = await freigeben(links[FREIGEBER[1]].link, a.freigabe_id);
		check('Versand mit neuem Link', 'Rückfrage gesendet', s.titel);
		check('Status', 'Warten auf Kunde', (await vorgang(a.vid)).status);
	});

	// ---------------------------------------------------------------- N10 Config ungültig
	await zeile('N10', 'Config eines Kunden fehlt/ungültig: Aufgabe blockiert, Alarm (424) statt stillem Überspringen, Lock trotzdem frei', async (check) => {
		const fehlerVorher = Math.max(0, ...(await tabelle('epa_fehler_log')).map((z) => z.id));
		await api('POST', `/data-tables/${ids.epa_vorgaenge}/rows`, { data: [{ vorgangs_id: 'V-2026-9999', kunde_id: `${KUNDE}-ohne-config`, status: 'Warten auf Kunde', antwort_frist: iso(S.minus({ hours: 2 })), version: 1, erinnerungen_gesendet: 0, rundenzaehler: 1 }], returnType: 'count' });
		try {
			await lauf();
			await new Promise((ok) => setTimeout(ok, 3000));
			const neu = (await tabelle('epa_fehler_log')).filter((z) => z.id > fehlerVorher && z.fehlercode === 'KONFIGURATIONSFEHLER' && /Nachfassen blockiert/.test(z.meldung));
			check('Fehlerlog', '424 KONFIGURATIONSFEHLER', neu.length ? `${neu[0].statuscode} ${neu[0].fehlercode}` : 'keiner');
			check('Kunde genannt', 'ja', neu.length && neu[0].meldung.includes(`${KUNDE}-ohne-config`) ? 'ja' : 'nein');
			const l = await lock();
			check('Lock frei', '', l.lock_durch);
		} finally {
			await api('DELETE', `/data-tables/${ids.epa_vorgaenge}/rows/delete?filter=${encodeURIComponent(JSON.stringify({ type: 'and', filters: [{ columnName: 'kunde_id', condition: 'eq', value: `${KUNDE}-ohne-config` }] }))}`);
		}
	});

	return zeilen;
}

module.exports = { nachfassSzenarien, werktag };
