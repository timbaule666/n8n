// Bei Karten-Fehler hat "Text-Nachricht senden" die Nachricht ersetzt; dann zählt dessen Ergebnis.
const nachricht = $('Text-Nachricht senden').isExecuted ? 'Text-Nachricht senden' : 'Chat-Nachricht senden';
const schritte = [['Teams-Konto lesen', 200], ['Chat öffnen', 201], [nachricht, 201]];
for (const [name, soll] of schritte) {
	const r = $(name).first().json || {};
	const status = Number(r.statusCode) || null;
	// Ein bestehender 1:1-Chat liefert 200 statt 201
	if (r.error || (status !== soll && !(name === 'Chat öffnen' && status === 200))) {
		const grund = r.error ? String(r.error.message || r.error) : String((r.body && r.body.error && (r.body.error.code + ': ' + r.body.error.message)) || 'HTTP ' + status);
		return [{ json: { gesendet: false, status, meldung: (name + ': ' + grund).slice(0, 200) } }];
	}
}
return [{ json: { gesendet: true, status: 201, meldung: '' } }];
