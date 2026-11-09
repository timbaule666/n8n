// Teams-Karte zur Freigabe-Nachricht (Marker <!--EPA_KARTE:base64-->); der Text bleibt als Rückfall erhalten.
const config = $('Config laden').first().json.config;
const items = $input.all();
if (!config.benachrichtigung || config.benachrichtigung.kanal !== 'teams') return items;
try {
	const v = $('Vorgang lesen').first().json.vorgang;
	const r = $('Rückfrage vorbereiten').first().json;
	const z = $('Entwurf zusammensetzen').first().json;
	const kontext = String((($('Bei Aufruf').first().json) || {}).kontext_html || '');
	const entsch = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
	const ablaufText = DateTime.fromISO(z.ablauf).setZone(config.zeitzone).toFormat('dd.LL.yyyy, HH:mm');
	const felderDef = config.vorgangstypen[v.vorgangstyp] || [];
	let daten = v.extrahierte_daten || {};
	if (typeof daten === 'string') { try { daten = JSON.parse(daten); } catch (err) { daten = {}; } }
	const fehlt = new Set((r.fehlende || []).map((f) => f.feldname));
	const wertText = (f) => {
		const w = (daten[f.feldname] || {}).wert;
		if (w === null || w === undefined || w === '') return '';
		if (f.typ === 'datum' && /^\d{4}-\d{2}-\d{2}$/.test(String(w))) { const [j, m, t] = String(w).split('-'); return t + '.' + m + '.' + j; }
		return String(w);
	};
	const zeile = (t) => ({ type: 'TextBlock', text: t, wrap: true, spacing: 'Small' });
	let vorhanden = felderDef.filter((f) => !fehlt.has(f.feldname) && wertText(f)).map((f) => '✅ ' + (f.anzeigename || f.feldname) + ': ' + wertText(f));
	if (vorhanden.length > 10) vorhanden = vorhanden.slice(0, 10).concat(['… und weitere']);
	const fehlend = (r.fehlende || []).map((f) => '❌ ' + (f.anzeigename || f.feldname));
	const warnungen = kontext.split('<br>').filter((s) => s.includes('⚠️')).map((s) => entsch(s.replace(/<[^>]+>/g, '')).trim()).filter(Boolean);
	const erinnerung = r.freigabe_art === 'erinnerung';
	const erneut = r.art === 'erneut';
	const absender = v.absender_name || v.absender_adresse || '';
	const entwurfText = String(z.text || '').slice(0, 800);
	const out = items.map((it) => {
		const html = String((it.json || {}).nachricht_html || '');
		const m = html.match(/<a href="([^"]+)">Entwurf ansehen/);
		if (!m) return it;
		const url = entsch(m[1]);
		const body = [
			{ type: 'ColumnSet', columns: [
				{ type: 'Column', width: 'stretch', items: [{ type: 'TextBlock', text: 'Freigabe erforderlich', weight: 'Bolder', size: 'Medium', wrap: true }] },
				{ type: 'Column', width: 'auto', items: [{ type: 'TextBlock', text: erinnerung ? 'ERINNERUNG' : 'RÜCKFRAGE', weight: 'Bolder', size: 'Small', color: 'Attention' }] },
			] },
		];
		if (erneut) body.push({ type: 'TextBlock', text: '🔁 Erneut zur Freigabe: Die Nachricht kam beim Kunden nicht an.', wrap: true, color: 'Warning', weight: 'Bolder', spacing: 'Small' });
		body.push({ type: 'TextBlock', text: '**' + absender + '** · ' + (v.betreff || '') + ' (' + v.vorgangs_id + ')', wrap: true, spacing: 'Small' });
		body.push({ type: 'ColumnSet', spacing: 'Medium', columns: [
			{ type: 'Column', width: 'stretch', items: [{ type: 'TextBlock', text: 'VORHANDEN', weight: 'Bolder', size: 'Small', color: 'Good' }].concat(vorhanden.length ? vorhanden.map(zeile) : [zeile('–')]) },
			{ type: 'Column', width: 'stretch', items: [{ type: 'TextBlock', text: 'FEHLT NOCH', weight: 'Bolder', size: 'Small', color: 'Attention' }].concat(fehlend.map(zeile)) },
		] });
		if (warnungen.length) body.push({ type: 'TextBlock', text: warnungen.map((w) => '⚠️ ' + w).join('\n\n'), wrap: true, color: 'Warning', spacing: 'Medium' });
		body.push({ type: 'Container', style: 'emphasis', spacing: 'Medium', items: [
			{ type: 'TextBlock', text: 'ENTWURF DER RÜCKFRAGE', weight: 'Bolder', size: 'Small', isSubtle: true },
			{ type: 'TextBlock', text: entwurfText, wrap: true },
		] });
		body.push({ type: 'TextBlock', text: 'Persönlicher Link, einmal verwendbar, gültig bis ' + ablaufText + '. Bitte nicht weiterleiten. Es wird nichts ohne Ihren Klick versendet.', isSubtle: true, size: 'Small', wrap: true, spacing: 'Medium' });
		const karte = { type: 'AdaptiveCard', '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body, actions: [{ type: 'Action.OpenUrl', title: 'Entwurf prüfen und freigeben', url, style: 'positive' }] };
		const b64 = Buffer.from(JSON.stringify(karte), 'utf8').toString('base64');
		return { json: { ...it.json, nachricht_html: html + '<!--EPA_KARTE:' + b64 + '-->' } };
	});
	return out;
} catch (err) {
	return items;
}
