// Abschlusskarte in "Logs" erst, wenn der Vorgang abgeschlossen ist (z. B. per Knopf "Erledigt" auf der Karte in
// "Vollständige Anfragen", EPA-16). "Bereit zur Bearbeitung" steht als Karte in "Vollständige Anfragen".
const e = $input.first().json;
const weiter = e.neuer_status === 'Abgeschlossen' && Boolean(e.vorgangs_id) && Boolean(e.kunde_id);
return [{ json: { weiter, kunde_id: e.kunde_id || '', vorgangs_id: e.vorgangs_id || '', neuer_status: e.neuer_status || '' } }];
