'use strict';
const { Workflow, bedingung, bedingungen } = require('../../tools/lib/n8n');

const E = "$('Bei Aufruf').first().json";
const P = "$('Plan').first().json";

module.exports = function () {
	const wf = new Workflow('EPA SW Freigabe-Karte');
	wf.notiz('Notiz Zweck', [-80, -460], [
		'## EPA SW Freigabe-Karte',
		'**Zweck:** Hält die Karten einer Freigabe in Teams aktuell, damit jeder Kanal nur zeigt, was dort hingehört.',
		'- **Verschickt:** Karte verschwindet aus "2 Rückfragen" und kommt als "⏳ Wartet auf Antwort des Kunden" in "3 Warten auf Kunde" (Anlass rueckfrage_verschickt). Ältere Warten-Karten desselben Vorgangs (z. B. vor einer Erinnerung) und doppelte oder alte Freigabe-Karten dieses Vorgangs in "Rückfragen" werden entfernt. Zusätzlich kommt eine Kurzmeldung "✅ Rückfrage verschickt" (Absender, Betreff, Vorgang, gefragt, wer, wann, Frist) in "Systemmeldungen".',
		'- **Karte steht in "Warten" und der Kunde hat geantwortet** (zustand "beantwortet"), die Mail kam nicht an oder der Kunde reagiert nicht: Karte wird entfernt; die eigentliche Meldung kommt wie gewohnt in den passenden Kanal.',
		'- **Sonst** (abgelehnt, nicht mehr nötig, Link ersetzt, Versand fehlgeschlagen): Karte wird an Ort und Stelle ersetzt.',
		'**Trigger:** Aufruf durch EPA-07, EPA-03, EPA-01, SW Nachfassen und SW Freigabe senden.',
		'**Eingaben:** freigabe_id; zustand (optional, sonst Status der Freigabe; "erneuert", "beantwortet", "keine_reaktion"); teams_nachricht (optional, sonst Spalte teams_nachricht).',
		'**Ausgabe:** { geaendert, aktion, grund }. Wirft nie nach außen: ohne gespeicherte Karte (1:1-Chat, Telegram) oder bei Fehlern bleibt alles, wie es ist.',
	].join('\n'), { breite: 760, hoehe: 340 });

	const trigger = wf.trigger('Bei Aufruf', [0, 0], [
		['freigabe_id', 'string'],
		['zustand', 'string'],
		['teams_nachricht', 'string'],
	]);
	const opt = { alwaysOutputData: true, onError: 'continueRegularOutput' };
	const fg = wf.tabelle('Freigabe lesen', [224, 0], 'get', 'epa_freigaben', { bedingungen: [['freigabe_id', 'eq', `={{ ${E}.freigabe_id || '__keine__' }}`]] }, opt);
	const kunde = wf.tabelle('Kunde lesen', [448, 0], 'get', 'epa_config_allgemein', { bedingungen: [['kunde_id', 'eq', "={{ $('Freigabe lesen').first().json.kunde_id || '__kein_kunde__' }}"]] }, opt);
	const vorgang = wf.tabelle('Vorgang lesen', [672, 0], 'get', 'epa_vorgaenge', { bedingungen: [['vorgangs_id', 'eq', "={{ $('Freigabe lesen').first().json.vorgangs_id || '__kein_vorgang__' }}"]] }, opt);
	const andere = wf.tabelle('Freigaben des Vorgangs lesen', [896, 0], 'get', 'epa_freigaben', { bedingungen: [['vorgangs_id', 'eq', "={{ $('Freigabe lesen').first().json.vorgangs_id || '__kein_vorgang__' }}"]], alle: true }, opt);
	const plan = wf.code('Plan', [1120, 0], ['freigabe', 'kanaele'], `
const e = ${E};
const f = $('Freigabe lesen').first().json || {};
const c = $('Kunde lesen').first().json || {};
const v = $('Vorgang lesen').first().json || {};
const andere = $input.all().map((i) => i.json).filter((x) => x && x.freigabe_id);
let ben = {};
try { ben = JSON.parse(c.benachrichtigung || '{}') || {}; } catch (err) { ben = {}; }
const kan = kanaele.lesen(c.kanaele);
// Kanal "Warten auf Kunde" nur, wenn er eingerichtet ist (kanalId fällt sonst auf den Systemkanal zurück).
const warten = kan.warten ? kanaele.kanalId(kan, 'rueckfrage_verschickt') : '';
const p = freigabe.kartenPlan({ fg: f, andere, zustand: e.zustand || '', wartenKanal: warten, teamsNachricht: e.teams_nachricht || '', zeitzone: c.zeitzone || 'Europe/Berlin', jetzt: new Date().toISOString(), frist: v.antwort_frist || null });
const okId = /^[A-Za-z0-9]{8,32}$/.test(String(c.postfach_workflow_id || ''));
if (p.aktion !== 'nichts' && !okId) return [{ json: { aktion: 'nichts', grund: 'postfach_workflow_id fehlt' } }];
const ort = p.karte_ort || {};
// Verschickt: zusätzlich Kurzmeldung (Absender, wichtigste Daten) in "Systemmeldungen".
const kurz = p.aktion === 'verschieben' && kan.system ? freigabe.meldungVerschickt(f, v, { zeitzone: c.zeitzone || 'Europe/Berlin', jetzt: new Date().toISOString(), frist: v.antwort_frist || null }).html : '';
return [{ json: { ...p, kurz_html: kurz, system_channel_id: kurz ? kan.system : '', postfach_workflow_id: c.postfach_workflow_id || '', postfach: c.postfach || '', freigabe_id: f.freigabe_id || '', vorgangs_id: f.vorgangs_id || '', team_id: ort.team_id || ben.team_id || '', channel_id: ort.channel_id || '', nachricht_id: ort.id || '' } }];
`, opt);
	const weiche = wf.node('Aktion', 'n8n-nodes-base.switch', [1344, 0], {
		mode: 'rules',
		rules: {
			values: ['verschieben', 'entfernen', 'aendern'].map((a) => ({
				conditions: bedingungen([bedingung('={{ $json.aktion }}', { type: 'string', operation: 'equals' }, a)]),
				renameOutput: true,
				outputKey: a,
			})),
		},
		options: { fallbackOutput: 'extra' },
	});
	const postfach = "={{ $('Plan').first().json.postfach_workflow_id }}";

	// ---------------------------------------------------------------- Verschieben: neue Karte in "Warten auf Kunde"
	const posten = wf.aufrufDynamisch('Karte in Warten posten', [1568, -300], postfach, [
		['aktion', 'string', 'teams_kanal'],
		['postfach', 'string', `={{ ${P}.postfach }}`],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['html', 'string', `={{ ${P}.html }}`],
		['team_id', 'string', `={{ ${P}.team_id }}`],
		['channel_id', 'string', `={{ ${P}.ziel_channel_id }}`],
	], opt);
	const gepostet = wf.code('Neue Karte (Daten)', [1792, -300], ['freigabe'], `
const r = $input.first().json || {};
const neu = r.gesendet === true ? freigabe.teamsNachrichtLesen({ team_id: r.team_id, channel_id: r.channel_id, id: r.nachricht_id }) : null;
return [{ json: { ok: Boolean(neu), teams_nachricht: neu ? JSON.stringify(neu) : '', grund: neu ? '' : String(r.meldung || (r.error && (r.error.message || r.error)) || 'Karte nicht gepostet').slice(0, 200) } }];
`, opt);
	const gepostetFrage = wf.node('Gepostet?', 'n8n-nodes-base.if', [2016, -300], {
		conditions: bedingungen([bedingung('={{ $json.ok }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const merkDaten = wf.code('Teams-Nachricht (Daten)', [2240, -380], [], `
return [{ json: { teams_nachricht: $('Neue Karte (Daten)').first().json.teams_nachricht } }];
`);
	const merken = wf.tabelle('Neue Karte merken', [2464, -380], 'update', 'epa_freigaben', { bedingungen: [['freigabe_id', 'eq', `={{ ${P}.freigabe_id }}`]] }, opt);
	// Kanal "Rückfragen" lesen: doppelte oder alte Freigabe-Karten desselben Vorgangs mit entfernen.
	const kanalLesen = wf.aufrufDynamisch('Rückfragen-Kanal lesen', [2576, -460], postfach, [
		['aktion', 'string', 'teams_kanal_lesen'],
		['postfach', 'string', `={{ ${P}.postfach }}`],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['team_id', 'string', `={{ ${P}.team_id }}`],
		['channel_id', 'string', `={{ ${P}.channel_id }}`],
	], opt);
	const liste = wf.code('Zu entfernende Karten', [2688, -300], ['freigabe'], `
const p = ${P};
const r = $('Rückfragen-Kanal lesen').isExecuted ? ($('Rückfragen-Kanal lesen').first().json || {}) : {};
const bekannt = (p.entfernen || []).map((t) => t && t.id).filter(Boolean);
const extra = freigabe.weitereKarten(r.nachrichten || [], p.vorgangs_id, bekannt).map((id) => ({ team_id: p.team_id, channel_id: p.channel_id, id }));
const l = (p.entfernen || []).concat(extra).filter((t) => t && t.id);
if (!l.length) return [{ json: { leer: true } }];
return l.map((t) => ({ json: { team_id: t.team_id, channel_id: t.channel_id, nachricht_id: t.id } }));
`);
	const entfernen = wf.aufrufDynamisch('Karten entfernen', [2912, -300], postfach, [
		['aktion', 'string', 'teams_kanal_loeschen'],
		['postfach', 'string', `={{ ${P}.postfach }}`],
		['graph_id', 'string', '={{ $json.nachricht_id }}'],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['team_id', 'string', '={{ $json.team_id }}'],
		['channel_id', 'string', '={{ $json.channel_id }}'],
	], opt, 'each');
	const kurzFrage = wf.node('Systemmeldung?', 'n8n-nodes-base.if', [3136, -300], {
		conditions: bedingungen([bedingung(`={{ Boolean(${P}.kurz_html) }}`, { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const kurz = wf.aufrufDynamisch('Systemmeldung posten', [3360, -380], postfach, [
		['aktion', 'string', 'teams_kanal'],
		['postfach', 'string', `={{ ${P}.postfach }}`],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['html', 'string', `={{ ${P}.kurz_html }}`],
		['team_id', 'string', `={{ ${P}.team_id }}`],
		['channel_id', 'string', `={{ ${P}.system_channel_id }}`],
	], opt);
	const ergV = wf.code('Ergebnis (verschoben)', [3584, -300], [], `
const n = $('Karten entfernen').all().filter((i) => i.json && i.json.geloescht === true).length;
return [{ json: { geaendert: $('Neue Karte (Daten)').first().json.ok === true, aktion: 'verschieben', entfernt: n, grund: $('Neue Karte (Daten)').first().json.grund || '' } }];
`);
	const ergNichtGepostet = wf.code('Ergebnis (nicht gepostet)', [2240, -200], [], `
return [{ json: { geaendert: false, aktion: 'verschieben', grund: $('Neue Karte (Daten)').first().json.grund } }];
`);

	// ---------------------------------------------------------------- Entfernen: Karte in "Warten" ist erledigt
	const wegListe = wf.code('Warten-Karte (Daten)', [1568, -60], [], `
const p = ${P};
return [{ json: { team_id: p.team_id, channel_id: p.channel_id, nachricht_id: p.nachricht_id } }];
`);
	const weg = wf.aufrufDynamisch('Warten-Karte entfernen', [1792, -60], postfach, [
		['aktion', 'string', 'teams_kanal_loeschen'],
		['postfach', 'string', `={{ ${P}.postfach }}`],
		['graph_id', 'string', '={{ $json.nachricht_id }}'],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['team_id', 'string', '={{ $json.team_id }}'],
		['channel_id', 'string', '={{ $json.channel_id }}'],
	], opt);
	const ergW = wf.code('Ergebnis (entfernt)', [2016, -60], [], `
const r = $input.first().json || {};
return [{ json: { geaendert: r.geloescht === true, aktion: 'entfernen', grund: r.geloescht === true ? '' : String(r.meldung || (r.error && (r.error.message || r.error)) || 'unbekannt').slice(0, 200) } }];
`);

	// ---------------------------------------------------------------- Ändern: Karte an Ort und Stelle ersetzen
	const aendern = wf.aufrufDynamisch('Karte in Teams ersetzen', [1568, 180], postfach, [
		['aktion', 'string', 'teams_kanal_aendern'],
		['postfach', 'string', `={{ ${P}.postfach }}`],
		['graph_id', 'string', `={{ ${P}.nachricht_id }}`],
		['vorgangs_id', 'string', `={{ ${P}.vorgangs_id }}`],
		['html', 'string', `={{ ${P}.html }}`],
		['team_id', 'string', `={{ ${P}.team_id }}`],
		['channel_id', 'string', `={{ ${P}.channel_id }}`],
	], opt);
	const ok = wf.code('Ergebnis', [1792, 180], [], `
const r = $input.first().json || {};
return [{ json: { geaendert: r.geaendert === true, aktion: 'aendern', grund: r.geaendert === true ? '' : String(r.meldung || (r.error && (r.error.message || r.error)) || 'unbekannt').slice(0, 200) } }];
`);
	const nicht = wf.code('Nichts zu tun', [1568, 400], [], `
return [{ json: { geaendert: false, aktion: 'nichts', grund: $('Plan').first().json.grund || '' } }];
`);

	wf.kette(trigger, fg, kunde, vorgang, andere, plan, weiche);
	wf.verbinde(weiche, posten, 0);
	wf.verbinde(weiche, wegListe, 1);
	wf.verbinde(weiche, aendern, 2);
	wf.verbinde(weiche, nicht, 3);
	wf.kette(posten, gepostet, gepostetFrage);
	wf.verbinde(gepostetFrage, merkDaten, 0);
	wf.verbinde(gepostetFrage, ergNichtGepostet, 1);
	wf.kette(merkDaten, merken, kanalLesen, liste, entfernen, kurzFrage);
	wf.verbinde(kurzFrage, kurz, 0);
	wf.verbinde(kurzFrage, ergV, 1);
	wf.kette(kurz, ergV);
	wf.kette(wegListe, weg, ergW);
	wf.kette(aendern, ok);
	return wf;
};
