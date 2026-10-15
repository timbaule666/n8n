-- Migration für bestehende Postgres-Installationen (neue Installationen: in 001_schema.sql enthalten).
-- Antwort in der Sprache der Kundenmail: erkannte Sprache je Vorgang und optionale Übersetzungen je Kunde.
ALTER TABLE epa_vorgaenge ADD COLUMN IF NOT EXISTS sprache TEXT;
ALTER TABLE epa_config_allgemein ADD COLUMN IF NOT EXISTS uebersetzungen JSONB NOT NULL DEFAULT '{}';
