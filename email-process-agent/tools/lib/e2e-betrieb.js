'use strict';
// M6-Szenarien (Phase F: Watchdog EPA-06, Löschjob EPA-08) für tools/e2e-eingang.js.
// Läuft nach M2–M5 und nutzt deren Testdaten. Der Löschjob löscht in der LOKALEN Testinstanz mit simuliertem "jetzt".
const { DateTime } = require('luxon');
const { mail, kl, ex, VOLL } = require('../../test/daten/testmails');
const { werktag } = require('./e2e-nachfassen');

async function betriebSzenarien(ctx) {
	const { mock, aufrufen, tabelle, api, ids, KUNDE, POSTFACH, nur } = ctx;
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
	const iso = (d) => (d.toUTC ? d.toUTC().toISO() : new Date(d).toISOString());
	const lesen = async (t, spalte, wert) => (await tabelle(t)).filter((r) => r[spalte] === wert);
	const filter = (spalte, wert) => ({ type: 'and', filters: [{ columnName: spalte, condition: 'eq', value: wert }] });
	const aktualisieren = (t, spalte, wert, daten) => api('PATCH', `/data-tables/${ids[t]}/rows/update`, { filter: filter(spalte, wert), data: daten });
	const einfuegen = (t, zeilen_) => api('POST', `/data-tables/${ids[t]}/rows`, { data: zeilen_, returnType: 'count' });
	const allesLoeschen = async (t) => {
		for (const z of await tabelle(t)) await api('DELETE', `/data-tables/${ids[t]}/rows/delete?filter=${encodeURIComponent(JSON.stringify(filter('id', z.id)))}`);
	};
	const watchdog = async (jetzt) => (await aufrufen('watchdog', { jetzt: jetzt ? iso(jetzt) : '' })).json;
	const loeschjob = async (jetzt, probelauf) => (await aufrufen('loeschjob', { jetzt: iso(jetzt), probelauf })).json;
	const cronFrisch = () => aktualisieren('epa_system_status', 'schluessel', 'epa04_lauf', { letzter_lauf: new Date().toISOString(), lock_bis: '1970-01-01T00:00:00.000Z', lock_durch: '' });
	const vorgang = async (vid) => (await lesen('epa_vorgaenge', 'vorgangs_id', vid))[0] || null;

	async function anfrage(id, fehlt) {
		const m = mail(id, { betreff: `Transportanfrage ${id}`, von: `kunde-${id.toLowerCase()}@kunde-b.example`, name: 'Erika Mustermann', text: 'Bitte Angebot.' });
		mock.zustand.graphMails.set(m.id, { mail: m, anhaenge: [] });
		mock.fall({ klassifizierung: [kl('anfrage')], extraktion: [ex({ ...VOLL, ...Object.fromEntries(fehlt.map((f) => [f, null])) })] });
		const r = await aufrufen('eingang', { postfach: POSTFACH, mail: m, anhaenge: [] });
		const v = await vorgang(r.json.vorgangs_id);
		return { mail: m, vid: r.json.vorgangs_id, vorgang: v };
	}

	// ---------------------------------------------------------------- Watchdog
	// Testinstanz: liegengebliebene Vorgänge anderer Testläufe (z. B. M1) würden jeden Lauf als "hängend" melden.
	for (const st of ['Neu', 'In Prüfung', 'Lücken erkannt']) {
		await api('PATCH', `/data-tables/${ids.epa_vorgaenge}/rows/update`, { filter: { type: 'and', filters: [{ columnName: 'status', condition: 'eq', value: st }, { columnName: 'kunde_id', condition: 'neq', value: KUNDE }] }, data: { status: 'Eskaliert / Manuell' } });
	}

	// Andere aktive Kunden der Testinstanz (z. B. "beispiel-transport" aus M1) zeigen auf das echte OpenAI: für die
	// Watchdog-Fälle deaktivieren, danach wiederherstellen.
	const andere = (await tabelle('epa_config_allgemein')).filter((c) => c.kunde_id !== KUNDE && c.aktiv === true);
	for (const c of andere) await aktualisieren('epa_config_allgemein', 'kunde_id', c.kunde_id, { aktiv: false });

	await zeile('W01', 'Watchdog ohne Befund: alle Testaufrufe ok (Teams, KI, Postfach), Heartbeat-Meldung, Ergebnis gespeichert', async (check) => {
		await cronFrisch();
		await anfrage('W01', []); // frische Mail: keine Stille
		// lokal scheitern Teams-Meldungen am Dummy-Credential; diese Fehler hier nicht mitzählen
		await new Promise((ok) => setTimeout(ok, 3000));
		await allesLoeschen('epa_fehler_log');
		const r = await watchdog();
		check('Ergebnis', 'watchdog_ok', r.ergebnis);
		check('Befunde', '–', (r.befunde || []).join(', ') || '–');
		check('Heartbeat-Text', 'ja', /Alles in Ordnung/.test(r.nachricht_html || '') ? 'ja' : 'nein');
		const anfragen = mock.zustand.graphAnfragen.map((a) => a.pfad);
		check('Testaufrufe Teams/Postfach', 'ja/ja', `${anfragen.some((p) => p.endsWith('/me')) ? 'ja' : 'nein'}/${anfragen.some((p) => p.endsWith('/mailFolders/inbox')) ? 'ja' : 'nein'}`);
		const z = (await lesen('epa_system_status', 'schluessel', 'watchdog'))[0];
		check('Status gespeichert', 'ok', z ? JSON.parse(z.letztes_ergebnis).gesamt : 'fehlt');
		// lokal nur Dummy-Teams: Meldung versucht, aber nicht zugestellt -> nächster Lauf meldet erneut
		check('Zustellung vermerkt', 'false', String(JSON.parse(z.letztes_ergebnis).gemeldet));
	});

	await zeile('W02', 'Cronjob läuft nicht (Heartbeat 5 h alt): Alarm mit Handlungsempfehlung', async (check) => {
		await aktualisieren('epa_system_status', 'schluessel', 'epa04_lauf', { letzter_lauf: new Date(Date.now() - 5 * 3600000).toISOString() });
		const r = await watchdog();
		check('Ergebnis', 'watchdog_alarm', r.ergebnis);
		check('Befund', 'ja', (r.befunde || []).includes('CRON_AUS') ? 'ja' : 'nein');
		check('Empfehlung', 'ja', /EPA-04 veröffentlicht/.test(r.nachricht_html || '') ? 'ja' : 'nein');
		await cronFrisch();
	});

	await zeile('W03', 'Vorgang hängt in "In Prüfung" (abgebrochene Ausführung): Alarm mit Vorgangs-ID', async (check) => {
		const a = await anfrage('W03', ['Telefon']);
		await aktualisieren('epa_vorgaenge', 'vorgangs_id', a.vid, { status: 'In Prüfung' });
		const r = await watchdog(DateTime.now().plus({ hours: 2 }));
		check('Befund', 'ja', (r.befunde || []).includes('VORGANG_HAENGT') ? 'ja' : 'nein');
		check('Vorgangs-ID genannt', 'ja', String(r.nachricht_html).includes(a.vid) ? 'ja' : 'nein');
		await aktualisieren('epa_vorgaenge', 'vorgangs_id', a.vid, { status: 'Eskaliert / Manuell' });
	});

	await zeile('W04', 'Ungewöhnliche Stille im Postfach (über stille_alarm_stunden Geschäftsstunden keine Mail)', async (check) => {
		const r = await watchdog(werktag(6, 11));
		check('Befund Stille', 'ja', (r.befunde || []).includes('STILLE') ? 'ja' : 'nein');
		check('Kunde genannt', 'ja', String(r.nachricht_html).includes(KUNDE) ? 'ja' : 'nein');
	});

	await zeile('W05', 'Teams-Token ungültig, KI-Limit, Postfach-Rechte entzogen: drei Alarme mit passender Empfehlung', async (check) => {
		Object.assign(mock.zustand, { meFehler: 401, modelleFehler: 429, postfachFehler: 403 });
		try {
			const r = await watchdog();
			check('Befunde', 'VERBINDUNG_LLM, VERBINDUNG_POSTFACH, VERBINDUNG_TEAMS', (r.befunde || []).filter((b) => b.startsWith('VERBINDUNG')).sort().join(', '));
			const html = String(r.nachricht_html);
			check('HTTP-Codes', '401/429/403', ['401', '429', '403'].map((c) => (html.includes(`HTTP ${c}`) ? c : '-')).join('/'));
			check('Empfehlungen', 'ja/ja/ja', [/Teams-Credential/, /OpenAI-Credential/, /Outlook-Credential/].map((re) => (re.test(html) ? 'ja' : 'nein')).join('/'));
		} finally {
			Object.assign(mock.zustand, { meFehler: null, modelleFehler: null, postfachFehler: null });
		}
	});

	await zeile('W06', 'Fehler, die nicht nach Teams gemeldet werden konnten: Hinweis; gespeichertes Ergebnis ohne Personendaten', async (check) => {
		await einfuegen('epa_fehler_log', [{ statuscode: 502, fehlercode: 'UPSTREAM_FEHLER', klasse: 'extern', workflow_name: 'Test', kunde_id: KUNDE, meldung: 'Test', eskaliert: false }]);
		const r = await watchdog();
		check('Befund', 'ja', (r.befunde || []).includes('FEHLER_OHNE_ALARM') ? 'ja' : 'nein');
		const z = (await lesen('epa_system_status', 'schluessel', 'watchdog'))[0];
		check('Keine Mail-Adressen/Inhalte im Status', 'ja', !/@|Transportanfrage/.test(z.letztes_ergebnis) ? 'ja' : 'nein');
	});

	for (const c of andere) await aktualisieren('epa_config_allgemein', 'kunde_id', c.kunde_id, { aktiv: true });

	// ---------------------------------------------------------------- Löschjob
	const ctxL = {};
	await zeile('L01', 'Probelauf: zeigt, was nach Ablauf der Aufbewahrung gelöscht würde, löscht nichts', async (check) => {
		const a = await anfrage('L01', []);
		await aktualisieren('epa_vorgaenge', 'vorgangs_id', a.vid, { status: 'Abgeschlossen' });
		ctxL.fertig = a;
		const vorher = (await tabelle('epa_vorgaenge')).length;
		const r = await loeschjob(DateTime.now().plus({ days: 400 }), true);
		check('Ergebnis', 'probelauf', r.ergebnis);
		check('Vorgang vorgesehen', 'ja', (r.vorgaenge_ids || []).includes(a.vid) ? 'ja' : 'nein');
		check('Nichts gelöscht', vorher, (await tabelle('epa_vorgaenge')).length);
		const r2 = await loeschjob(DateTime.now(), true);
		check('Vor Fristablauf nicht vorgesehen', 'nein', (r2.vorgaenge_ids || []).includes(a.vid) ? 'ja' : 'nein');
	});

	await zeile('L02', 'Ersetzte Entwürfe: nur echte Entwürfe mit passender Kennung gelöscht; Kundenmail und fremde Entwürfe bleiben', async (check) => {
		const a = await anfrage('L02A', ['Telefon']);
		const b = await anfrage('L02B', ['Telefon']);
		const fa = (await lesen('epa_freigaben', 'freigabe_id', a.vorgang.freigabe_id_aktuell))[0];
		const fb = (await lesen('epa_freigaben', 'freigabe_id', b.vorgang.freigabe_id_aktuell))[0];
		await aktualisieren('epa_freigaben', 'freigabe_id', fa.freigabe_id, { status: 'ersetzt' });
		await einfuegen('epa_freigaben', [
			{ freigabe_id: 'F-L02-MAIL', kunde_id: KUNDE, vorgangs_id: a.vid, art: 'rueckfrage', runde: 1, status: 'ersetzt', entwurf_id: a.mail.id },
			{ freigabe_id: 'F-L02-FREMD', kunde_id: KUNDE, vorgangs_id: b.vid, art: 'rueckfrage', runde: 1, status: 'ersetzt', entwurf_id: fb.entwurf_id },
		]);
		const r = await loeschjob(DateTime.now(), false);
		check('Ergebnis', 'geloescht', r.ergebnis);
		check('Ersetzter Entwurf gelöscht', 'ja', mock.zustand.geloescht.includes(fa.entwurf_id) ? 'ja' : 'nein');
		check('Kundenmail nicht gelöscht', 'ja', !mock.zustand.geloescht.includes(a.mail.id) ? 'ja' : 'nein');
		check('Entwurf mit fremder Kennung nicht gelöscht', 'ja', !mock.zustand.geloescht.includes(fb.entwurf_id) ? 'ja' : 'nein');
		const vermerkt = async (fid) => ((await lesen('epa_freigaben', 'freigabe_id', fid))[0] || {}).entwurf_entfernt_am ? 'ja' : 'nein';
		check('Vermerkt (gelöscht/kein Entwurf/fremd)', 'ja/ja/ja', `${await vermerkt(fa.freigabe_id)}/${await vermerkt('F-L02-MAIL')}/${await vermerkt('F-L02-FREMD')}`);
		check('Offene Freigabe B unberührt', 'offen', fb.status);
		const r2 = await loeschjob(DateTime.now(), true);
		check('Zweiter Lauf: nichts mehr zu tun', 0, r2.entwuerfe);
	});

	await zeile('L03', 'Nach Ablauf: abgeschlossener Vorgang samt Audit, Freigaben und Links gelöscht; offene und eskalierte bleiben', async (check) => {
		const offen = await anfrage('L03', ['Telefon']);
		const esk = (await tabelle('epa_vorgaenge')).find((v) => v.kunde_id === KUNDE && v.status === 'Eskaliert / Manuell');
		// abgeschlossener Vorgang mit Freigabe und Links
		const fertig = await anfrage('L03F', ['Telefon']);
		await aktualisieren('epa_vorgaenge', 'vorgangs_id', fertig.vid, { status: 'Abgeschlossen' });
		const fid = fertig.vorgang.freigabe_id_aktuell;
		check('Vorher: Audit/Freigabe/Links', 'ja/1/2', `${(await lesen('epa_audit_log', 'vorgangs_id', fertig.vid)).length ? 'ja' : 'nein'}/${(await lesen('epa_freigaben', 'vorgangs_id', fertig.vid)).length}/${(await lesen('epa_freigabe_tokens', 'freigabe_id', fid)).length}`);
		// der Entwurf der offenen Freigabe ist nicht "ersetzt" -> darf den Vorgang nicht blockieren
		const r = await loeschjob(DateTime.now().plus({ days: 400 }), false);
		check('Ergebnis', 'geloescht', r.ergebnis);
		check('Abgeschlossener Vorgang', 'gelöscht', (await vorgang(fertig.vid)) ? 'vorhanden' : 'gelöscht');
		check('Audit/Freigaben/Links danach', '0/0/0', `${(await lesen('epa_audit_log', 'vorgangs_id', fertig.vid)).length}/${(await lesen('epa_freigaben', 'vorgangs_id', fertig.vid)).length}/${(await lesen('epa_freigabe_tokens', 'freigabe_id', fid)).length}`);
		check('Offener Vorgang und sein Audit bleiben', 'ja/ja', `${(await vorgang(offen.vid)) ? 'ja' : 'nein'}/${(await lesen('epa_audit_log', 'vorgangs_id', offen.vid)).length ? 'ja' : 'nein'}`);
		check('Eskalierter Vorgang bleibt', 'ja', esk && (await vorgang(esk.vorgangs_id)) ? 'ja' : 'nein');
		check('Dedupe-Einträge nach Frist gelöscht', 0, (await tabelle('epa_verarbeitete_mails')).filter((m) => m.kunde_id === KUNDE).length);
		check('Fehlerlog nach 90 Tagen gelöscht', 0, (await tabelle('epa_fehler_log')).length);
		const z = (await lesen('epa_system_status', 'schluessel', 'loeschjob'))[0];
		const e = z ? JSON.parse(z.letztes_ergebnis) : {};
		check('Zähler gespeichert', 'ja', e.vorgaenge >= 2 && e.audit >= 1 && e.links >= 2 ? 'ja' : `nein (${z && z.letztes_ergebnis})`);
	});

	// ---------------------------------------------------------------- Härtung
	await zeile('H01', 'Freigabeseite: Sicherheits-Header (kein Einbetten, kein Caching, noindex), ungültiger Link 404 ohne Details', async (check) => {
		const basis = process.env.N8N_URL.replace(/\/+$/, '');
		const res = await fetch(`${basis}/webhook/epa-freigabe?t=${'A'.repeat(43)}`);
		const html = await res.text();
		check('Status', 404, res.status);
		check('X-Frame-Options', 'DENY', res.headers.get('x-frame-options'));
		check('n8n-Sandbox (CSP)', 'ja', /sandbox/.test(res.headers.get('content-security-policy') || '') ? 'ja' : 'nein');
		check('nosniff', 'nosniff', res.headers.get('x-content-type-options'));
		check('Cache-Control', 'no-store', res.headers.get('cache-control'));
		check('noindex', 'ja', /noindex/.test(res.headers.get('x-robots-tag') || '') ? 'ja' : 'nein');
		check('Keine internen Angaben', 'ja', !/V-20|epa_|stack|Error/.test(html) ? 'ja' : 'nein');
	});

	return zeilen;
}

module.exports = { betriebSzenarien };
