-- BSG Carriers API — database schema (PostgreSQL).
--
-- Runs against the cloud Postgres (Neon) the app connects to. Idempotent —
-- every object is IF NOT EXISTS, so it is safe to run on every deploy / boot.
-- Status/type fields use TEXT + CHECK rather than native enums so adding a value
-- later is a one-line change, not a migration.

-- Every contact / onboarding submission. Common fields are promoted to columns
-- for searching and CSV export; the full raw field set lives in `data` (JSONB)
-- so nothing a form sends is ever lost.
CREATE TABLE IF NOT EXISTS submissions (
  id            BIGSERIAL PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('contact','onboarding')),
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','archived')),
  full_name     TEXT,
  company       TEXT,
  email         TEXT,
  phone         TEXT,
  mc_number     TEXT,
  dot_number    TEXT,
  equipment     TEXT,
  message       TEXT,
  data          JSONB NOT NULL,
  source_page   TEXT,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_submissions_type_status ON submissions (type, status);
CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_email ON submissions (email);

-- Individual staff accounts for the admin dashboard.
CREATE TABLE IF NOT EXISTS staff_users (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login     TIMESTAMPTZ
);

-- Delivery audit for notifications, so a missing email/Slack is diagnosable.
CREATE TABLE IF NOT EXISTS notifications_log (
  id             BIGSERIAL PRIMARY KEY,
  submission_id  BIGINT,
  channel        TEXT NOT NULL CHECK (channel IN ('email','slack')),
  ok             BOOLEAN NOT NULL,
  detail         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_submission ON notifications_log (submission_id);

-- ===========================================================================
-- Phase 2 — Carrier onboarding portal
-- ===========================================================================

-- A carrier's own account for the portal (separate audience from staff_users).
CREATE TABLE IF NOT EXISTS carriers (
  id               SERIAL PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  company_name     TEXT NOT NULL,
  contact_name     TEXT,
  phone            TEXT,
  mc_number        TEXT,
  dot_number       TEXT,
  equipment        TEXT,
  num_trucks       TEXT,
  preferred_lanes  TEXT,
  current_location TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','under_review','needs_info','approved','rejected')),
  staff_notes      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_carriers_status ON carriers (status);

-- Uploaded onboarding documents, stored as bytea because the app's serverless
-- filesystem is ephemeral — the database is the durable store. Size is capped
-- in the app layer.
CREATE TABLE IF NOT EXISTS carrier_documents (
  id           BIGSERIAL PRIMARY KEY,
  carrier_id   INTEGER NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
  doc_type     TEXT NOT NULL DEFAULT 'other' CHECK (doc_type IN ('coi','authority','w9','other')),
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  content      BYTEA NOT NULL,
  review       TEXT NOT NULL DEFAULT 'pending' CHECK (review IN ('pending','accepted','rejected')),
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doc_carrier ON carrier_documents (carrier_id, doc_type);

-- Sessions are held in signed cookies (cookie-session), so there is no session
-- table on Postgres — nothing to define here.
