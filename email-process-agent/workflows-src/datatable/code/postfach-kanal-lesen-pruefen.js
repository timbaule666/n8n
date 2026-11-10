// Letzte Nachrichten eines Kanals lesen (für das Aufräumen doppelter oder alter Freigabe-Karten).
const e = $('Bei Einzelaufruf').first().json;
const vid = e.vorgangs_id || '-';
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(e.team_id || ''))) throw new Error('[EPA:424:KONFIGURATIONSFEHLER:' + vid + '] team_id muss eine GUID sein');
if (!/^19:[^\s]+@thread\.[a-z0-9]+$/i.test(String(e.channel_id || '').trim())) throw new Error('[EPA:424:KONFIGURATIONSFEHLER:' + vid + '] channel_id ungültig');
return [{ json: { team_id: e.team_id.trim(), channel_id: e.channel_id.trim() } }];
