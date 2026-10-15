-- Migration 005: Kunden-Regeln aus Google Sheets (EPA-09).
-- config_sheet: ID des Google Sheets (leer = keine Anbindung). Nur die Data-Table-Variante gleicht ab.
ALTER TABLE epa_config_allgemein ADD COLUMN IF NOT EXISTS config_sheet TEXT NOT NULL DEFAULT '';
