// Baut die Abschlusskarte (Adaptive Card 1.4) mit Zeitleiste für einen Vorgang. Wirft nie nach außen.
const cfgRow = ($('Kunde lesen').first() || { json: {} }).json || {};
const v = ($('Vorgang lesen').first() || { json: {} }).json || {};
const audit = $('Audit lesen').all().map((i) => i.json).filter((r) => r && r.typ);
const ein = $('Status prüfen').first().json;
const leer = (grund) => [{ json: { ok: false, grund } }];
try {
	const channel = String(cfgRow.log_channel_id || '').trim();
	let ben = {};
	try { ben = JSON.parse(cfgRow.benachrichtigung || '{}'); } catch (e) { ben = {}; }
	if (!channel) return leer('kein log_channel_id in der Config');
	if (!/^[0-9a-f-]{36}$/i.test(String(ben.team_id || ''))) return leer('team_id fehlt');
	if (!v.vorgangs_id) return leer('Vorgang nicht gefunden');
	const tz = cfgRow.zeitzone || 'Europe/Berlin';
	const fmtZeit = (iso) => new Intl.DateTimeFormat('de-DE', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
	const fmtLang = (iso) => new Intl.DateTimeFormat('de-DE', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
	const pj = (s) => { try { return JSON.parse(s || '{}') || {}; } catch (e) { return {}; } };
	const nice = (f) => String(f).replace(/_/g, ' ');
	const name = (a) => String(a || '').replace(/^Mitarbeiter:/, '').split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
	audit.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
	const zeilen = [];
	let merge = [];
	let mergeZeit = null;
	const flush = () => { if (merge.length) { zeilen.push([mergeZeit, 'Angaben aus der Antwort übernommen: ' + merge.map(nice).join(', ')]); merge = []; } };
	for (const r of audit) {
		const d = pj(r.details);
		if (r.typ === 'MERGE') { if (!merge.length) mergeZeit = r.createdAt; if (d.feld) merge.push(d.feld); continue; }
		flush();
		if (r.typ === 'ZUORDNUNG') { zeilen.push([r.createdAt, 'Mail dem Vorgang zugeordnet (' + (d.ergebnis || 'eindeutig') + ')']); continue; }
		if (r.typ !== 'STATUS') continue;
		const neu = r.neu; const alt = r.alt;
		let t;
		if (neu === 'Neu') t = 'Mail empfangen, Vorgang angelegt';
		else if (neu === 'In Prüfung' && d.klasse) t = 'Als Anfrage erkannt' + (d.konfidenz ? ' (Sicherheit ' + Math.round(d.konfidenz * 100) + ' %)' : '');
		else if (neu === 'In Prüfung') t = 'Kundenantwort eingegangen, wird ausgewertet';
		else if (neu === 'Lücken erkannt') t = 'Fehlende Angaben erkannt: ' + (d.fehlende || []).map(nice).join(', ');
		else if (neu === 'Freigabe ausstehend') t = 'Rückfrage entworfen, zur Freigabe an ' + ((d.freigeber || []).length || 1) + ' Freigeber geschickt (Runde ' + (d.runde || 1) + ')';
		else if (neu === 'Warten auf Kunde') t = 'Rückfrage' + (String(r.ausloeser).startsWith('Mitarbeiter:') ? ' von ' + name(r.ausloeser) + (d.bearbeitet ? ' bearbeitet und' : '') + ' freigegeben und gesendet' : ' gesendet');
		else if (neu === 'Bereit zur Bearbeitung') t = 'Alle Pflichtangaben vorhanden, bereit zur Bearbeitung';
		else if (neu === 'Eskaliert / Manuell') t = 'Zur manuellen Klärung übergeben';
		else if (neu === 'Abgeschlossen') t = 'Vorgang abgeschlossen';
		else t = 'Status: ' + (alt || '–') + ' → ' + neu;
		zeilen.push([r.createdAt, t]);
	}
	flush();
	const farbe = ein.neuer_status === 'Abgeschlossen' ? 'accent' : 'good';
	const daten = pj(v.extrahierte_daten);
	const felder = Object.keys(daten).filter((k) => daten[k] && daten[k].wert !== null && daten[k].wert !== undefined && daten[k].wert !== '');
	const first = audit.length ? audit[0].createdAt : v.createdAt;
	const last = audit.length ? audit[audit.length - 1].createdAt : v.updatedAt;
	const min = Math.max(0, Math.round((new Date(last) - new Date(first)) / 60000));
	const dauer = min < 60 ? min + ' Min.' : min < 2880 ? Math.round(min / 60) + ' Std.' : Math.round(min / 1440) + ' Tage';
	const tb = (text, extra) => Object.assign({ type: 'TextBlock', text, wrap: true, spacing: 'Small' }, extra || {});
	const body = [
		{ type: 'ColumnSet', columns: [
			{ type: 'Column', width: 'stretch', items: [tb('Vorgang ' + v.vorgangs_id, { weight: 'bolder', size: 'medium', spacing: 'None' })] },
			{ type: 'Column', width: 'auto', items: [tb(String(ein.neuer_status).toUpperCase(), { weight: 'bolder', size: 'small', color: farbe, spacing: 'None' })] },
		] },
		tb('**' + (v.absender_name || v.absender_adresse || 'Absender unbekannt') + '** · ' + (v.betreff || '(ohne Betreff)') + (v.vorgangstyp ? ' · ' + v.vorgangstyp : '')),
	];
	if (felder.length) {
		body.push({ type: 'Container', style: 'emphasis', spacing: 'Medium', items: [tb('ERFASSTE DATEN', { isSubtle: true, size: 'small', weight: 'bolder', spacing: 'None' })].concat(felder.slice(0, 14).map((k) => tb(nice(k) + ': **' + String(daten[k].wert).slice(0, 80) + '**'))) });
	}
	body.push(tb('ABLAUF', { isSubtle: true, size: 'small', weight: 'bolder', spacing: 'Medium' }));
	for (const [zeit, text] of zeilen.slice(0, 24)) {
		body.push({ type: 'ColumnSet', spacing: 'Small', columns: [
			{ type: 'Column', width: '90px', items: [tb(fmtZeit(zeit), { isSubtle: true, size: 'small', spacing: 'None' })] },
			{ type: 'Column', width: 'stretch', items: [tb(String(text).slice(0, 300), { spacing: 'None' })] },
		] });
	}
	body.push(tb('Dauer von Eingang bis ' + ein.neuer_status + ': ' + dauer + ' · Rückfrage-Runden: ' + (v.rundenzaehler || 0) + ' · protokolliert ' + fmtLang(new Date().toISOString()), { isSubtle: true, size: 'small', spacing: 'Medium' }));
	const karte = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body };
	const marker = Buffer.from(JSON.stringify(karte), 'utf8').toString('base64');
	const html = '<b>📋 Vorgang ' + v.vorgangs_id + ': ' + ein.neuer_status + '</b><br>' + zeilen.slice(0, 24).map((z) => fmtZeit(z[0]) + ' ' + z[1]).join('<br>') + '<!--EPA_KARTE:' + marker + '-->';
	return [{ json: { ok: true, html, team_id: ben.team_id, channel_id: channel, postfach: cfgRow.postfach || '', postfach_workflow_id: cfgRow.postfach_workflow_id || '', vorgangs_id: v.vorgangs_id } }];
} catch (err) {
	return leer('Fehler beim Bauen: ' + String(err && err.message).slice(0, 150));
}
