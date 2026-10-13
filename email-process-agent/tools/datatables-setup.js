#!/usr/bin/env node
'use strict';
// Legt die EPA-Data-Tables laut config/datatables/schema.json an (idempotent: fehlende Tabellen und
// Spalten werden ergänzt, nichts wird gelöscht), spielt optional die Beispiel-Config und die Prompts ein.
//
// Aufruf:
//   N8N_URL=… N8N_API_KEY=… node tools/datatables-setup.js [--beispiel] [--postfach=a@b.de] [--freigeber=c@d.de] [--prompts]
//
// --prompts überträgt prompts/<version>/*.md in epa_prompts. Eine vorhandene Version wird nie überschrieben:
// Weicht der Inhalt ab, bricht das Skript ab (Prompt-Änderung = neue Version, z. B. prompts/v2).
const fs = require('node:fs');
const path = require('node:path');
const { allePrompts } = require('./lib/prompts');

const ROOT = path.resolve(__dirname, '..');
const BASIS = (process.env.N8N_URL || '').replace(/\/+$/, '');
const KEY = process.env.N8N_API_KEY;

async function api(methode, pfad, body) {
	const res = await fetch(`${BASIS}/api/v1${pfad}`, {
		method: methode,
		headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${methode} ${pfad} -> ${res.status}: ${text.slice(0, 400)}`);
	return text ? JSON.parse(text) : {};
}

async function alleTabellen() {
	const liste = [];
	let cursor;
	do {
		const q = new URLSearchParams({ limit: '100' });
		if (cursor) q.set('cursor', cursor);
		const r = await api('GET', `/data-tables?${q}`);
		liste.push(...r.data);
		cursor = r.nextCursor;
	} while (cursor);
	return liste;
}

async function alleZeilen(tabellenId) {
	const liste = [];
	let cursor;
	do {
		const q = new URLSearchParams({ limit: '250' });
		if (cursor) q.set('cursor', cursor);
		const r = await api('GET', `/data-tables/${tabellenId}/rows?${q}`);
		liste.push(...r.data);
		cursor = r.nextCursor;
	} while (cursor);
	return liste;
}

async function einrichten({ beispiel = false, postfach, freigeber, prompts = false, log = console.log } = {}) {
	const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'datatables', 'schema.json'), 'utf8')).tabellen;
	const vorhanden = await alleTabellen();
	const ids = {};
	for (const [name, spalten] of Object.entries(schema)) {
		let t = vorhanden.find((x) => x.name === name);
		if (!t) {
			t = await api('POST', '/data-tables', { name, columns: Object.entries(spalten).map(([n, type]) => ({ name: n, type })) });
			log(`Tabelle angelegt: ${name}`);
		} else {
			const cols = await api('GET', `/data-tables/${t.id}/columns`);
			const namen = new Set((cols.data || cols).map((c) => c.name));
			for (const [n, type] of Object.entries(spalten)) {
				if (!namen.has(n)) {
					await api('POST', `/data-tables/${t.id}/columns`, { name: n, type });
					log(`Spalte ergänzt: ${name}.${n}`);
				}
			}
			log(`Tabelle vorhanden: ${name}`);
		}
		ids[name] = t.id;
	}
	if (beispiel) {
		const daten = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'datatables', 'beispiel-transport.json'), 'utf8'));
		const kunde = daten.epa_config_allgemein[0].kunde_id;
		const schon = (await alleZeilen(ids.epa_config_allgemein)).some((z) => z.kunde_id === kunde);
		if (schon) {
			log(`Beispiel-Config "${kunde}" ist schon vorhanden, nichts geändert.`);
		} else {
			const allg = { ...daten.epa_config_allgemein[0] };
			if (postfach) allg.postfach = postfach.toLowerCase();
			if (freigeber) allg.freigeber = JSON.stringify(freigeber.split(',').map((s) => s.trim().toLowerCase()));
			await api('POST', `/data-tables/${ids.epa_config_allgemein}/rows`, { data: [allg], returnType: 'count' });
			await api('POST', `/data-tables/${ids.epa_config_pflichtfelder}/rows`, { data: daten.epa_config_pflichtfelder, returnType: 'count' });
			log(`Beispiel-Config "${kunde}" eingespielt (${daten.epa_config_pflichtfelder.length} Felder).`);
		}
	}
	if (prompts) {
		const vorhanden = await alleZeilen(ids.epa_prompts);
		const neu = [];
		for (const p of allePrompts()) {
			const alt = vorhanden.find((z) => z.name === p.name && z.version === p.version);
			if (!alt) neu.push(p);
			else if (alt.pruefsumme !== p.pruefsumme) {
				throw new Error(`Prompt ${p.name}/${p.version} ist in der Instanz anders als im Repo. Änderungen bitte als neue Version (z. B. prompts/v2) anlegen.`);
			} else log(`Prompt ${p.name}/${p.version} ist aktuell.`);
		}
		if (neu.length) {
			await api('POST', `/data-tables/${ids.epa_prompts}/rows`, { data: neu, returnType: 'count' });
			for (const p of neu) log(`Prompt eingespielt: ${p.name}/${p.version}`);
		}
	}
	return ids;
}

if (require.main === module) {
	if (!BASIS || !KEY) {
		console.error('N8N_URL und N8N_API_KEY setzen.');
		process.exit(2);
	}
	const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || undefined;
	einrichten({ beispiel: process.argv.includes('--beispiel'), postfach: arg('postfach'), freigeber: arg('freigeber'), prompts: process.argv.includes('--prompts') }).catch((e) => {
		console.error(e.message);
		process.exit(1);
	});
}

module.exports = { einrichten, alleTabellen, alleZeilen, api };
