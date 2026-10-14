'use strict';
// Mock für OpenAI (/v1/chat/completions), Microsoft Graph (/graph/v1.0/...) und die Telegram-Bot-API (/telegram/...,
// nur Testkanal) für lokale E2E-Tests.
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
		entwuerfe: new Map(), // draft-id -> { id, subject, body, toRecipients, internetMessageId, props, gesendet }
		gesendet: [], // gesendete Entwürfe (Reihenfolge)
		sendeFehler: null, // 'vorher' = 500 ohne Versand, 'nachher' = Versand erfolgt, Antwort trotzdem 500
		chats: [], // { freigeber, chat_id, content }
		chatFehlerFuer: new Set(), // Freigeber, deren Chat nicht geöffnet werden kann (403)
		meFehler: null, // HTTP-Status für GET /me (Watchdog: Teams-Credential ungültig)
		modelleFehler: null, // HTTP-Status für GET /v1/models (Watchdog: KI-Anbieter)
		postfachFehler: null, // HTTP-Status für GET .../mailFolders/inbox (Watchdog: Outlook-Credential)
		geloescht: [], // per DELETE entfernte Nachrichten-IDs
		mailLadenFehler: null, // HTTP-Status für GET einer eingegangenen Mail (Graph nicht erreichbar / Token abgelaufen)
		telegram: [], // Testkanal: { chat_id, text, parse_mode } je sendMessage
		telegramFehler: null, // HTTP-Status für sendMessage (z. B. 400 "chat not found")
		zaehler: 0,
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
		let a = liste[i];
		// Ohne Skript: gültige Hülle für den Rückfrage-Entwurf (M2-Fälle mit Lücken lösen EPA-02 aus)
		if (!a && aufgabe === 'entwurf' && !zustand.llmSkript.entwurf) a = { json: { anrede: 'Guten Tag,', einleitung: 'vielen Dank für Ihre Anfrage. Für die Bearbeitung fehlen uns noch folgende Angaben:', schluss: 'Vielen Dank für Ihre Rückmeldung.' } };
		if (a && a.verzoegerung) {
			// Langsame Antwort (Timeout-Test): danach normal antworten bzw. ins Leere, falls der Client abgebrochen hat
			const { verzoegerung, ...rest } = a;
			setTimeout(() => antworten(rest), verzoegerung);
			return;
		}
		antworten(a);
		return;

		function antworten(a) {
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
	}

	function teams(req, url, body, res, json) {
		const pfad = url.pathname.replace(/^\/graph\/v1\.0/, '');
		if (pfad === '/me' && req.method === 'GET') return zustand.meFehler ? json(zustand.meFehler, { error: { code: 'InvalidAuthenticationToken', message: 'Mock' } }) : json(200, { id: 'dienstkonto-id' });
		if (pfad === '/chats' && req.method === 'POST') {
			const m = (body.members || []).map((x) => String(x['user@odata.bind'] || '').match(/users\('([^']+)'\)/)).filter(Boolean).map((x) => x[1].replace(/''/g, "'"));
			const freigeber = m.find((x) => x !== 'dienstkonto-id');
			if (body.chatType !== 'oneOnOne' || !freigeber) return json(400, { error: { message: 'Mock: ungültiger Chat' } });
			if (zustand.chatFehlerFuer.has(freigeber)) return json(403, { error: { code: 'Forbidden', message: 'Mock: Chat nicht erlaubt' } });
			zustand.chatIds = zustand.chatIds || new Set();
			zustand.chatIds.add('chat-' + freigeber);
			return json(201, { id: 'chat-' + freigeber });
		}
		const cm = pfad.match(/^\/chats\/([^/]+)\/messages$/);
		if (cm && req.method === 'POST') {
			const chatId = decodeURIComponent(cm[1]);
			if (!zustand.chatIds || !zustand.chatIds.has(chatId)) return json(404, { error: { code: 'NotFound', message: 'Mock: Chat existiert nicht' } });
			zustand.chats.push({ chat_id: chatId, freigeber: chatId.replace(/^chat-/, ''), content: body.body && body.body.content });
			return json(201, { id: 'msg-' + (++zustand.zaehler) });
		}
		return null;
	}

	function mailNachInternetId(iid) {
		for (const e of zustand.graphMails.values()) if (e.mail.internetMessageId === iid) return e.mail;
		return null;
	}

	function graph(req, url, body, res) {
		zustand.graphAnfragen.push({ methode: req.method, pfad: url.pathname });
		const json = (status, obj) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(obj));
		};
		if (teams(req, url, body, res, json) !== null) return;
		const teile = url.pathname.split('/').map(decodeURIComponent); // ['', 'graph', 'v1.0', 'users', p, 'messages', id, ...]
		const filter = url.searchParams.get('$filter') || '';
		if (teile[5] === 'mailFolders' && teile[6] === 'sentitems') {
			const m = filter.match(/ep\/value eq '([^']*)'/);
			const treffer = zustand.gesendet.filter((d) => m && d.props['EPA-Freigabe-ID'] === m[1]);
			return json(200, { value: treffer.map((d) => ({ id: 'sent-' + d.id, internetMessageId: d.internetMessageId })) });
		}
		if (teile[5] === 'mailFolders' && teile[6] === 'inbox' && teile.length === 7) {
			return zustand.postfachFehler ? json(zustand.postfachFehler, { error: { code: 'ErrorAccessDenied', message: 'Mock' } }) : json(200, { id: 'inbox' });
		}
		if (teile[5] === 'mailFolders') return json(200, { value: [{ id: 'ordner-archiv', displayName: 'EPA-Archiv' }, { id: 'ordner-x', displayName: 'Anderes' }] });
		if (teile[5] === 'messages' && teile.length === 6 && req.method === 'GET') {
			const m = filter.match(/^internetMessageId eq '(.*)'$/);
			const mail = m ? mailNachInternetId(m[1].replace(/''/g, "'")) : null;
			return json(200, { value: mail ? [{ id: mail.id, subject: mail.subject }] : [] });
		}
		const entwurf = zustand.entwuerfe.get(teile[6]);
		if (entwurf) {
			if (entwurf.geloescht) return json(404, { error: { code: 'ErrorItemNotFound' } });
			if (teile.length === 7 && req.method === 'GET') {
				if (entwurf.gesendet) return json(404, { error: { code: 'ErrorItemNotFound' } });
				const props = /singleValueExtendedProperties/.test(url.searchParams.get('$expand') || '') && entwurf.props['EPA-Freigabe-ID']
					? { singleValueExtendedProperties: [{ id: 'String {00020329-0000-0000-c000-000000000046} Name EPA-Freigabe-ID', value: entwurf.props['EPA-Freigabe-ID'] }] } : {};
				return json(200, { id: entwurf.id, isDraft: true, internetMessageId: entwurf.internetMessageId, ...props });
			}
			if (teile.length === 7 && req.method === 'DELETE') {
				entwurf.geloescht = true;
				zustand.geloescht.push(entwurf.id);
				res.writeHead(204);
				return res.end();
			}
			if (teile.length === 7 && req.method === 'PATCH') {
				if (entwurf.gesendet) return json(404, { error: { code: 'ErrorItemNotFound' } });
				if (body.subject !== undefined) entwurf.subject = body.subject;
				if (body.body) entwurf.body = body.body;
				for (const p of body.singleValueExtendedProperties || []) entwurf.props[String(p.id).split(' Name ')[1]] = p.value;
				entwurf.patches += 1;
				return json(200, { ...entwurf, props: undefined });
			}
			if (teile[7] === 'send' && req.method === 'POST') {
				if (entwurf.gesendet) return json(404, { error: { code: 'ErrorItemNotFound' } });
				if (zustand.sendeFehler === 'vorher') return json(500, { error: { message: 'Mock: Versand fehlgeschlagen' } });
				entwurf.gesendet = true;
				zustand.gesendet.push(entwurf);
				if (zustand.sendeFehler === 'nachher') return json(500, { error: { message: 'Mock: Antwort verloren' } });
				res.writeHead(202);
				return res.end();
			}
		}
		const eintrag = zustand.graphMails.get(teile[6]);
		if (teile[5] !== 'messages' || !eintrag) return json(404, { error: { code: 'ErrorItemNotFound', message: 'not found' } });
		if (teile.length === 7 && req.method === 'GET' && zustand.mailLadenFehler) return json(zustand.mailLadenFehler, { error: { code: zustand.mailLadenFehler === 401 ? 'InvalidAuthenticationToken' : 'ServiceUnavailable', message: 'Mock' } });
		if (teile.length === 7 && req.method === 'GET') return json(200, eintrag.mail);
		if (teile.length === 7 && req.method === 'DELETE') {
			zustand.geloescht.push(teile[6]);
			res.writeHead(204);
			return res.end();
		}
		if (teile[7] === 'createReply' && req.method === 'POST') {
			const id = 'draft-' + (++zustand.zaehler);
			const d = { id, subject: 'RE: ' + eintrag.mail.subject, body: { contentType: 'HTML', content: '<p>Zitat</p>' }, toRecipients: [eintrag.mail.from], internetMessageId: '<' + id + '@spedition.example>', isDraft: true, props: {}, gesendet: false, patches: 0, zu: teile[6] };
			zustand.entwuerfe.set(id, d);
			return json(201, { ...d, props: undefined });
		}
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
			if (url.pathname === '/v1/models' && req.method === 'GET') {
				res.writeHead(zustand.modelleFehler || 200, { 'content-type': 'application/json' });
				return res.end(JSON.stringify(zustand.modelleFehler ? { error: { message: 'Mock-Fehler' } } : { data: [{ id: 'mock-modell' }] }));
			}
			if (url.pathname.startsWith('/graph/v1.0/')) return graph(req, url, body, res);
			// Telegram-Bot-API (nur Testkanal "telegram_test"): /telegram/bot<token>/sendMessage
			const tg = url.pathname.match(/^\/telegram\/bot[^/]+\/(\w+)$/);
			if (tg) {
				res.writeHead(tg[1] === 'sendMessage' && zustand.telegramFehler ? zustand.telegramFehler : 200, { 'content-type': 'application/json' });
				if (tg[1] !== 'sendMessage') return res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: 'epa_mock_bot' } }));
				if (zustand.telegramFehler) return res.end(JSON.stringify({ ok: false, error_code: zustand.telegramFehler, description: 'Bad Request: chat not found' }));
				zustand.telegram.push({ chat_id: String(body.chat_id), text: body.text, parse_mode: body.parse_mode });
				return res.end(JSON.stringify({ ok: true, result: { message_id: zustand.telegram.length, chat: { id: body.chat_id }, text: body.text } }));
			}
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
