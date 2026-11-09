// Fertige Karte per Marker <!--EPA_KARTE:base64--> hat Vorrang vor der automatisch aus dem HTML gebauten.
const j = $input.first().json;
const raw = String($('Bei Einzelaufruf').first().json.html || '');
const m = raw.match(/<!--EPA_KARTE:([A-Za-z0-9+\/=]+)-->/);
if (!m) return [{ json: j }];
try {
	const t = Buffer.from(m[1], 'base64').toString('utf8');
	JSON.parse(t);
	return [{ json: { ...j, mit_karte: true, payload: { body: { contentType: 'html', content: '<attachment id="karte1"></attachment>' }, attachments: [{ id: 'karte1', contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: t }] } } }];
} catch (err) {
	return [{ json: j }];
}
