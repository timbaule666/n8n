// Gesendete Kanal-Karte entfernen (Rückfrage verschickt; die Meldung steht dann in "Systemmeldungen").
const e = $('Bei Einzelaufruf').first().json;
const vid = e.vorgangs_id || '-';
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(e.team_id || ''))) throw new Error('[EPA:424:KONFIGURATIONSFEHLER:' + vid + '] team_id muss eine GUID sein');
if (!/^19:[^\s]+@thread\.[a-z0-9]+$/i.test(String(e.channel_id || '').trim())) throw new Error('[EPA:424:KONFIGURATIONSFEHLER:' + vid + '] channel_id ungültig');
if (!/^\d{6,20}$/.test(String(e.graph_id || ''))) throw new Error('[EPA:400:UNGUELTIGES_FORMAT:' + vid + '] Nachrichten-ID ungültig');
return [{ json: { team_id: e.team_id.trim(), channel_id: e.channel_id.trim(), nachricht_id: String(e.graph_id) } }];
