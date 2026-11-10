// Bereits gesendete Kanal-Karte ersetzen (Freigabe erledigt). Erwartet die Karte als Marker <!--EPA_KARTE:base64-->.
const e = $('Bei Einzelaufruf').first().json;
const vid = e.vorgangs_id || '-';
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(e.team_id || ''))) throw new Error('[EPA:424:KONFIGURATIONSFEHLER:' + vid + '] team_id muss eine GUID sein');
if (!/^19:[^\s]+@thread\.[a-z0-9]+$/i.test(String(e.channel_id || '').trim())) throw new Error('[EPA:424:KONFIGURATIONSFEHLER:' + vid + '] channel_id ungültig');
if (!/^\d{6,20}$/.test(String(e.graph_id || ''))) throw new Error('[EPA:400:UNGUELTIGES_FORMAT:' + vid + '] Nachrichten-ID ungültig');
const m = String(e.html || '').match(/<!--EPA_KARTE:([A-Za-z0-9+\/=]+)-->/);
if (!m) throw new Error('[EPA:400:UNGUELTIGES_FORMAT:' + vid + '] Karte fehlt');
const karte = Buffer.from(m[1], 'base64').toString('utf8');
JSON.parse(karte);
const payload = { body: { contentType: 'html', content: '<attachment id="karte1"></attachment>' }, attachments: [{ id: 'karte1', contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: karte }] };
return [{ json: { team_id: e.team_id.trim(), channel_id: e.channel_id.trim(), nachricht_id: String(e.graph_id), payload } }];
