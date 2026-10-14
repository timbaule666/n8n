'use strict';
// M7-Fehlerfälle aus Masterprompt Abschnitt 10, die vorher nicht eigens abgedeckt waren:
// Graph-API nicht erreichbar, abgelaufenes Token, LLM-Timeout, fehlender Textbaustein.
const { mail, kl, ex, VOLL } = require('../../test/daten/testmails');

async function fehlerSzenarien(ctx) {
	const { mock, aufrufen, tabelle, api, ids, KUNDE, POSTFACH, nur } = ctx;
	const zeilen = [];
	const zeile = async (id, szenario, fn) => {
		if (nur.length && !nur.includes(id) && !nur.includes('G')) return;
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
	const filter = (...paare) => ({ type: 'and', filters: paare.map(([columnName, value]) => ({ columnName, condition: 'eq', value })) });
	const aktualisieren = (t, f, daten) => api('PATCH', `/data-tables/${ids[t]}/rows/update`, { filter: f, data: daten });
	const maxId = async (t) => Math.max(0, ...(await tabelle(t)).map((z) => z.id));
	const neueFehler = async (seit) => (await tabelle('epa_fehler_log')).filter((z) => z.id > seit && z.node !== 'Teams-Nachricht senden');

	async function graphFehler(id, status, erwartet) {
		const m = mail(id, { betreff: `Transportanfrage ${id}`, von: `kunde-${id.toLowerCase()}@kunde-x.example`, text: 'Bitte Angebot.' });
		mock.zustand.graphMails.set(m.id, { mail: m, anhaenge: [] });
		mock.fall({ klassifizierung: [kl('anfrage')], extraktion: [ex(VOLL)] });
		const seit = await maxId('epa_fehler_log');
		const vorher = mock.zustand.graphAnfragen.length;
		mock.zustand.mailLadenFehler = status;
		try {
			await aufrufen('postfach', { postfach: POSTFACH, graph_id: m.id });
		} finally {
			mock.zustand.mailLadenFehler = null;
		}
		await warte(4000);
		return { m, fehler: await neueFehler(seit), versuche: mock.zustand.graphAnfragen.slice(vorher).filter((a) => a.methode === 'GET' && a.pfad.endsWith(`/messages/${m.id}`)).length, erwartet };
	}

	await zeile('G01', 'Graph-API nicht erreichbar (503): Wiederholungen, dann Fehlerlog/Alarm; Mail bleibt unverarbeitet im Postfach, kein Vorgang', async (check) => {
		const r = await graphFehler('G01', 503);
		check('Fehlerlog', '503 NICHT_ERREICHBAR', r.fehler.length ? `${r.fehler[0].statuscode} ${r.fehler[0].fehlercode}` : 'keiner');
		check('Wiederholt (3 Versuche)', 3, r.versuche);
		check('Kein Vorgang, kein Dedupe-Eintrag', '0/0', `${(await tabelle('epa_vorgaenge')).filter((v) => v.absender_adresse === r.m.from.emailAddress.address).length}/${(await tabelle('epa_verarbeitete_mails')).filter((x) => x.message_id === r.m.internetMessageId).length}`);
		check('KI nicht aufgerufen', 0, mock.zustand.llmAnfragen.length);
		// Nach Wiederherstellung wird dieselbe Mail normal verarbeitet (nichts verloren)
		mock.fall({ klassifizierung: [kl('anfrage')], extraktion: [ex(VOLL)] });
		const neu = await aufrufen('postfach', { postfach: POSTFACH, graph_id: r.m.id });
		check('Zweiter Versuch verarbeitet', 'bereit', neu.json.ergebnis);
	});

	await zeile('G02', 'Abgelaufenes Token beim Postfach (401): als AUTH_FEHLER gemeldet, kein Vorgang', async (check) => {
		const r = await graphFehler('G02', 401);
		check('Fehlerlog', '401 AUTH_FEHLER', r.fehler.length ? `${r.fehler[0].statuscode} ${r.fehler[0].fehlercode}` : 'keiner');
		check('Kein Vorgang', 0, (await tabelle('epa_vorgaenge')).filter((v) => v.absender_adresse === r.m.from.emailAddress.address).length);
	});

	await zeile('G03', 'LLM-Timeout: 3 Versuche mit Zeitlimit, dann 504 ZEITUEBERSCHREITUNG, Vorgang gesichert (Eskaliert / Manuell)', async (check) => {
		const cfg = (await tabelle('epa_config_allgemein')).find((c) => c.kunde_id === KUNDE);
		const profil = JSON.parse(cfg.llm_profil);
		const kurz = JSON.parse(cfg.llm_profil);
		kurz.klassifizierung.timeout_ms = 2000;
		await aktualisieren('epa_config_allgemein', filter(['kunde_id', KUNDE]), { llm_profil: JSON.stringify(kurz) });
		try {
			const m = mail('G03', { betreff: 'Transportanfrage G03', von: 'kunde-g03@kunde-x.example', text: 'Bitte Angebot.' });
			mock.zustand.graphMails.set(m.id, { mail: m, anhaenge: [] });
			const langsam = { verzoegerung: 4000, json: kl('anfrage').json };
			mock.fall({ klassifizierung: [langsam, langsam, langsam] });
			const seit = await maxId('epa_fehler_log');
			const r = await aufrufen('eingang', { postfach: POSTFACH, mail: m, anhaenge: [] });
			await warte(5000);
			const f = await neueFehler(seit);
			check('Fehlerlog', '504 ZEITUEBERSCHREITUNG', f.length ? `${f[0].statuscode} ${f[0].fehlercode}` : `keiner (${JSON.stringify(r.json).slice(0, 80)})`);
			check('KI-Versuche', 3, mock.zustand.llmAnfragen.filter((a) => a.aufgabe === 'klassifizierung').length);
			const v = (await tabelle('epa_vorgaenge')).find((x) => x.absender_adresse === 'kunde-g03@kunde-x.example');
			check('Vorgang gesichert', 'Eskaliert / Manuell', v ? v.status : '(kein Vorgang)');
		} finally {
			await aktualisieren('epa_config_allgemein', filter(['kunde_id', KUNDE]), { llm_profil: JSON.stringify(profil) });
		}
	});

	await zeile('G04', 'Fehlender Textbaustein in der Config: Konfigurationsfehler (424) mit Alarm, keine geratene Rückfrage, kein Entwurf', async (check) => {
		const feld = (await tabelle('epa_config_pflichtfelder')).find((f) => f.kunde_id === KUNDE && f.feldname === 'Telefon');
		await aktualisieren('epa_config_pflichtfelder', filter(['kunde_id', KUNDE], ['feldname', 'Telefon']), { resolution_textbaustein: '' });
		try {
			const m = mail('G04', { betreff: 'Transportanfrage G04', von: 'kunde-g04@kunde-x.example', text: 'Bitte Angebot.' });
			mock.zustand.graphMails.set(m.id, { mail: m, anhaenge: [] });
			mock.fall({ klassifizierung: [kl('anfrage')], extraktion: [ex({ ...VOLL, Telefon: null })] });
			const seit = await maxId('epa_fehler_log');
			const entwuerfe = mock.zustand.entwuerfe.size;
			await aufrufen('eingang', { postfach: POSTFACH, mail: m, anhaenge: [] });
			await warte(4000);
			const f = await neueFehler(seit);
			check('Fehlerlog', '424 KONFIGURATIONSFEHLER', f.length ? `${f[0].statuscode} ${f[0].fehlercode}` : 'keiner');
			check('Kein Entwurf', entwuerfe, mock.zustand.entwuerfe.size);
			check('Keine Freigabe', 0, (await tabelle('epa_freigaben')).filter((x) => x.empfaenger === 'kunde-g04@kunde-x.example').length);
			check('Feld genannt', 'ja', f.some((x) => /Telefon/.test(x.meldung)) ? 'ja' : 'nein');
		} finally {
			await aktualisieren('epa_config_pflichtfelder', filter(['kunde_id', KUNDE], ['feldname', 'Telefon']), { resolution_textbaustein: feld.resolution_textbaustein });
		}
	});

	return zeilen;
}

module.exports = { fehlerSzenarien };
