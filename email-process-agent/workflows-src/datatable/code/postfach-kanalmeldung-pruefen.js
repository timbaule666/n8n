// Wandelt eine Teams-HTML-Meldung in eine Adaptive Card (v1.4). Wirft nie; gibt bei Problemen null zurück.
function htmlZuKarte(html) {
	try {
		const dec = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
		let s = String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(/[\r\n]+/g, ' ');
		const links = [];
		s = s.replace(/<a\b[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
			const t = dec(text.replace(/<[^>]+>/g, '')).trim();
			if (/^https?:\/\//i.test(href)) links.push({ url: dec(href), title: t || 'Öffnen' });
			return '';
		});
		s = s.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '\u0001$2\u0002').replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '\u0003$2\u0004');
		s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '');
		s = dec(s).replace(/[ \t]+\n/g, '\n');
		const md = (t) => t.replace(/\u0001([^\u0002]*)\u0002/g, (m, x) => (x.trim() ? '**' + x.trim() + '**' : '')).replace(/\u0003([^\u0004]*)\u0004/g, (m, x) => (x.trim() ? '_' + x.trim() + '_' : '')).replace(/[\u0001-\u0004]/g, '');
		const zeilen = s.split('\n').map((z) => z.trim());
		// Absätze: Leerzeile trennt
		const bloecke = []; let cur = [];
		for (const z of zeilen) { if (!z) { if (cur.length) { bloecke.push(cur); cur = []; } } else cur.push(z); }
		if (cur.length) bloecke.push(cur);
		if (!bloecke.length) return null;
		const titelRoh = bloecke[0][0];
		const titel = md(titelRoh).replace(/\*\*/g, '').trim();
		const rest0 = bloecke[0].slice(1);
		let farbe = 'default';
		if (/🚨|❌|fehler|alarm/i.test(titel)) farbe = 'attention'; else if (/⏰|⚠️|erinnerung|eskalation/i.test(titel)) farbe = 'warning'; else if (/✅|bereit|erledigt|gesendet/i.test(titel)) farbe = 'good';
		const body = [{ type: 'TextBlock', text: titel.slice(0, 200), weight: 'bolder', size: 'medium', wrap: true, color: farbe }];
		const text = (t, extra) => ({ type: 'TextBlock', text: t, wrap: true, spacing: 'Small', ...(extra || {}) });
		if (rest0.length) body.push(text(rest0.map(md).join('\n\n').slice(0, 1500)));
		for (const b of bloecke.slice(1)) {
			const kopf = md(b[0]);
			if (b.length > 1 && /^\*\*[^*]+\*\*$/.test(kopf)) {
				body.push({ type: 'Container', style: 'emphasis', spacing: 'Medium', items: [text(kopf.replace(/\*\*/g, '').toUpperCase(), { isSubtle: true, size: 'small', weight: 'bolder', spacing: 'None' }), ...b.slice(1).map((z) => text(md(z).slice(0, 600)))] });
			} else {
				body.push(text(b.map(md).join('\n\n').slice(0, 1500), { spacing: 'Medium' }));
			}
		}
		const actions = links.slice(0, 4).map((l, i) => ({ type: 'Action.OpenUrl', title: l.title.slice(0, 60), url: l.url, ...(i === 0 ? { style: 'positive' } : {}) }));
		return { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body, ...(actions.length ? { actions } : {}) };
	} catch (err) { return null; }
}
const e = $('Bei Einzelaufruf').first().json;
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(e.team_id || ''))) throw new Error('[EPA:424:KONFIGURATIONSFEHLER:' + (e.vorgangs_id || '-') + '] team_id muss eine GUID sein');
if (!String(e.channel_id || '').trim()) throw new Error('[EPA:424:KONFIGURATIONSFEHLER:' + (e.vorgangs_id || '-') + '] channel_id fehlt');
if (!String(e.html || '').trim()) throw new Error('[EPA:400:UNGUELTIGES_FORMAT:' + (e.vorgangs_id || '-') + '] Nachricht fehlt');
const html = String(e.html).replace(/<!--EPA_KARTE:[A-Za-z0-9+\/=]*-->/g, '').trim();
const k = htmlZuKarte(html);
const payload = k
	? { body: { contentType: 'html', content: '<attachment id="karte1"></attachment>' }, attachments: [{ id: 'karte1', contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: JSON.stringify(k) }] }
	: { body: { contentType: 'html', content: html } };
return [{ json: { team_id: e.team_id.trim(), channel_id: e.channel_id.trim(), html, payload, mit_karte: Boolean(k) } }];
