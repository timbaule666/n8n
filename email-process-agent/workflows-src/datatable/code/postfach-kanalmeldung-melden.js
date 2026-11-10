// Bei Karten-Fehler hat "Kanal-Text senden" die Meldung ersetzt; dann zählt dessen Ergebnis.
const r = ($('Kanal-Text senden').isExecuted ? $('Kanal-Text senden') : $('Kanalmeldung senden')).first().json || {};
const status = Number(r.statusCode) || null;
const ok = status === 201 && !r.error;
const meldung = ok ? '' : (r.error ? String(r.error.message || r.error) : String((r.body && r.body.error && (r.body.error.code + ': ' + r.body.error.message)) || 'HTTP ' + status)).slice(0, 200);
// ID der Teams-Nachricht: damit kann die Karte später geändert werden (z. B. Freigabe erledigt).
const k = $('Kanalmeldung prüfen').first().json;
const nachricht_id = ok && r.body && /^\d{6,20}$/.test(String(r.body.id || '')) ? String(r.body.id) : '';
return [{ json: { gesendet: ok, status, meldung, nachricht_id, team_id: k.team_id, channel_id: k.channel_id } }];
