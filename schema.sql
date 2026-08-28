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

-- ===========================================================================
-- Phase 3 — Dispatch operations (loads, brokers, board)
-- ===========================================================================

-- Brokers BSG books freight with — a reference list loads point at.
CREATE TABLE IF NOT EXISTS brokers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  contact_name  TEXT,
  phone         TEXT,
  email         TEXT,
  mc_number     TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brokers_name ON brokers (name);

-- The central object: one booked load, tracked from booking to paid. broker_id
-- and carrier_id are SET NULL on delete so removing a broker/carrier never
-- destroys load history.
CREATE TABLE IF NOT EXISTS loads (
  id             BIGSERIAL PRIMARY KEY,
  ref            TEXT,                         -- load / reference number
  broker_id      INTEGER REFERENCES brokers(id) ON DELETE SET NULL,
  carrier_id     INTEGER REFERENCES carriers(id) ON DELETE SET NULL,
  origin         TEXT,
  destination    TEXT,
  pickup_date    DATE,
  delivery_date  DATE,
  commodity      TEXT,
  weight         TEXT,
  equipment      TEXT,
  rate           NUMERIC(10,2),
  status         TEXT NOT NULL DEFAULT 'booked'
                   CHECK (status IN ('available','booked','dispatched','in_transit','delivered','invoiced','paid','cancelled')),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loads_status ON loads (status);
CREATE INDEX IF NOT EXISTS idx_loads_carrier ON loads (carrier_id);
CREATE INDEX IF NOT EXISTS idx_loads_pickup ON loads (pickup_date);

-- ===========================================================================
-- Phase 3.1 — drivers, richer routes, load docs, accessorials, timeline
-- ===========================================================================

-- Drivers belong to a carrier (a small fleet has several). A load is assigned
-- one. ON DELETE CASCADE with the carrier; loads keep history via SET NULL.
CREATE TABLE IF NOT EXISTS drivers (
  id          SERIAL PRIMARY KEY,
  carrier_id  INTEGER NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  cdl_number  TEXT,
  cdl_state   TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drivers_carrier ON drivers (carrier_id);

-- Documents attached to a load (rate confirmation, BOL, POD). Stored as bytea
-- (ephemeral serverless FS). Carriers may download the rate con of their loads.
CREATE TABLE IF NOT EXISTS load_documents (
  id           BIGSERIAL PRIMARY KEY,
  load_id      BIGINT NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  doc_type     TEXT NOT NULL DEFAULT 'other' CHECK (doc_type IN ('rate_con','bol','pod','other')),
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  content      BYTEA NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loaddoc_load ON load_documents (load_id, doc_type);

-- Accessorial line items on a load. Carrier-owed = load.rate + SUM(amount).
CREATE TABLE IF NOT EXISTS load_accessorials (
  id          BIGSERIAL PRIMARY KEY,
  load_id     BIGINT NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('detention','layover','tonu','lumper','fuel','other')),
  amount      NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_acc_load ON load_accessorials (load_id);

-- Check-call / status timeline per load. status-changes are logged automatically;
-- staff add check calls and notes.
CREATE TABLE IF NOT EXISTS load_events (
  id           BIGSERIAL PRIMARY KEY,
  load_id      BIGINT NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
  staff_email  TEXT,
  kind         TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('status','check_call','note')),
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_load ON load_events (load_id, created_at DESC);

-- Columns added to the existing loads table (CREATE TABLE IF NOT EXISTS above is
-- a no-op once the table exists, so new fields must be ALTERed in idempotently).
ALTER TABLE loads ADD COLUMN IF NOT EXISTS driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS miles INTEGER;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_name TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_address TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_city TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_state TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_zip TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_appt TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_ref TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pickup_instructions TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delivery_name TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delivery_address TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delivery_city TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delivery_state TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delivery_zip TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delivery_appt TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delivery_ref TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delivery_instructions TEXT;

-- Sessions are held in signed cookies (cookie-session), so there is no session
-- table on Postgres — nothing to define here.
