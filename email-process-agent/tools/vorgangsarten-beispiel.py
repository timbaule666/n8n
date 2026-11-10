#!/usr/bin/env python3
"""Fügt der Beispiel-Config die Vorgangsarten Bestellung, Terminanfrage und Reklamation hinzu (idempotent).
Aufruf: python3 tools/vorgangsarten-beispiel.py"""
import json, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

VORGANGSARTEN = {
    "transport": {"name": "Angebotsanfrage", "beschreibung": "Kunde möchte einen Preis oder ein Angebot für einen Transport (Abholung, Ziel, Ware, Termin)."},
    "bestellung": {"name": "Bestellung", "beschreibung": "Kunde bestellt oder beauftragt verbindlich Ware oder eine Leistung, z. B. mit Menge, Liefertermin, Lieferadresse oder Bestellnummer."},
    "termin": {"name": "Terminanfrage", "beschreibung": "Kunde möchte einen Termin vereinbaren, verschieben oder anfragen, z. B. Besichtigung, Beratung, Anlieferung oder Abholung zu einer bestimmten Zeit."},
    "reklamation": {"name": "Reklamation", "beschreibung": "Kunde bemängelt eine bereits erhaltene Lieferung oder Leistung: Ware beschädigt, defekt, falsch, unvollständig oder verspätet. Keine Stornierung und keine neue Bestellung."},
}

def feld(typ, name, anzeige, ftyp, pflicht, regel, baustein, hinweis, nr, gruppe="", kurz=""):
    return {"vorgangstyp": typ, "feldname": name, "anzeigename": anzeige, "typ": ftyp, "pflicht": pflicht,
            "validierungsregel": json.dumps(regel, ensure_ascii=False), "resolution_textbaustein": baustein,
            "extraktions_hinweis": hinweis, "platzhalter_muster": "[]", "reihenfolge": nr, "aktiv": True,
            "gruppe": gruppe, "kurzname": kurz}

KONTAKT = lambda typ: [
    feld(typ, "Ansprechpartner", "Ansprechpartner", "text", True, {"min_laenge": 2, "max_laenge": 80, "person": True},
         "Bitte nennen Sie uns einen Ansprechpartner für Rückfragen.",
         "Vor- und Nachname einer Person beim Kunden, ohne Anrede (Herr/Frau). Keine Firmen-, Abteilungs- oder Teamnamen; leer lassen, wenn keine Person genannt ist", 90, "Kontakt", "Ansprechpartner"),
    feld(typ, "Telefon", "Telefonnummer", "telefon", True, {"min_ziffern": 6, "max_ziffern": 20},
         "Bitte geben Sie uns eine Telefonnummer für Rückfragen an.", "Telefonnummer der Kontaktperson", 100, "Kontakt", "Telefonnummer"),
]

