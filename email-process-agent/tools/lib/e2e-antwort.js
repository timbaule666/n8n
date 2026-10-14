'use strict';
// M4-Szenarien (Phase D: Antworten des Kunden) für tools/e2e-eingang.js.
const { mail, kl, ex, VOLL } = require('../../test/daten/testmails');
const { seite, tokenAus, unescapeHtml } = require('./e2e-freigabe');

async function antwortSzenarien(ctx) {
	const { mock, aufrufen, tabelle, api, ids, KUNDE, POSTFACH, FREIGEBER, nur } = ctx;
	const zeilen = [];
	const z = {};

	const zeile = async (id, szenario, fn) => {
		if (nur.length && !nur.includes(id) && !nur.includes('A')) return;
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
	const json = (s, d) => {
		try {
			return JSON.parse(s || '');
		} catch {
			return d;
		}
	};
	const fehlend = (v) => json(v.fehlende_felder, []).map((f) => f.feldname).sort().join(', ') || '–';

	/** Neue Anfrage mit Lücken -> Rückfrage zur Freigabe; liefert Kontext inkl. Links. */
	async function anfrage(id, fehlt) {
		const m = mail(id, { betreff: `Transportanfrage ${id}`, von: `kunde-${id.toLowerCase()}@kunde-g.example`, name: 'Erika Mustermann', text: 'Bitte Angebot, Details folgen.' });
		mock.zustand.graphMails.set(m.id, { mail: m, anhaenge: [] });
		mock.fall({ klassifizierung: [kl('anfrage')], extraktion: [ex({ ...VOLL, ...Object.fromEntries(fehlt.map((f) => [f, null])) })] });
		const chatsVorher = mock.zustand.chats.length;
		const r = await aufrufen('eingang', { postfach: POSTFACH, mail: m, anhaenge: [] });
		const vid = r.json.vorgangs_id;
		return { mail: m, vid, ...(await rueckfrageStand(vid, chatsVorher)) };
	}

	async function rueckfrageStand(vid, chatsVorher) {
		const v = await vorgang(vid);
		const fg = v && v.freigabe_id_aktuell ? await freigabe(v.freigabe_id_aktuell) : null;
		const links = {};
		for (const c of mock.zustand.chats.slice(chatsVorher)) {
			const href = (String(c.content).match(/href="([^"]+)"/) || [])[1];
			if (href && String(c.content).includes(vid)) links[c.freigeber] = unescapeHtml(href);
		}
		return { vorgang: v, freigabe: fg, links };
	}

	/** Freigeber 1 gibt die aktuelle Rückfrage frei; liefert den gesendeten Entwurf. */
	async function freigeben(stand) {
		const link = stand.links[FREIGEBER[0]];
		const s = await seite(link, { t: tokenAus(link), aktion: 'senden', text: stand.freigabe.entwurf_text, grund: '' });
		if (s.status !== 200) throw new Error(`Freigabe fehlgeschlagen (${s.status} ${s.titel})`);
		return mock.zustand.entwuerfe.get(stand.freigabe.entwurf_id);
	}

	/** Kunde antwortet im Thread auf die gesendete Rückfrage (bzw. auf seine erste Mail). */
	async function antwort(a, id, text, extraktion, { bezug } = {}) {
		const ref = bezug || a.gesendet;
		const m = mail(id, {
			betreff: ref ? ref.subject.replace(/^RE:\s*/, 'AW: ') : `AW: ${a.mail.subject}`,
			von: a.mail.from.emailAddress.address, name: 'Erika Mustermann', text,
			conversation: a.mail.conversationId,
			headers: ref ? [{ name: 'In-Reply-To', value: ref.internetMessageId }, { name: 'References', value: `${a.mail.internetMessageId} ${ref.internetMessageId}` }] : [{ name: 'In-Reply-To', value: a.mail.internetMessageId }],
		});
		mock.zustand.graphMails.set(m.id, { mail: m, anhaenge: [] });
		mock.fall(extraktion === undefined ? {} : { extraktion });
		const chatsVorher = mock.zustand.chats.length;
		const r = await aufrufen('eingang', { postfach: POSTFACH, mail: m, anhaenge: [] });
		return { r: r.json, mail: m, llm: [...mock.zustand.llmAnfragen], chatsVorher };
	}

	// ---------------------------------------------------------------- A01 vollständige Antwort
	await zeile('A01', 'Antwort ergänzt alle Lücken: übernommen, Audit MERGE, Bereit zur Bearbeitung', async (check) => {
		const a = await anfrage('A01', ['Telefon', 'Gewicht_kg', 'Packstuecke']);
		a.gesendet = await freigeben(a);
		const ant = await antwort(a, 'A01R', 'Gewicht ca. 800 kg, Telefon 0221 555123.', [ex({ Telefon: '0221 555123', Gewicht_kg: '800' })]);
		check('Ergebnis', 'antwort_bereit', ant.r.ergebnis);
		const v = await vorgang(a.vid);
		check('Status', 'Bereit zur Bearbeitung', v.status);
		check('Lücken', '–', fehlend(v));
		const d = json(v.extrahierte_daten, {});
		check('Übernommen', '0221555123/800', `${d.Telefon && d.Telefon.wert}/${d.Gewicht_kg && d.Gewicht_kg.wert}`);
		check('Bekannte Werte unverändert', '50667', d.Start_PLZ && d.Start_PLZ.wert);
		const merge = (await lesen('epa_audit_log', 'vorgangs_id', a.vid)).filter((x) => x.typ === 'MERGE');
		check('Audit MERGE (Feld, neu, Quelle)', 'Gewicht_kg=800, Telefon=0221555123', merge.map((x) => `${json(x.details, {}).feld}=${x.neu}`).sort().join(', '));
		check('Rundenzähler unverändert', 1, v.rundenzaehler);
		check('Extraktion: Hinweis offene Felder', 'ja', JSON.stringify(ant.llm.find((x) => x.aufgabe === 'extraktion')?.body || '').includes('Noch offene Angaben') ? 'ja' : 'nein');
		z.a01 = a;
	});

	// ---------------------------------------------------------------- A02 Teilantwort, Runde 2
	await zeile('A02', 'Teilantwort: Rest bleibt offen, Runde 2 mit neuer Freigabe, dann zweiter Versand', async (check) => {
		const a = await anfrage('A02', ['Telefon', 'Gewicht_kg']);
		a.gesendet = await freigeben(a);
		const ant = await antwort(a, 'A02R', 'Gewicht 800 kg. Telefon reiche ich nach.', [ex({ Gewicht_kg: '800' })]);
		check('Ergebnis', 'antwort_luecken', ant.r.ergebnis);
		const stand = await rueckfrageStand(a.vid, ant.chatsVorher);
		check('Status', 'Freigabe ausstehend', stand.vorgang.status);
		check('Lücken', 'Telefon', fehlend(stand.vorgang));
		check('Neue Freigabe Runde', 2, stand.freigabe && stand.freigabe.runde);
		check('Neue Links', FREIGEBER.length, Object.keys(stand.links).length);
		check('Neuer Entwurf nur mit offenem Baustein', 'ja', stand.freigabe && stand.freigabe.entwurf_text.includes('Telefonnummer') && !stand.freigabe.entwurf_text.includes('Gesamtgewicht') ? 'ja' : 'nein');
		a.gesendet = await freigeben(stand);
		const v = await vorgang(a.vid);
		check('Nach 2. Versand', 'Warten auf Kunde/2', `${v.status}/${v.rundenzaehler}`);
		z.a02 = a;
	});

	// ---------------------------------------------------------------- A03 Widerspruch
	await zeile('A03', 'Widerspruch zu vorhandenen Daten: nicht übernommen, Konflikt gespeichert und protokolliert', async (check) => {
		const a = await anfrage('A03', ['Telefon']);
		a.gesendet = await freigeben(a);
		const ant = await antwort(a, 'A03R', 'Abholung doch in 50668, Telefon 0221 1111111.', [ex({ Start_PLZ: '50668', Telefon: '0221 1111111' })]);
		check('Ergebnis', 'antwort_bereit', ant.r.ergebnis);
		const v = await vorgang(a.vid);
		const d = json(v.extrahierte_daten, {});
		check('Alter Wert bleibt', '50667', d.Start_PLZ.wert);
		check('Lücke gefüllt', '02211111111', d.Telefon.wert);
		const k = json(v.konflikte, []);
		check('Konflikt', 'Start_PLZ: 50667 -> 50668', k.map((x) => `${x.feldname}: ${x.alt} -> ${x.neu}`).join('; '));
		const audit = (await lesen('epa_audit_log', 'vorgangs_id', a.vid)).filter((x) => x.typ === 'MERGE' && json(x.details, {}).konflikt === true);
		check('Audit Konflikt', '50667 -> 50668', audit.map((x) => `${x.alt} -> ${x.neu}`).join('; '));
	});

	// ---------------------------------------------------------------- A04 Vertröstung
	await zeile('A04', 'Antwort ohne Angaben (Vertröstung): Status bleibt, Frist verlängert, Audit', async (check) => {
		const a = await anfrage('A04', ['Telefon']);
		a.gesendet = await freigeben(a);
		const vorher = await vorgang(a.vid);
		// Frist künstlich nah setzen, damit die Verlängerung sichtbar wird
		const nah = new Date(Date.now() + 3600000).toISOString();
		await aktualisieren('epa_vorgaenge', 'vorgangs_id', a.vid, { antwort_frist: nah });
		const ant = await antwort(a, 'A04R', 'Danke, ich melde mich morgen mit der Nummer.', [ex({})]);
		check('Ergebnis', 'antwort_keine_daten', ant.r.ergebnis);
		const v = await vorgang(a.vid);
		check('Status', 'Warten auf Kunde', v.status);
		check('Rundenzähler', vorher.rundenzaehler, v.rundenzaehler);
		check('Frist verlängert', 'ja', new Date(v.antwort_frist) > new Date(nah) ? 'ja' : 'nein');
		check('Mail am Vorgang', 'ja', json(v.bekannte_message_ids, []).includes(ant.mail.internetMessageId) ? 'ja' : 'nein');
		check('Audit', 'ja', (await lesen('epa_audit_log', 'vorgangs_id', a.vid)).some((x) => x.neu === 'Antwort ohne verwertbare Angaben') ? 'ja' : 'nein');
		check('Keine neue Rückfrage', 0, mock.zustand.chats.length - ant.chatsVorher);
	});

	// ---------------------------------------------------------------- A05 Antwort während Freigabe
	await zeile('A05', 'Kunde antwortet, während die Rückfrage noch auf Freigabe wartet: Freigabe ersetzt, alter Link 409', async (check) => {
		const a = await anfrage('A05', ['Telefon']);
		const alteFreigabe = a.freigabe;
		const ant = await antwort(a, 'A05R', 'Ach ja, Telefon 0221 222333.', [ex({ Telefon: '0221 222333' })]);
		check('Ergebnis', 'antwort_bereit', ant.r.ergebnis);
		check('Status', 'Bereit zur Bearbeitung', (await vorgang(a.vid)).status);
		check('Alte Freigabe', 'ersetzt', (await freigabe(alteFreigabe.freigabe_id)).status);
		const s = await seite(a.links[FREIGEBER[0]]);
		check('Alter Link', 409, s.status);
		check('Nichts gesendet', 'ja', !mock.zustand.entwuerfe.get(alteFreigabe.entwurf_id).gesendet ? 'ja' : 'nein');
	});

	// ---------------------------------------------------------------- A06 Nachtrag
	await zeile('A06', 'Nachtrag nach "Bereit zur Bearbeitung": optionale Angabe übernommen, wieder Bereit', async (check) => {
		const a = z.a01;
		const ant = await antwort(a, 'A06R', 'Nachtrag: es sind 4 Packstücke.', [ex({ Packstuecke: '4' })]);
		check('Ergebnis', 'antwort_bereit', ant.r.ergebnis);
		const v = await vorgang(a.vid);
		check('Status', 'Bereit zur Bearbeitung', v.status);
		check('Packstücke', 4, json(v.extrahierte_daten, {}).Packstuecke.wert);
		const st = (await lesen('epa_audit_log', 'vorgangs_id', a.vid)).filter((x) => x.typ === 'STATUS').map((x) => x.neu).slice(-2).join(' -> ');
		check('Statusfolge', 'In Prüfung -> Bereit zur Bearbeitung', st);
	});

	// ---------------------------------------------------------------- A07 Rundenlimit
	await zeile('A07', 'Rundenlimit erreicht: weitere Teilantwort führt zur Eskalation statt neuer Rückfrage', async (check) => {
		const a = z.a02; // 2 Runden gesendet
		await aktualisieren('epa_config_allgemein', 'kunde_id', KUNDE, { max_runden: 2 });
		try {
			const ant = await antwort(a, 'A07R', 'Telefon habe ich leider noch nicht.', [ex({ Telefon: 'tbd' })]);
			check('Ergebnis', 'antwort_keine_daten', ant.r.ergebnis); // Platzhalter = keine Angabe
			const ant2 = await antwort(a, 'A07S', 'Ladungsart: Palette.', [ex({ Ladungsart: 'Palette' })]);
			check('Ergebnis Teilantwort', 'antwort_luecken', ant2.r.ergebnis);
			const v = await vorgang(a.vid);
			check('Status', 'Eskaliert / Manuell', v.status);
			check('Kein neuer Link', 0, mock.zustand.chats.length - ant2.chatsVorher);
		} finally {
			await aktualisieren('epa_config_allgemein', 'kunde_id', KUNDE, { max_runden: 3 });
		}
	});

	// ---------------------------------------------------------------- A08 manuelle Bearbeitung
	await zeile('A08', 'Antwort zu eskaliertem Vorgang: nur angehängt und gemeldet, keine KI-Auswertung', async (check) => {
		const a = z.a02; // nach A07 eskaliert
		const ant = await antwort(a, 'A08R', 'Telefon 0221 999888.', [ex({ Telefon: '0221 999888' })]);
		check('Ergebnis', 'antwort_gemeldet', ant.r.ergebnis);
		check('Extraktion', 0, ant.llm.filter((x) => x.aufgabe === 'extraktion').length);
		const v = await vorgang(a.vid);
		check('Status', 'Eskaliert / Manuell', v.status);
		check('Mail am Vorgang', 'ja', json(v.bekannte_message_ids, []).includes(ant.mail.internetMessageId) ? 'ja' : 'nein');
	});

	// ---------------------------------------------------------------- A09 Zitat
	await zeile('A09', 'Antwort mit zitiertem Verlauf: nur der neue Teil geht an die KI', async (check) => {
		const a = await anfrage('A09', ['Telefon']);
		a.gesendet = await freigeben(a);
		const ant = await antwort(a, 'A09R', 'Telefon: 0221 444555\n\nAm 14.10.2026 schrieb Dispo:\n> Gewicht: 77123 kg\n> Bitte Telefonnummer nennen', [ex({ Telefon: '0221 444555' })]);
		check('Ergebnis', 'antwort_bereit', ant.r.ergebnis);
		const req = ant.llm.find((x) => x.aufgabe === 'extraktion');
		check('Zitat nicht an KI', 'ja', req && !JSON.stringify(req.body.messages[1]).includes('77123') ? 'ja' : 'nein');
		check('Bekannte Werte nicht an KI', 'ja', req && !JSON.stringify(req.body.messages[1]).includes('50667') ? 'ja' : 'nein');
	});

	return zeilen;
}

module.exports = { antwortSzenarien };
