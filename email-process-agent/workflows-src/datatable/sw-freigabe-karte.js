'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const E = "$('Bei Aufruf').first().json";

module.exports = function () {
	const wf = new Workflow('EPA SW Freigabe-Karte');
	wf.notiz('Notiz Zweck', [-80, -360], [
		'## EPA SW Freigabe-Karte',
		'**Zweck:** Räumt die Freigabe-Karte im Teams-Kanal "Rückfragen" auf, sobald die Freigabe erledigt ist. **Verschickt:** Karte wird aus "Rückfragen" entfernt, die Meldung "✅ Rückfrage verschickt" kommt in "Systemmeldungen" (Anlass rueckfrage_verschickt; bei direkt in Outlook gesendet meldet SW Nachfassen selbst). **Sonst** wird die Karte an Ort und Stelle ersetzt: ❌ abgelehnt, ⚠️ Versand fehlgeschlagen, ↩️ nicht mehr nötig (Kunde hat geantwortet), ⏰ Link ersetzt (neuer Link), 📭 nicht zugestellt. Die neue Karte hat keinen Link mehr.',
		'**Trigger:** Aufruf durch EPA-07, EPA-03, SW Nachfassen und SW Freigabe senden.',
		'**Eingaben:** freigabe_id; zustand (optional, sonst Status der Freigabe; "erneuert" = neuer Link verschickt); teams_nachricht (optional, sonst Spalte teams_nachricht der Freigabe).',
		'**Ausgabe:** { geaendert, grund }. Wirft nie nach außen: ohne gespeicherte Teams-Nachricht (z. B. 1:1-Chat, Telegram) oder bei Fehlern bleibt die Karte, wie sie ist.',
	].join('\n'), { breite: 720, hoehe: 260 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['freigabe_id', 'string'],
		['zustand', 'string'],
		['teams_nachricht', 'string'],
	]);
	const opt = { alwaysOutputData: true, onError: 'continueRegularOutput' };
	const fg = wf.tabelle('Freigabe lesen', [224, 0], 'get', 'epa_freigaben', { bedingungen: [['freigabe_id', 'eq', `={{ ${E}.freigabe_id || '__keine__' }}`]] }, opt);
	const kunde = wf.tabelle('Kunde lesen', [448, 0], 'get', 'epa_config_allgemein', { bedingungen: [['kunde_id', 'eq', "={{ $json.kunde_id || '__kein_kunde__' }}"]] }, opt);
	const bauen = wf.code('Karte bauen', [672, 0], ['freigabe'], `
const e = ${E};
const f = $('Freigabe lesen').first().json || {};
const c = $input.first().json || {};
const nein = (grund) => [{ json: { weiter: false, grund } }];
if (!f.freigabe_id) return nein('Freigabe nicht gefunden');
const tn = freigabe.teamsNachrichtLesen(e.teams_nachricht || f.teams_nachricht);
if (!tn) return nein('keine Teams-Karte gespeichert');
const k = freigabe.karteZustand(f, { zustand: e.zustand || '', zeitzone: c.zeitzone || 'Europe/Berlin', jetzt: new Date().toISOString() });
if (!k) return nein('Zustand ' + (e.zustand || f.status) + ' ändert die Karte nicht');
if (!/^[A-Za-z0-9]{8,32}$/.test(String(c.postfach_workflow_id || ''))) return nein('postfach_workflow_id fehlt');
let kan = {}; let ben = {};
try { kan = JSON.parse(c.kanaele || '{}') || {}; } catch (err) { kan = {}; }
try { ben = JSON.parse(c.benachrichtigung || '{}') || {}; } catch (err) { ben = {}; }
// Verschickt: nur verschieben, wenn der Kanal "Systemmeldungen" eingerichtet ist; sonst Karte an Ort und Stelle ersetzen.
const verschieben = Boolean(k.verschieben && kan.system);
return [{ json: { weiter: true, verschieben, melden: f.entscheidung !== 'manuell_gesendet', postfach_workflow_id: c.postfach_workflow_id, postfach: c.postfach, kunde_id: f.kunde_id, vorgangs_id: f.vorgangs_id, html: k.html, team_id: tn.team_id, channel_id: tn.channel_id, nachricht_id: tn.id,
	b_team_id: ben.team_id || '', b_channel_id: ben.channel_id || '', b_kanal: ben.kanal || 'teams', b_chat_id: ben.chat_id || '', b_telegram_workflow_id: ben.telegram_workflow_id || '' } }];
`, opt);
	const frage = wf.node('Karte ändern?', 'n8n-nodes-base.if', [896, 0], {
		conditions: bedingungen([bedingung('={{ $json.weiter }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const B = "$('Karte bauen').first().json";
	const verschiebenFrage = wf.node('Verschickt?', 'n8n-nodes-base.if', [1008, -80], {
		conditions: bedingungen([bedingung('={{ $json.verschieben }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const meldenFrage = wf.node('Meldung posten?', 'n8n-nodes-base.if', [1232, -280], {
		conditions: bedingungen([bedingung(`={{ ${B}.melden }}`, { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const melden = wf.aufruf('Meldung in Systemmeldungen', [1456, -360], 'EPA SW Benachrichtigen', [
		['kunde_id', 'string', `={{ ${B}.kunde_id }}`],
		['vorgangs_id', 'string', `={{ ${B}.vorgangs_id }}`],
		['team_id', 'string', `={{ ${B}.b_team_id }}`],
		['channel_id', 'string', `={{ ${B}.b_channel_id }}`],
		['kanal', 'string', `={{ ${B}.b_kanal }}`],
		['chat_id', 'string', `={{ ${B}.b_chat_id }}`],
		['telegram_workflow_id', 'string', `={{ ${B}.b_telegram_workflow_id }}`],
		['nachricht_html', 'string', `={{ ${B}.html }}`],
		['anlass', 'string', 'rueckfrage_verschickt'],
	], opt);
	const entfernen = wf.aufrufDynamisch('Karte aus Rückfragen entfernen', [1680, -280], `={{ ${B}.postfach_workflow_id }}`, [
		['aktion', 'string', 'teams_kanal_loeschen'],
		['postfach', 'string', `={{ ${B}.postfach }}`],
		['graph_id', 'string', `={{ ${B}.nachricht_id }}`],
		['vorgangs_id', 'string', `={{ ${B}.vorgangs_id }}`],
		['team_id', 'string', `={{ ${B}.team_id }}`],
		['channel_id', 'string', `={{ ${B}.channel_id }}`],
	], opt);
	const okVerschoben = wf.code('Ergebnis (verschoben)', [1904, -280], [], `
const r = $input.first().json || {};
return [{ json: { geaendert: r.geloescht === true, verschoben: true, grund: r.geloescht === true ? '' : String(r.meldung || (r.error && (r.error.message || r.error)) || 'unbekannt').slice(0, 200) } }];
`);
	const aendern = wf.aufrufDynamisch('Karte in Teams ersetzen', [1232, 0], '={{ $json.postfach_workflow_id }}', [
		['aktion', 'string', 'teams_kanal_aendern'],
		['postfach', 'string', '={{ $json.postfach }}'],
		['graph_id', 'string', '={{ $json.nachricht_id }}'],
		['vorgangs_id', 'string', '={{ $json.vorgangs_id }}'],
		['html', 'string', '={{ $json.html }}'],
		['team_id', 'string', '={{ $json.team_id }}'],
		['channel_id', 'string', '={{ $json.channel_id }}'],
	], opt);
	const ok = wf.code('Ergebnis', [1456, 0], [], `
const r = $input.first().json || {};
return [{ json: { geaendert: r.geaendert === true, grund: r.geaendert === true ? '' : String(r.meldung || (r.error && (r.error.message || r.error)) || 'unbekannt').slice(0, 200) } }];
`);
	const nicht = wf.code('Nichts zu tun', [1120, 200], [], `
return [{ json: { geaendert: false, grund: $input.first().json.grund || '' } }];
`);

	wf.kette(trigger, fg, kunde, bauen, frage);
	wf.verbinde(frage, verschiebenFrage, 0);
	wf.verbinde(verschiebenFrage, meldenFrage, 0);
	wf.verbinde(verschiebenFrage, aendern, 1);
	wf.verbinde(meldenFrage, melden, 0);
	wf.verbinde(meldenFrage, entfernen, 1);
	wf.kette(melden, entfernen, okVerschoben);
	wf.verbinde(frage, nicht, 1);
	wf.kette(aendern, ok);
	return wf;
};