FELDER = [
    feld("bestellung", "Bestellgegenstand", "Bestellte Ware / Leistung", "text", True, {"min_laenge": 2, "max_laenge": 200},
         "Bitte nennen Sie uns, welche Ware oder Leistung Sie bestellen möchten.",
         "Was bestellt wird: Artikelbezeichnung, Artikelnummer oder Leistung, kurz zusammengefasst", 10, "Bestellung", "Ware / Leistung"),
    feld("bestellung", "Menge", "Menge", "text", True, {"min_laenge": 1, "max_laenge": 80},
         "Bitte teilen Sie uns die gewünschte Menge mit.", "Bestellte Menge mit Einheit, wie geschrieben (z. B. 20 Kartons, 3 Paletten, 500 Stück)", 20, "Bestellung", "Menge"),
    feld("bestellung", "Bestellnummer", "Ihre Bestellnummer", "text", False, {"min_laenge": 1, "max_laenge": 60},
         "Bitte nennen Sie uns Ihre Bestellnummer, falls vorhanden.", "Bestell- oder Auftragsnummer des Kunden, nur wenn ausdrücklich genannt", 30, "Bestellung", "Bestellnummer"),
    feld("bestellung", "Liefertermin", "Gewünschter Liefertermin", "datum", True, {"min_tage_ab_heute": 0, "max_tage_ab_heute": 365},
         "Bitte teilen Sie uns den gewünschten Liefertermin mit.", "Gewünschter Liefertermin als JJJJ-MM-TT, nur wenn ein konkretes Datum genannt ist", 40),
    feld("bestellung", "Liefer_PLZ", "PLZ Lieferadresse", "plz", True, {"regex": "^\\d{5}$"},
         "Bitte nennen Sie uns die Postleitzahl der Lieferadresse.", "Postleitzahl der Lieferadresse", 50, "Lieferadresse", "PLZ"),
    feld("bestellung", "Liefer_Ort", "Lieferort", "text", True, {"min_laenge": 2, "max_laenge": 80},
         "Bitte nennen Sie uns den Ort der Lieferadresse.", "Ortsname der Lieferadresse", 60, "Lieferadresse", "Stadt"),
    *KONTAKT("bestellung"),
    feld("termin", "Terminanlass", "Anlass des Termins", "text", True, {"min_laenge": 2, "max_laenge": 200},
         "Bitte teilen Sie uns mit, worum es bei dem Termin gehen soll.", "Anlass oder Thema des Termins, z. B. Besichtigung, Beratung, Anlieferung", 10, "Termin", "Anlass"),
    feld("termin", "Wunschtermin", "Wunschtermin", "datum", True, {"min_tage_ab_heute": 0, "max_tage_ab_heute": 365},
         "Bitte nennen Sie uns Ihren Wunschtermin.", "Gewünschtes Datum als JJJJ-MM-TT, nur wenn ein konkretes Datum genannt ist; bei mehreren Wunschterminen der erste", 20, "Termin", "Datum"),
    feld("termin", "Uhrzeit", "Uhrzeit", "text", False, {"min_laenge": 1, "max_laenge": 40},
         "Bitte nennen Sie uns eine passende Uhrzeit.", "Gewünschte Uhrzeit oder Zeitraum, wie geschrieben (z. B. 10 Uhr, vormittags)", 30, "Termin", "Uhrzeit"),
    feld("termin", "Terminort", "Ort des Termins", "text", False, {"min_laenge": 2, "max_laenge": 120},
         "Bitte nennen Sie uns den Ort des Termins.", "Ort oder Adresse des Termins, nur wenn ausdrücklich genannt", 40, "Termin", "Ort"),
    *KONTAKT("termin"),
    feld("reklamation", "Reklamationsgrund", "Was ist das Problem?", "text", True, {"min_laenge": 3, "max_laenge": 300},
         "Bitte beschreiben Sie kurz, was genau nicht in Ordnung ist (z. B. beschädigt, falsche Ware, fehlende Menge, verspätet).",
         "Kurze sachliche Beschreibung des Problems in den Worten des Kunden (beschädigt, defekt, falsch, fehlt, verspätet …), ohne Forderungen", 10, "Reklamation", "Problem"),
    feld("reklamation", "Betroffene_Ware", "Betroffene Ware / Leistung", "text", True, {"min_laenge": 2, "max_laenge": 200},
         "Bitte nennen Sie uns die betroffene Ware oder Leistung und die Menge.",
         "Welche Ware oder Leistung betroffen ist, mit Menge, wie geschrieben (z. B. 3 Kartons Etiketten)", 20, "Reklamation", "Ware / Menge"),
    feld("reklamation", "Lieferdatum", "Datum der Lieferung / Leistung", "datum", True, {"min_tage_ab_heute": -365, "max_tage_ab_heute": 0},
         "Bitte teilen Sie uns mit, wann die Lieferung bzw. Leistung erfolgt ist.",
         "Datum der bemängelten Lieferung oder Leistung als JJJJ-MM-TT, nur wenn ein konkretes Datum genannt ist; fehlt das Jahr, das zurückliegende Datum. Nicht der Liefer- oder Wunschtermin einer neuen Bestellung in derselben Mail", 30, "Reklamation", "Lieferdatum"),
    feld("reklamation", "Referenznummer", "Lieferschein- / Bestellnummer", "text", False, {"min_laenge": 1, "max_laenge": 60},
         "Bitte nennen Sie uns, falls vorhanden, die Lieferschein-, Bestell- oder Auftragsnummer.",
         "Lieferschein-, Bestell-, Auftrags- oder Rechnungsnummer, nur wenn ausdrücklich genannt", 40, "Reklamation", "Nummer"),
    *KONTAKT("reklamation"),
]

EN = {
    "Bestellgegenstand": "Please let us know which goods or services you would like to order.",
    "Menge": "Please let us know the quantity you need.",
    "Bestellnummer": "Please let us know your order number, if available.",
    "Liefertermin": "Please let us know the requested delivery date.",
    "Liefer_PLZ": "Please let us know the postcode of the delivery address.",
    "Liefer_Ort": "Please let us know the town/city of the delivery address.",
    "Terminanlass": "Please let us know what the appointment is about.",
    "Wunschtermin": "Please let us know your preferred date.",
    "Uhrzeit": "Please let us know a suitable time.",
    "Terminort": "Please let us know where the appointment should take place.",
    "Reklamationsgrund": "Please briefly describe what exactly is wrong (e.g. damaged, wrong goods, missing quantity, late).",
    "Betroffene_Ware": "Please let us know which goods or services are affected and the quantity.",
    "Lieferdatum": "Please let us know when the delivery or service took place.",
    "Referenznummer": "Please let us know the delivery note, order or job number, if available.",
}

def main():
    pfad = os.path.join(ROOT, "config", "datatables", "beispiel-transport.json")
    d = json.load(open(pfad, encoding="utf-8"))
    a = d["epa_config_allgemein"][0]
    a["vorgangsarten"] = json.dumps(VORGANGSARTEN, ensure_ascii=False)
    pv = json.loads(a["prompt_versionen"]); pv["klassifizierung"] = "v4"; a["prompt_versionen"] = json.dumps(pv)
    ue = json.loads(a["uebersetzungen"]) if a.get("uebersetzungen") else {}
    for sp in ue.values(): sp["textbausteine"].update(EN)
    a["uebersetzungen"] = json.dumps(ue, ensure_ascii=False)
    kunde = a["kunde_id"]
    vorhanden = {(r["vorgangstyp"], r["feldname"]) for r in d["epa_config_pflichtfelder"]}
    for f in FELDER:
        if (f["vorgangstyp"], f["feldname"]) not in vorhanden:
            d["epa_config_pflichtfelder"].append({"kunde_id": kunde, **f})
    json.dump(d, open(pfad, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    p2 = os.path.join(ROOT, "config", "datatables", "vorlage-leer.json")
    v = json.load(open(p2, encoding="utf-8"))
    v["epa_config_allgemein"][0].setdefault("vorgangsarten", "")
    json.dump(v, open(p2, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

if __name__ == "__main__":
    main()
