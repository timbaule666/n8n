'use strict';
// Mock für OpenAI (/v1/chat/completions) und Microsoft Graph (/graph/v1.0/...) für lokale E2E-Tests.
// Antwortet nach Skript; protokolliert jede Anfrage. Nur für Tests, lauscht ausschließlich auf 127.0.0.1.
const http = require('node:http');

function mockServer({ port = 0 } = {}) {
	const zustand = {
		llmSkript: {}, // { klassifizierung: [antwort, ...], extraktion: [...] }
		llmZaehler: {},
		llmAnfragen: [],
		graphMails: new Map(), // graph_id -> { mail, anhaenge: [{ id, name, contentType, inhalt }] }
		verschoben: [],
		graphAnfragen: [],
	};

	function textAus(nachricht) {
		if (typeof nachricht.content === 'string') return nachricht.content;
		return (nachricht.content || []).filter((t) => t.type === 'text').map((t) => t.text).join('\n');
	}

	function llm(req, body, res) {
		const aufgabe = body.response_format && body.response_format.json_schema && body.response_format.json_schema.name;
		const user = (body.messages || []).find((m) => m.role === 'user') || {};
		const text = textAus(user);
		const token = (text.match(/Ref-Test: (T\d+)/) || [])[1] || null;
		zustand.llmAnfragen.push({ aufgabe, token, body, auth: Boolean(req.headers.authorization) });
		const liste = zustand.llmSkript[aufgabe] || [];
		const i = zustand.llmZaehler[aufgabe] || 0;
		zustand.llmZaehler[aufgabe] = i + 1;
		const a = liste[i];
		if (!a) {
			res.writeHead(500, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({ error: { message: `Mock: keine Antwort Nr. ${i + 1} für ${aufgabe}` } }));
		}
		if (a.status) {
			res.writeHead(a.status, { 'content-type': 'application/json', ...(a.headers || {}) });
			return res.end(JSON.stringify({ error: { message: 'Mock-Fehler', code: a.code || null } }));
		}
		const content = a.roh !== undefined ? a.roh : JSON.stringify(a.json);
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({
			id: 'mock-' + Date.now(),
			model: 'mock-' + body.model,
			choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
			usage: { prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4), completion_tokens: Math.ceil(content.length / 4) },
		}));
	}

	function graph(req, url, body, res) {
		zustand.graphAnfragen.push({ methode: req.method, pfad: url.pathname });
		const json = (status, obj) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(obj));
		};
		const teile = url.pathname.split('/').map(decodeURIComponent); // ['', 'graph', 'v1.0', 'users', p, 'messages', id, ...]
		if (teile[5] === 'mailFolders') return json(200, { value: [{ id: 'ordner-archiv', displayName: 'EPA-Archiv' }, { id: 'ordner-x', displayName: 'Anderes' }] });
		const eintrag = zustand.graphMails.get(teile[6]);
		if (teile[5] !== 'messages' || !eintrag) return json(404, { error: { code: 'ErrorItemNotFound', message: 'not found' } });
		if (teile.length === 7 && req.method === 'GET') return json(200, eintrag.mail);
		if (teile[7] === 'move' && req.method === 'POST') {
			zustand.verschoben.push({ graph_id: teile[6], ziel: body.destinationId });
			return json(201, { id: teile[6] + '-verschoben' });
		}
		if (teile[7] === 'attachments' && teile.length === 8) {
			return json(200, { value: eintrag.anhaenge.map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', id: a.id, name: a.name, contentType: a.contentType, size: a.inhalt.length, isInline: false })) });
		}
		if (teile[7] === 'attachments' && teile[9] === '$value') {
			const a = eintrag.anhaenge.find((x) => x.id === teile[8]);
			if (!a) return json(404, { error: { code: 'ErrorItemNotFound' } });
			res.writeHead(200, { 'content-type': a.contentType, 'content-length': a.inhalt.length });
			return res.end(a.inhalt);
		}
		return json(400, { error: { message: 'Mock: unbekannte Route ' + url.pathname } });
	}

	const server = http.createServer((req, res) => {
		const teile = [];
		req.on('data', (d) => teile.push(d));
		req.on('end', () => {
			const roh = Buffer.concat(teile).toString('utf8');
			let body = {};
			try {
				body = roh ? JSON.parse(roh) : {};
			} catch {
				body = {};
			}
			const url = new URL(req.url, 'http://127.0.0.1');
			if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return llm(req, body, res);
			if (url.pathname.startsWith('/graph/v1.0/')) return graph(req, url, body, res);
			res.writeHead(404);
			res.end();
		});
	});

	return {
		zustand,
		starten: () => new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server.address().port))),
		stoppen: () => new Promise((ok) => server.close(() => ok())),
		fall(llmSkript) {
			zustand.llmSkript = llmSkript || {};
			zustand.llmZaehler = {};
			zustand.llmAnfragen = [];
			zustand.verschoben = [];
		},
	};
}

module.exports = { mockServer };
