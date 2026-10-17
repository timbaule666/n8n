'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const u = require('../src/uebersicht');

const JETZT = '2026-10-17T08:00:00.000Z';
const vg = (x) => ({ id: 1, kunde_id: 'k1', vorgangs_id: 'V-2026-0001', status: 'Bereit zur Bearbeitung', betreff: 'Paletten', absender_name: 'Melanie Busch', absender_adresse: 'mb@x.de', updatedAt: '2026-10-15T08:00:00.000Z', extrahierte_daten: '{"Start_Ort":{"wert":"Hagen"},"Gewicht_kg":{"wert":850},"Leer":{"wert":""}}', fehlende_felder: '[]', konflikte: '[]', erste_mail_link: 'https://outlook.office365.com/owa/?ItemID=1', ...x });

test('Zugang: Token, Hash, Link, Ablauf; Kunde nur aus dem Zugang', () => {
	const { token, hash } = u.tokenErzeugen(crypto);
	assert.equal(u.istGueltigesToken(token), true);
	assert.equal(u.istGueltigesToken('kurz'), false);
	assert.equal(u.istGueltigesToken(token + "'"), false);
	assert.equal(hash, u.tokenHash(crypto, token));
	assert.equal(u.link('https://a.b/', token), `https://a.b/webhook/epa-uebersicht?k=${token}`);
	const z = u.zugangZeile({ kunde_id: 'k1', hash, jetzt: JETZT });
	assert.equal(z.ablauf, '2026-11-16T08:00:00.000Z');
	assert.deepEqual(u.zugangPruefen({ zugang: { ...z, id: 3 }, jetzt: JETZT }), { ok: true, kunde_id: 'k1' });
	assert.equal(u.zugangPruefen({ zugang: { ...z, id: 3 }, jetzt: '2026-11-17T00:00:00.000Z' }).status, 410);
	assert.equal(u.zugangPruefen({ zugang: { ...z, id: 3, gesperrt_am: JETZT }, jetzt: JETZT }).status, 403);
	assert.equal(u.zugangPruefen({ zugang: {}, jetzt: JETZT }).status, 404);
	assert.equal(u.zugangPruefen({ zugang: null, jetzt: JETZT }).status, 404);
});

test('Gruppieren: nur eigener Kunde, Endstatus ausgeblendet, älteste zuerst, Anzeigenamen', () => {
	const g = u.gruppieren({
		kunde_id: 'k1',
		jetzt: JETZT,
		felder: [{ feldname: 'Gewicht_kg', anzeigename: 'Gewicht (kg)' }],
		freigaben: [{ kunde_id: 'k1', freigabe_id: 'F-1', status: 'offen', ablauf: '2026-10-19T08:00:00.000Z' }, { kunde_id: 'k2', freigabe_id: 'F-2', status: 'offen' }],
		vorgaenge: [
			vg({}),
			vg({ vorgangs_id: 'V-2026-0002', updatedAt: '2026-10-10T08:00:00.000Z' }),
			vg({ vorgangs_id: 'V-2026-0003', kunde_id: 'k2' }),
			vg({ vorgangs_id: 'V-2026-0004', status: 'Abgeschlossen' }),
			vg({ vorgangs_id: 'V-2026-0005', status: 'Ignoriert' }),
			vg({ vorgangs_id: 'V-2026-0006', status: 'Freigabe ausstehend', freigabe_id_aktuell: 'F-1', fehlende_felder: '[{"feldname":"Telefon","anzeigename":"Telefonnummer"}]' }),
			vg({ vorgangs_id: 'V-2026-0007', status: 'Eskaliert / Manuell', spoofing_hinweis: 'x' }),
		],
	});
	const z = u.zaehlen(g);
	assert.deepEqual(z, { klaerung: 1, freigabe: 1, bereit: 2, kunde: 0, system: 0 });
	const bereit = g.find((x) => x.key === 'bereit').eintraege;
	assert.deepEqual(bereit.map((e) => e.vorgangs_id), ['V-2026-0002', 'V-2026-0001']);
	assert.equal(bereit[0].tage, 7);
	assert.deepEqual(bereit[1].angaben, [['Start Ort', 'Hagen'], ['Gewicht (kg)', 850]]);
	const fg = g.find((x) => x.key === 'freigabe').eintraege[0];
	assert.equal(fg.freigabe_bis, '2026-10-19T08:00:00.000Z');
	assert.deepEqual(fg.fehlend, ['Telefonnummer']);
	assert.match(g.find((x) => x.key === 'klaerung').eintraege[0].hinweis, /gefälscht/);
	const alles = JSON.stringify(g);
	assert.equal(alles.includes('V-2026-0003'), false);
	assert.equal(alles.includes('V-2026-0004'), false);
});

test('Seite und Zusammenfassung: escaped, Link, Zahlen; nur https-Mail-Links', () => {
	const g = u.gruppieren({ kunde_id: 'k1', jetzt: JETZT, felder: [], freigaben: [], vorgaenge: [
		vg({ betreff: '<script>alert(1)</script>', erste_mail_link: 'javascript:alert(1)' }),
		vg({ vorgangs_id: 'V-2026-0009', status: 'Eskaliert / Manuell', betreff: 'Kiel & Co' }),
	] });
	const html = u.seite({ kunde: { kunde_id: 'k1', postfach: 'p@x.de' }, gruppen: g, jetzt: JETZT, zone: 'Europe/Berlin', ablauf: '2026-11-16T08:00:00.000Z' });
	assert.equal(html.includes('<script>'), false);
	assert.match(html, /&lt;script&gt;/);
	assert.equal(html.includes('javascript:'), false);
	assert.match(html, /Klärung nötig \(1\)/);
	assert.match(html, /Kiel &amp; Co/);
	const t = u.zusammenfassung({ gruppen: g, link: 'https://a.b/webhook/epa-uebersicht?k=abc', ablauf: '2026-11-16T08:00:00.000Z', zone: 'Europe/Berlin' });
	assert.match(t, /📋 Tagesübersicht: 2 offene Vorgänge/);
	assert.match(t, /Klärung nötig: <b>1<\/b>/);
	assert.match(t, /• V-2026-0009: Kiel &amp; Co, seit 2 Tagen/);
	assert.match(t, /href="https:\/\/a\.b\/webhook\/epa-uebersicht\?k=abc"/);
	assert.equal(t.includes('Wartet auf Kunde'), false);
	const leer = u.zusammenfassung({ gruppen: u.gruppieren({ kunde_id: 'k1', vorgaenge: [], jetzt: JETZT }), link: 'https://a.b/x', ablauf: JETZT, zone: 'Europe/Berlin' });
	assert.match(leer, /keine offenen Vorgänge/);
	assert.match(leer, /Klärung nötig: <b>0<\/b>/);
});
