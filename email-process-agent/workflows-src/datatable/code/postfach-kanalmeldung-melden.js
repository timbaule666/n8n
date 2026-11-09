// Bei Karten-Fehler hat "Kanal-Text senden" die Meldung ersetzt; dann zählt dessen Ergebnis.
const r = ($('Kanal-Text senden').isExecuted ? $('Kanal-Text senden') : $('Kanalmeldung senden')).first().json || {};
const status = Number(r.statusCode) || null;
const ok = status === 201 && !r.error;
const meldung = ok ? '' : (r.error ? String(r.error.message || r.error) : String((r.body && r.body.error && (r.body.error.code + ': ' + r.body.error.message)) || 'HTTP ' + status)).slice(0, 200);
return [{ json: { gesendet: ok, status, meldung } }];
