'use strict';
// Szenarien für den internen Testkanal "telegram_test" (Kunden nutzen Teams) für tools/e2e-eingang.js.
// Telegram läuft gegen den Mock (Credential mit Base URL auf den Mock), Teams-Aufrufe dürfen dabei nicht stattfinden.
const { mail, kl, ex, VOLL } = require('../../test/daten/testmails');

const TG_KANAL = '700100200';
const TG_FREIGEBER = '700100201';

async function telegramSzenarien(ctx) {
	const { mock, aufrufen, tabelle, api, ids, KUNDE, POSTFACH, FREIGEBER, telegramWorkflowId, nur } = ctx;
	const zeilen = [];
	const zeile = async (id, szenario, fn) => {
		if (nur.length && !nur.includes(id) && !nur.includes(id[0])) return;
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
	const warte = (ms) => new Promise((ok) => setTimeout(ok, ms));
	const filter = (spalte, wert) => ({ type: 'and', filters: [{ columnName: spalte, condition: 'eq', value: wert }] });
	const aktualisieren = (t, spalte, wert, daten) => api('PATCH', `/data-tables/${ids[t]}/rows/update`, { filter: filter(spalte, wert), data: daten });
	const neueTelegram = (vorher) => mock.zustand.telegram.slice(vorher);
	const benachrichtigung = { kanal: 'telegram_test', chat_id: TG_KANAL, telegram_workflow_id: telegramWorkflowId, freigeber_chat_ids: { [FREIGEBER[0]]: TG_FREIGEBER } };
	const configAlt = (await tabelle('epa_config_allgemein')).find((c) => c.kunde_id === KUNDE);

	try {
		await zeile('K01', 'Testkanal: Meldung über EPA-T2 an Telegram (HTML umgesetzt), kein Teams-Aufruf', async (check) => {
			const vorher = mock.zustand.telegram.length;
			const graphVorher = mock.zustand.graphAnfragen.length;
			const r = (await aufrufen('benachrichtigen', { kunde_id: KUNDE, vorgangs_id: 'EPA-K01', kanal: 'telegram_test', chat_id: TG_KANAL, telegram_workflow_id: telegramWorkflowId, nachricht_html: '<p>Vorgang <b>EPA-K01</b></p><ul><li>Start: Köln</li></ul>A &amp; B<br>Ende', anlass: 'test' })).json;
			check('gesendet', 'true', String(r.gesendet));
			const neu = neueTelegram(vorher);
			check('Telegram-Nachrichten', '1', neu.length);
			check('Chat', TG_KANAL, neu[0] && neu[0].chat_id);
			check('Format', 'HTML', neu[0] && neu[0].parse_mode);
			check('Text', 'Vorgang <b>EPA-K01</b>\n\n• Start: Köln\n\nA &amp; B\nEnde', neu[0] && neu[0].text);
			check('Teams/Graph-Aufrufe', '0', mock.zustand.graphAnfragen.length - graphVorher);
		});

		await zeile('K02', 'Testkanal: Telegram lehnt ab (400) -> nicht zugestellt, Fehlerlog, Verarbeitung bricht nicht ab', async (check) => {
			mock.zustand.telegramFehler = 400;
			try {
				const r = (await aufrufen('benachrichtigen', { kunde_id: KUNDE, vorgangs_id: 'EPA-K02', kanal: 'telegram_test', chat_id: TG_KANAL, telegram_workflow_id: telegramWorkflowId, nachricht_html: 'x', anlass: 'k02' })).json;
				check('gesendet', 'false', String(r.gesendet));
				const f = (await tabelle('epa_fehler_log')).find((z) => z.id === r.fehler_id);
				check('Fehlerlog', 'Telegram-Nachricht senden/502', f ? `${f.node}/${f.statuscode}` : 'fehlt');
				check('Meldung bereinigt, ohne Text', 'ja', f && /nicht zugestellt/.test(f.meldung) && !/x$/.test(f.meldung) ? 'ja' : 'nein');
			} finally {
				mock.zustand.telegramFehler = null;
			}
		});

		await zeile('K03', 'Testkanal: Freigabe-Link per Telegram an die Chat-ID des Freigebers, kein Teams-Chat', async (check) => {
			const vorher = mock.zustand.telegram.length;
			const chatsVorher = mock.zustand.chats.length;
			const r = (await aufrufen('freigabesenden', { kunde_id: KUNDE, vorgangs_id: 'EPA-K03', freigeber: FREIGEBER[0], kanal: 'telegram_test', chat_id: TG_FREIGEBER, telegram_workflow_id: telegramWorkflowId, nachricht_html: 'Bitte prüfen: <a href="https://n8n.example/webhook/epa-freigabe?t=abc">Freigabe öffnen</a>' })).json;
			check('gesendet', 'true', String(r.gesendet));
			const neu = neueTelegram(vorher);
			check('Chat', TG_FREIGEBER, neu.map((n) => n.chat_id).join(','));
			check('Link', 'ja', neu[0] && neu[0].text.includes('<a href="https://n8n.example/webhook/epa-freigabe?t=abc">Freigabe öffnen</a>') ? 'ja' : 'nein');
			check('Teams-Chats', '0', mock.zustand.chats.length - chatsVorher);
			const ohne = (await aufrufen('freigabesenden', { kunde_id: KUNDE, vorgangs_id: 'EPA-K03', freigeber: FREIGEBER[1], kanal: 'telegram_test', chat_id: '', telegram_workflow_id: telegramWorkflowId, nachricht_html: 'x' })).json;
			check('ohne Chat-ID: nicht zugestellt, protokolliert', 'false/ja', `${ohne.gesendet}/${ohne.fehler_id ? 'ja' : 'nein'}`);
		});

		// Ab hier läuft der Testkunde vollständig über den Testkanal.
		await aktualisieren('epa_config_allgemein', 'kunde_id', KUNDE, { benachrichtigung: JSON.stringify(benachrichtigung) });

		await zeile('K04', 'Testkanal Ende-zu-Ende: vollständige Anfrage -> Meldung „Bereit“ per Telegram; Anfrage mit Lücke -> Freigabe-Links per Telegram', async (check) => {
			let vorher = mock.zustand.telegram.length;
			const m1 = mail('K04A', { betreff: 'Transportanfrage K04A', von: 'kunde-k04a@kunde-b.example', name: 'Erika Mustermann', text: 'Bitte Angebot.' });
			mock.zustand.graphMails.set(m1.id, { mail: m1, anhaenge: [] });
			mock.fall({ klassifizierung: [kl('anfrage')], extraktion: [ex(VOLL)] });
			const r1 = (await aufrufen('eingang', { postfach: POSTFACH, mail: m1, anhaenge: [] })).json;
			check('Ergebnis vollständig', 'bereit', r1.ergebnis);
			let neu = neueTelegram(vorher);
			check('Meldung an Kanal-Chat', TG_KANAL, neu.map((n) => n.chat_id).join(','));
			check('Meldung nennt Vorgang', 'ja', neu[0] && neu[0].text.includes(r1.vorgangs_id) ? 'ja' : 'nein');

			vorher = mock.zustand.telegram.length;
			const chatsVorher = mock.zustand.chats.length;
			const m2 = mail('K04B', { betreff: 'Transportanfrage K04B', von: 'kunde-k04b@kunde-b.example', name: 'Erika Mustermann', text: 'Bitte Angebot.' });
			mock.zustand.graphMails.set(m2.id, { mail: m2, anhaenge: [] });
			mock.fall({ klassifizierung: [kl('anfrage')], extraktion: [ex({ ...VOLL, Telefon: null })] });
			const r2 = (await aufrufen('eingang', { postfach: POSTFACH, mail: m2, anhaenge: [] })).json;
			check('Ergebnis mit Lücke', 'luecken', r2.ergebnis);
			neu = neueTelegram(vorher).filter((n) => /Rückfrage an den Kunden freigeben/.test(n.text));
			const ziele = neu.map((n) => n.chat_id).sort().join(',');
			// Freigeber 1 hat eine eigene Chat-ID, Freigeber 2 bekommt den Link im allgemeinen Test-Chat
			if (process.env.EPA_E2E_DEBUG) console.log('K04B', JSON.stringify(neu.map((n) => [n.chat_id, n.text.slice(0, 120)])));
			check('Freigabe-Links', [TG_KANAL, TG_FREIGEBER].sort().join(','), ziele);
			check('Links enthalten', 'ja', neu.length && neu.every((n) => /<a href="[^"]+">/.test(n.text)) ? 'ja' : 'nein');
			check('Teams-Chats', '0', mock.zustand.chats.length - chatsVorher);
		});

		await zeile('K05', 'Testkanal: Fehler-Alarm von EPA-05 über Telegram (Systemstatus "alarmierung")', async (check) => {
			for (const z of (await tabelle('epa_fehler_log')).filter((x) => x.vorgangs_id === 'EPA-K05')) {
				await api('DELETE', `/data-tables/${ids.epa_fehler_log}/rows/delete?filter=${encodeURIComponent(JSON.stringify(filter('id', z.id)))}`);
			}
			await api('POST', `/data-tables/${ids.epa_system_status}/rows`, { data: [{ schluessel: 'alarmierung', alarm_kanal: 'telegram_test', telegram_chat_id: TG_KANAL, telegram_workflow_id: telegramWorkflowId }], returnType: 'count' });
			const vorher = mock.zustand.telegram.length;
			// Ungültige Eingabe -> SW Benachrichtigen bricht mit 400 ab -> EPA-05 alarmiert
			await aufrufen('benachrichtigen', { kunde_id: KUNDE, vorgangs_id: 'EPA-K05', kanal: 'telegram_test', chat_id: TG_KANAL, telegram_workflow_id: telegramWorkflowId, nachricht_html: '', anlass: 'k05' });
			let neu = [];
			for (let i = 0; i < 20 && !neu.length; i++) {
				await warte(500);
				neu = neueTelegram(vorher).filter((n) => /EPA-Fehler/.test(n.text));
			}
			if (process.env.EPA_E2E_DEBUG) console.log('K05', JSON.stringify(neueTelegram(vorher).map((n) => [n.chat_id, n.text.slice(0, 300)])));
			check('Alarm per Telegram', '1', neu.length);
			check('Alarm-Chat', TG_KANAL, neu[0] && neu[0].chat_id);
			check('Alarm ohne <br>', 'ja', neu[0] && !/<br>/.test(neu[0].text) ? 'ja' : 'nein');
			check('Hinweis: Vorgang nicht gefunden', 'ja', neu[0] && /Vorgang nicht gefunden/.test(neu[0].text) ? 'ja' : 'nein');
			// keine Folgefehler (früher: Schleife EPA-05 -> Status setzen -> EPA-05)
			await warte(4000);
			check('keine Folgealarme', '1', neueTelegram(vorher).filter((n) => /EPA-Fehler/.test(n.text)).length);
			await warte(1000);
			const f = (await tabelle('epa_fehler_log')).filter((z) => z.vorgangs_id === 'EPA-K05');
			check('Fehlerlog: alarmiert', 'ja', f.length && f.every((z) => z.alarmiert_am) ? 'ja' : 'nein');
		});

		await zeile('K06', 'Testkanal: Watchdog prüft Teams nicht, meldet Befund per Telegram', async (check) => {
			const andere = (await tabelle('epa_config_allgemein')).filter((c) => c.kunde_id !== KUNDE && c.aktiv === true);
			for (const c of andere) await aktualisieren('epa_config_allgemein', 'kunde_id', c.kunde_id, { aktiv: false });
			mock.zustand.meFehler = 401; // würde ohne Teams-Lizenz so antworten
			mock.zustand.modelleFehler = 500; // erzwingt einen Befund und damit eine Meldung
			const vorher = mock.zustand.telegram.length;
			const graphVorher = mock.zustand.graphAnfragen.length;
			try {
				const r = (await aufrufen('watchdog', { jetzt: '' })).json;
				const befunde = r.befunde || [];
				check('Befund KI', 'ja', befunde.some((b) => /VERBINDUNG_LLM/.test(b)) ? 'ja' : 'nein');
				check('kein Teams-Befund', 'ja', befunde.some((b) => /VERBINDUNG_TEAMS/.test(b)) ? 'nein' : 'ja');
				const neu = neueTelegram(vorher).filter((n) => /Watchdog/.test(n.text));
				if (process.env.EPA_E2E_DEBUG) console.log('K06', JSON.stringify(neu.map((n) => [n.chat_id, n.text.slice(0, 200)])));
				check('Meldung per Telegram', TG_KANAL, neu.map((n) => n.chat_id).join(','));
				const z = (await tabelle('epa_system_status')).find((x) => x.schluessel === 'watchdog');
				check('Zustellung vermerkt', 'true', z ? String(JSON.parse(z.letztes_ergebnis).gemeldet) : 'fehlt');
				// Der Teams-Test-Node läuft zwar (Teil der Kette), sein Ergebnis zählt im Testbetrieb nicht.
				check('Postfach geprüft', 'ja', mock.zustand.graphAnfragen.slice(graphVorher).some((a) => a.pfad.endsWith('/mailFolders/inbox')) ? 'ja' : 'nein');
			} finally {
				mock.zustand.meFehler = null;
				mock.zustand.modelleFehler = null;
				for (const c of andere) await aktualisieren('epa_config_allgemein', 'kunde_id', c.kunde_id, { aktiv: true });
			}
		});
	} finally {
		// Testkunde und Alarmziel zurück auf Teams
		if (configAlt) await aktualisieren('epa_config_allgemein', 'kunde_id', KUNDE, { benachrichtigung: configAlt.benachrichtigung });
		for (const z of (await tabelle('epa_system_status')).filter((x) => x.schluessel === 'alarmierung')) {
			await api('DELETE', `/data-tables/${ids.epa_system_status}/rows/delete?filter=${encodeURIComponent(JSON.stringify(filter('id', z.id)))}`);
		}
	}
	return zeilen;
}

module.exports = { telegramSzenarien, TG_KANAL, TG_FREIGEBER };
