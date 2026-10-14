'use strict';
// M3-Szenarien (Rückfrage und Freigabe) für tools/e2e-eingang.js: Klicks auf den Freigabe-Link werden wie ein
// Mitarbeiter im Browser ausgeführt (GET Formular, POST Entscheidung).
const { mail, kl, ex, VOLL } = require('../../test/daten/testmails');

const warte = (ms) => new Promise((ok) => setTimeout(ok, ms));

function unescapeHtml(s) {
	return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

async function seite(url, formular) {
	const res = await fetch(url, formular
		? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(formular).toString(), redirect: 'manual' }
		: { redirect: 'manual' });
	const html = await res.text();
	const titel = (html.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1] || '';
	const text = (html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/) || [])[1];
	return { status: res.status, html, titel: unescapeHtml(titel).replace(/\s+/g, ' ').trim(), text: text === undefined ? null : unescapeHtml(text) };
}

function tokenAus(link) {
	return new URL(link).searchParams.get('t');
}

async function freigabeSzenarien(ctx) {
	const { mock, aufrufen, tabelle, api, ids, KUNDE, POSTFACH, FREIGEBER, nur } = ctx;
	const zeilen = [];
	const zustand = {};

	const zeile = async (id, szenario, fn) => {
		if (nur.length && !nur.includes(id) && !nur.includes('F')) return;
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

	const zeileLesen = async (tabelleName, spalte, wert) => (await tabelle(tabelleName)).filter((z) => z[spalte] === wert);
	const vorgang = async (vid) => (await zeileLesen('epa_vorgaenge', 'vorgangs_id', vid))[0] || null;
	const freigabe = async (fid) => (await zeileLesen('epa_freigaben', 'freigabe_id', fid))[0] || null;
	const aktualisieren = (tabelleName, spalte, wert, daten) => api('PATCH', `/data-tables/${ids[tabelleName]}/rows/update`, {
		filter: { type: 'and', filters: [{ columnName: spalte, condition: 'eq', value: wert }] }, data: daten,
	});
	const fehlerMax = async () => Math.max(0, ...(await tabelle('epa_fehler_log')).map((z) => z.id));

	/** Neue Mail mit Lücken (Telefon fehlt) -> EPA-01 -> EPA-02. Liefert Vorgang, Freigabe und Links je Freigeber. */
	async function lueckenMail(id, { entwurf, fehlt = ['Telefon'] } = {}) {
		const m = mail(id, { betreff: `Transportanfrage ${id}`, von: `kunde-${id.toLowerCase()}@kunde-f.example`, name: 'Erika Mustermann', text: 'Bitte Angebot, Details folgen.' });
		mock.zustand.graphMails.set(m.id, { mail: m, anhaenge: [] });
		mock.fall({ klassifizierung: [kl('anfrage')], extraktion: [ex({ ...VOLL, ...Object.fromEntries(fehlt.map((f) => [f, null])) })], ...(entwurf ? { entwurf } : {}) });
		const chatsVorher = mock.zustand.chats.length;
		const r = await aufrufen('eingang', { postfach: POSTFACH, mail: m, anhaenge: [] });
		const vid = r.json.vorgangs_id;
		const v = await vorgang(vid);
		const fg = v && v.freigabe_id_aktuell ? await freigabe(v.freigabe_id_aktuell) : null;
		const links = {};
		for (const c of mock.zustand.chats.slice(chatsVorher)) {
			const href = (String(c.content).match(/href="([^"]+)"/) || [])[1];
			if (href && String(c.content).includes(vid)) links[c.freigeber] = unescapeHtml(href);
		}
		return { mail: m, ergebnis: r.json, vid, vorgang: v, freigabe: fg, links, llm: [...mock.zustand.llmAnfragen] };
	}

	// ---------------------------------------------------------------- F01–F04: anfordern, ansehen, freigeben, Doppelklick
	await zeile('F01', 'Lücken erkannt -> Rückfrage-Entwurf, Freigabe mit Token je Freigeber, Link per Teams-Chat', async (check) => {
		const sentVorher = mock.zustand.gesendet.length;
		const a = await lueckenMail('F01');
		zustand.f01 = a;
		check('Ergebnis', 'luecken', a.ergebnis.ergebnis);
		check('Status', 'Freigabe ausstehend', a.vorgang && a.vorgang.status);
		check('Freigabe', 'offen/Runde 1', a.freigabe && `${a.freigabe.status}/Runde ${a.freigabe.runde}`);
		const tokens = a.freigabe ? await zeileLesen('epa_freigabe_tokens', 'freigabe_id', a.freigabe.freigabe_id) : [];
		check('Tokens', FREIGEBER.length, tokens.length);
		check('Links per Chat', [...FREIGEBER].sort().join(', '), Object.keys(a.links).sort().join(', '));
		const klartext = Object.values(a.links).map(tokenAus);
		const gespeichert = JSON.stringify([...(await tabelle('epa_freigaben')), ...(await tabelle('epa_freigabe_tokens')), ...(await tabelle('epa_audit_log'))]);
		check('Kein Klartext-Token gespeichert', 'ja', klartext.length && klartext.every((t) => !gespeichert.includes(t)) ? 'ja' : 'nein');
		check('Token-Hash', 'SHA-256', tokens.every((t) => /^[0-9a-f]{64}$/.test(t.token_hash)) ? 'SHA-256' : 'nein');
		const d = a.freigabe && mock.zustand.entwuerfe.get(a.freigabe.entwurf_id);
		check('Entwurf im Thread', 'ja', d && d.zu === a.mail.id ? 'ja' : 'nein');
		check('Betreff mit Vorgangs-ID', 'ja', d && d.subject.includes(`[${a.vid}]`) ? 'ja' : 'nein');
		check('Baustein wortgleich', 'ja', d && d.body.content.includes('Bitte geben Sie uns eine Telefonnummer für Rückfragen an.') ? 'ja' : 'nein');
		check('KI-Hinweis angehängt', 'ja', d && d.body.content.includes('KI-gestützt') ? 'ja' : 'nein');
		check('Freigabe-ID am Entwurf', 'ja', d && d.props['EPA-Freigabe-ID'] === a.freigabe.freigabe_id ? 'ja' : 'nein');
		const e = a.llm.find((x) => x.aufgabe === 'entwurf');
		check('Entwurf-KI ohne Mailinhalt', 'ja', e && !JSON.stringify(e.body).includes('Details folgen') ? 'ja' : 'nein');
		check('Nichts gesendet', sentVorher, mock.zustand.gesendet.length);
	});

	await zeile('F02', 'Link öffnen: Formular mit Vorschau und bearbeitbarem Text', async (check) => {
		const a = zustand.f01;
		const s = await seite(a.links[FREIGEBER[0]]);
		check('HTTP', 200, s.status);
		check('Text vorbefüllt', 'ja', s.text && s.text === a.freigabe.entwurf_text ? 'ja' : 'nein');
		check('Empfänger angezeigt', 'ja', s.html.includes(a.mail.from.emailAddress.address) ? 'ja' : 'nein');
		check('Aktionen', 'senden+ablehnen', s.html.includes('value="senden"') && s.html.includes('value="ablehnen"') ? 'senden+ablehnen' : 'fehlen');
		check('Signatur nicht editierbar', 'ja', s.text && !s.text.includes('KI-gestützt') ? 'ja' : 'nein');
	});

	await zeile('F03', 'Freigeben ohne Änderung: Versand im Thread, Warten auf Kunde, Runde, Frist, Audit', async (check) => {
		const a = zustand.f01;
		const sentVorher = mock.zustand.gesendet.length;
		const link = a.links[FREIGEBER[0]];
		const s = await seite(link, { t: tokenAus(link), aktion: 'senden', text: a.freigabe.entwurf_text, grund: '' });
		check('HTTP', 200, s.status);
		check('Seite', 'Rückfrage gesendet', s.titel);
		check('Gesendet', 1, mock.zustand.gesendet.length - sentVorher);
		const v = await vorgang(a.vid);
		check('Status', 'Warten auf Kunde', v.status);
		check('Rundenzähler', 1, v.rundenzaehler);
		check('Antwortfrist gesetzt', 'ja', v.antwort_frist && new Date(v.antwort_frist) > new Date() ? 'ja' : 'nein');
		const d = mock.zustand.entwuerfe.get(a.freigabe.entwurf_id);
		check('Gesendete Message-ID am Vorgang', 'ja', JSON.parse(v.bekannte_message_ids || '[]').includes(d.internetMessageId) ? 'ja' : 'nein');
		const fg = await freigabe(a.freigabe.freigabe_id);
		check('Freigabe', `gesendet/freigegeben/${FREIGEBER[0]}`, `${fg.status}/${fg.entscheidung}/${fg.entscheider}`);
		const tok = (await zeileLesen('epa_freigabe_tokens', 'freigabe_id', fg.freigabe_id)).find((t) => t.freigeber === FREIGEBER[0]);
		check('Token verbraucht', 'ja', tok && tok.verbraucht_am ? 'ja' : 'nein');
		const audit = (await zeileLesen('epa_audit_log', 'vorgangs_id', a.vid)).find((x) => x.neu === 'Warten auf Kunde');
		check('Audit mit Freigeber', `Mitarbeiter:${FREIGEBER[0]}`, audit && audit.ausloeser);
		check('Audit "bearbeitet"', 'false', audit && String(JSON.parse(audit.details).bearbeitet));
	});

	await zeile('F04', 'Doppelklick und zweiter Freigeber nach Versand: kein zweiter Versand', async (check) => {
		const a = zustand.f01;
		const sentVorher = mock.zustand.gesendet.length;
		const l1 = a.links[FREIGEBER[0]];
		const l2 = a.links[FREIGEBER[1]];
		const s1 = await seite(l1, { t: tokenAus(l1), aktion: 'senden', text: a.freigabe.entwurf_text, grund: '' });
		const s2 = await seite(l2, { t: tokenAus(l2), aktion: 'senden', text: a.freigabe.entwurf_text, grund: '' });
		const s3 = await seite(l2);
		check('Erneut senden', 409, s1.status);
		check('Zweiter Freigeber', 409, s2.status);
		check('Zweiter Freigeber öffnet Link', 409, s3.status);
		check('Hinweis wer', 'ja', s3.html.includes(FREIGEBER[0]) ? 'ja' : 'nein');
		check('Kein zweiter Versand', 0, mock.zustand.gesendet.length - sentVorher);
	});

	// ---------------------------------------------------------------- F05 Bearbeiten
	await zeile('F05', 'Bearbeiten: geänderter Text wird gesendet, Signatur/KI-Hinweis bleiben, Audit "bearbeitet"', async (check) => {
		const a = await lueckenMail('F05');
		const link = a.links[FREIGEBER[1]];
		const neu = 'Guten Tag Frau Mustermann,\n\nbitte schicken Sie uns noch eine Telefonnummer für Rückfragen.\n\nDanke!';
		const s = await seite(link, { t: tokenAus(link), aktion: 'senden', text: neu, grund: '' });
		check('HTTP', 200, s.status);
		const d = mock.zustand.entwuerfe.get(a.freigabe.entwurf_id);
		check('Gesendet', 'ja', d.gesendet ? 'ja' : 'nein');
		check('Neuer Text im Entwurf', 'ja', d.body.content.includes('bitte schicken Sie uns noch eine Telefonnummer') ? 'ja' : 'nein');
		check('KI-Hinweis bleibt', 'ja', d.body.content.includes('KI-gestützt') ? 'ja' : 'nein');
		const fg = await freigabe(a.freigabe.freigabe_id);
		check('Freigabe', 'gesendet/bearbeitet/true', `${fg.status}/${fg.entscheidung}/${fg.bearbeitet}`);
		check('Status', 'Warten auf Kunde', (await vorgang(a.vid)).status);
		const audit = (await zeileLesen('epa_audit_log', 'vorgangs_id', a.vid)).find((x) => x.neu === 'Warten auf Kunde');
		check('Audit', `Mitarbeiter:${FREIGEBER[1]}/true`, audit && `${audit.ausloeser}/${JSON.parse(audit.details).bearbeitet}`);
	});

	// ---------------------------------------------------------------- F06 Ablehnen
	await zeile('F06', 'Ablehnen: ohne Grund abgewiesen, mit Grund -> Eskaliert / Manuell, nichts gesendet', async (check) => {
		const a = await lueckenMail('F06');
		const link = a.links[FREIGEBER[1]];
		const s0 = await seite(link, { t: tokenAus(link), aktion: 'ablehnen', text: '', grund: '' });
		check('Ohne Grund', 400, s0.status);
		const s = await seite(link, { t: tokenAus(link), aktion: 'ablehnen', text: '', grund: 'Kunde ruft selbst an' });
		check('Mit Grund', 200, s.status);
		check('Seite', 'Rückfrage abgelehnt', s.titel);
		const d = mock.zustand.entwuerfe.get(a.freigabe.entwurf_id);
		check('Nicht gesendet', 'ja', !d.gesendet ? 'ja' : 'nein');
		const v = await vorgang(a.vid);
		check('Status', 'Eskaliert / Manuell', v.status);
		const fg = await freigabe(a.freigabe.freigabe_id);
		check('Freigabe', 'abgelehnt/Kunde ruft selbst an', `${fg.status}/${fg.grund}`);
		const audit = (await zeileLesen('epa_audit_log', 'vorgangs_id', a.vid)).find((x) => x.neu === 'Eskaliert / Manuell');
		check('Audit', `Mitarbeiter:${FREIGEBER[1]}`, audit && audit.ausloeser);
	});

	// ---------------------------------------------------------------- F07–F09 Ablauf, Berechtigung, ungültig
	await zeile('F07', 'Abgelaufener Link: 410, nichts gesendet', async (check) => {
		const a = await lueckenMail('F07');
		zustand.f07 = a;
		await aktualisieren('epa_freigaben', 'freigabe_id', a.freigabe.freigabe_id, { ablauf: new Date(Date.now() - 60000).toISOString() });
		const link = a.links[FREIGEBER[0]];
		check('Öffnen', 410, (await seite(link)).status);
		check('Senden', 410, (await seite(link, { t: tokenAus(link), aktion: 'senden', text: a.freigabe.entwurf_text, grund: '' })).status);
		check('Nicht gesendet', 'ja', !mock.zustand.entwuerfe.get(a.freigabe.entwurf_id).gesendet ? 'ja' : 'nein');
		check('Status unverändert', 'Freigabe ausstehend', (await vorgang(a.vid)).status);
	});

	await zeile('F08', 'Freigeber aus der Config entfernt: 403', async (check) => {
		const a = await lueckenMail('F08');
		await aktualisieren('epa_config_allgemein', 'kunde_id', KUNDE, { freigeber: JSON.stringify([FREIGEBER[0]]) });
		try {
			const s = await seite(a.links[FREIGEBER[1]]);
			check('Entfernter Freigeber', 403, s.status);
			check('Verbleibender Freigeber', 200, (await seite(a.links[FREIGEBER[0]])).status);
		} finally {
			await aktualisieren('epa_config_allgemein', 'kunde_id', KUNDE, { freigeber: JSON.stringify(FREIGEBER) });
		}
		zustand.f08 = a;
	});

	await zeile('F09', 'Ungültiger oder fehlender Token: 404', async (check) => {
		const basis = new URL(zustand.f01.links[FREIGEBER[0]]);
		basis.search = '';
		check('Ohne Token', 404, (await seite(basis.toString())).status);
		check('Falscher Token', 404, (await seite(`${basis}?t=${'A'.repeat(43)}`)).status);
		check('Manipulierter Token', 404, (await seite(`${basis}?t=${encodeURIComponent('<script>')}`)).status);
	});

	await zeile('F17', 'Formular ohne Knopfwert (Browser mit gesperrtem Knopf): klare Fehlermeldung, Link bleibt gültig, nichts gesendet', async (check) => {
		const a = await lueckenMail('F17');
		const link = a.links[FREIGEBER[0]];
		const formular = (await seite(link)).html;
		check('Knöpfe erst nach dem Absenden gesperrt', 'ja', /setTimeout\(function\(\)\{var b=f\.querySelectorAll\('button'\)/.test(formular) ? 'ja' : 'nein');
		const gesendetVorher = mock.zustand.gesendet.length;
		const s = await seite(link, { t: tokenAus(link), text: a.freigabe.entwurf_text, grund: '' });
		check('Status', 400, s.status);
		check('Meldung statt Formular', 'ja', /Unbekannte Aktion/.test(s.html) && s.text === null ? 'ja' : 'nein');
		check('Nichts gesendet', 0, mock.zustand.gesendet.length - gesendetVorher);
		const danach = await seite(link, { t: tokenAus(link), aktion: 'senden', text: a.freigabe.entwurf_text, grund: '' });
		check('Danach mit Aktion gesendet', 200, danach.status);
	});

	// ---------------------------------------------------------------- F10–F11 Versandfehler
	await zeile('F10', 'Versandfehler: nichts gesendet, Seite 502, Freigabe "fehler", EPA-05 sichert Vorgang', async (check) => {
		const a = await lueckenMail('F10');
		const vorher = await fehlerMax();
		mock.zustand.sendeFehler = 'vorher';
		const link = a.links[FREIGEBER[0]];
		let s;
		try {
			s = await seite(link, { t: tokenAus(link), aktion: 'senden', text: a.freigabe.entwurf_text, grund: '' });
		} finally {
			mock.zustand.sendeFehler = null;
		}
		await warte(4000);
		check('HTTP', 502, s.status);
		check('Nicht gesendet', 'ja', !mock.zustand.entwuerfe.get(a.freigabe.entwurf_id).gesendet ? 'ja' : 'nein');
		check('Freigabe', 'fehler', (await freigabe(a.freigabe.freigabe_id)).status);
		const neu = (await tabelle('epa_fehler_log')).filter((z) => z.id > vorher && z.vorgangs_id === a.vid && z.node !== 'Teams-Nachricht senden');
		check('Fehlerlog', '502 UPSTREAM_FEHLER', neu[0] ? `${neu[0].statuscode} ${neu[0].fehlercode}` : 'keiner');
		check('Status', 'Eskaliert / Manuell', (await vorgang(a.vid)).status);
		check('Erneuter Klick', 409, (await seite(link)).status);
	});

	await zeile('F11', 'Versand erfolgt, Antwort ging verloren: per Gesendete Elemente erkannt, genau ein Versand', async (check) => {
		const a = await lueckenMail('F11');
		const sentVorher = mock.zustand.gesendet.length;
		mock.zustand.sendeFehler = 'nachher';
		const link = a.links[FREIGEBER[0]];
		let s;
		try {
			s = await seite(link, { t: tokenAus(link), aktion: 'senden', text: a.freigabe.entwurf_text, grund: '' });
		} finally {
			mock.zustand.sendeFehler = null;
		}
		check('HTTP', 200, s.status);
		check('Genau ein Versand', 1, mock.zustand.gesendet.length - sentVorher);
		check('Status', 'Warten auf Kunde', (await vorgang(a.vid)).status);
		const audit = (await zeileLesen('epa_audit_log', 'vorgangs_id', a.vid)).find((x) => x.neu === 'Warten auf Kunde');
		check('Audit "bereits gesendet"', 'true', audit && String(JSON.parse(audit.details).bereits_gesendet));
		zustand.f11 = a;
	});

	// ---------------------------------------------------------------- F12–F14 Entwurfsprüfung, LLM-Ausfall, Zustellung
	await zeile('F12', 'KI-Entwurf mit Zusage und Preis -> Standardvorlage (Fallback), Hinweis im Formular', async (check) => {
		const a = await lueckenMail('F12', { entwurf: [{ json: { anrede: 'Guten Tag,', einleitung: 'den Transport garantieren wir Ihnen für 499 Euro, uns fehlt nur noch:', schluss: 'Wir melden uns sofort.' } }] });
		check('Freigabe angefordert', 'Freigabe ausstehend', a.vorgang.status);
		check('Fallback', 'true', String(a.freigabe.fallback));
		check('Vorlagentext', 'ja', a.freigabe.entwurf_text.includes('Damit wir sie bearbeiten können') ? 'ja' : 'nein');
		check('Zusage nicht im Entwurf', 'ja', !mock.zustand.entwuerfe.get(a.freigabe.entwurf_id).body.content.includes('garantieren') ? 'ja' : 'nein');
		check('Hinweis im Formular', 'ja', (await seite(a.links[FREIGEBER[0]])).html.includes('Standardvorlage') ? 'ja' : 'nein');
	});

	await zeile('F13', 'KI für den Entwurf nicht erreichbar -> trotzdem Rückfrage mit Standardvorlage', async (check) => {
		const a = await lueckenMail('F13', { entwurf: [{ status: 500 }, { status: 500 }, { status: 500 }] });
		check('Status', 'Freigabe ausstehend', a.vorgang.status);
		check('Fallback', 'true', String(a.freigabe && a.freigabe.fallback));
		check('Links', FREIGEBER.length, Object.keys(a.links).length);
	});

	await zeile('F14', 'Ein Freigeber per Teams nicht erreichbar: der andere bekommt den Link, Fehler im Log', async (check) => {
		const vorher = await fehlerMax();
		mock.zustand.chatFehlerFuer.add(FREIGEBER[1]);
		let a;
		try {
			a = await lueckenMail('F14');
		} finally {
			mock.zustand.chatFehlerFuer.clear();
		}
		check('Links', FREIGEBER[0], Object.keys(a.links).join(', '));
		const neu = (await tabelle('epa_fehler_log')).filter((z) => z.id > vorher && z.node === 'Freigabe-Nachricht');
		check('Fehlerlog', 1, neu.length);
		check('Fehlerlog ohne Link/Token', 'ja', neu.every((z) => !String(z.meldung).includes('epa-freigabe')) ? 'ja' : 'nein');
		check('Status', 'Freigabe ausstehend', a.vorgang.status);
	});

	// ---------------------------------------------------------------- F15 Max. Runden, F16 Antwort des Kunden
	await zeile('F15', 'Maximale Rundenzahl erreicht: keine weitere Rückfrage, Eskaliert / Manuell', async (check) => {
		const a = zustand.f11;
		await aktualisieren('epa_vorgaenge', 'vorgangs_id', a.vid, { status: 'Lücken erkannt', rundenzaehler: 3 });
		const entwuerfeVorher = mock.zustand.entwuerfe.size;
		const r = await aufrufen('rueckfrage', { kunde_id: KUNDE, vorgangs_id: a.vid, art: 'rueckfrage', referenz: 'e2e' });
		check('Ergebnis', 'eskaliert_max_runden', r.json.ergebnis);
		check('Status', 'Eskaliert / Manuell', (await vorgang(a.vid)).status);
		check('Kein neuer Entwurf', 0, mock.zustand.entwuerfe.size - entwuerfeVorher);
	});

	await zeile('F16', 'Kunde antwortet auf die gesendete Rückfrage: eindeutig zugeordnet und ausgewertet', async (check) => {
		const a = zustand.f01;
		const d = mock.zustand.entwuerfe.get(a.freigabe.entwurf_id);
		const m = mail('F16', { betreff: d.subject.replace(/^RE:/, 'AW:'), von: a.mail.from.emailAddress.address, text: 'Telefon: 0221 987654', headers: [{ name: 'In-Reply-To', value: d.internetMessageId }, { name: 'References', value: `${a.mail.internetMessageId} ${d.internetMessageId}` }], conversation: a.mail.conversationId });
		mock.zustand.graphMails.set(m.id, { mail: m, anhaenge: [] });
		mock.fall({ extraktion: [ex({ Telefon: '0221 987654' })] });
		const r = await aufrufen('eingang', { postfach: POSTFACH, mail: m, anhaenge: [] });
		check('Ergebnis', 'antwort_bereit', r.json.ergebnis);
		check('Vorgang', a.vid, r.json.vorgangs_id);
		check('Status', 'Bereit zur Bearbeitung', (await vorgang(a.vid)).status);
	});

	return zeilen;
}

module.exports = { freigabeSzenarien, seite, tokenAus, unescapeHtml };
