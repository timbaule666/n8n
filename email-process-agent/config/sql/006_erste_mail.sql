-- Migration 006: Eingang und Outlook-Link der ersten Mail je Vorgang (Abschluss-Meldung mit Verlauf).
ALTER TABLE epa_vorgaenge ADD COLUMN IF NOT EXISTS erste_mail_am TIMESTAMPTZ;
ALTER TABLE epa_vorgaenge ADD COLUMN IF NOT EXISTS erste_mail_link TEXT;
