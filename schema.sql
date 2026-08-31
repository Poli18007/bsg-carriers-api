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

-- ===========================================================================
-- Phase A — editable boards & columns, load labels (KanbanFlow-style)
-- ===========================================================================

-- A board is a kanban surface. One per kind for now (a Loads board and a
-- Trailers board), but the model allows more.
CREATE TABLE IF NOT EXISTS boards (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('loads','trailers')),
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind)
);

-- Editable columns on a board (workflow stages, yards, regional runs). Users
-- create/rename/reorder/recolor/delete these. `category` lets reporting and the
-- carrier portal reason about a column ('delivered', 'active', …) without
-- hard-coding names.
CREATE TABLE IF NOT EXISTS board_columns (
  id         SERIAL PRIMARY KEY,
  board_id   INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  color      TEXT,
  category   TEXT NOT NULL DEFAULT 'other'
               CHECK (category IN ('active','in_transit','delivered','done','yard','other')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (board_id, name)
);
CREATE INDEX IF NOT EXISTS idx_bcol_board ON board_columns (board_id, sort);

-- Colored load-type labels (KLF Truck, Owner Op, Exemplis OB, …). Editable.
CREATE TABLE IF NOT EXISTS labels (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT,
  sort  INTEGER NOT NULL DEFAULT 0
);

-- Loads gain a board column (their live position/state) and a label. Added via
-- ALTER because the loads table already exists in production.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS column_id INTEGER REFERENCES board_columns(id) ON DELETE SET NULL;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS label_id INTEGER REFERENCES labels(id) ON DELETE SET NULL;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS customer TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS pu_number TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS dispatcher_id INTEGER REFERENCES staff_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_loads_column ON loads (column_id);

-- ===========================================================================
-- Phase C/D — customers, trucks, trailers (fleet + shipper records)
-- ===========================================================================

-- Customers / shippers BSG dispatches freight for. Loads carried a free-text
-- `customer`; this promotes it to a reusable record while keeping the text
-- column as a fallback for one-off shippers.
CREATE TABLE IF NOT EXISTS customers (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  contact_name TEXT,
  phone        TEXT,
  email        TEXT,
  address      TEXT,
  city         TEXT,
  state        TEXT,
  zip          TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers (name);

-- Trucks are first-class on the Loads board's roster column. A truck ties to a
-- carrier + driver and carries a column_id so it can sit on the board like its
-- KanbanFlow "Trucks" column. Deleting a column/carrier/driver only nulls the
-- link (SET NULL) — a truck record is never destroyed by that.
CREATE TABLE IF NOT EXISTS trucks (
  id          SERIAL PRIMARY KEY,
  number      TEXT NOT NULL,
  carrier_id  INTEGER REFERENCES carriers(id) ON DELETE SET NULL,
  driver_id   INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  plate       TEXT,
  vin         TEXT,
  make_model  TEXT,
  in_service  BOOLEAN NOT NULL DEFAULT true,
  notes       TEXT,
  column_id   INTEGER REFERENCES board_columns(id) ON DELETE SET NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trucks_carrier ON trucks (carrier_id);
CREATE INDEX IF NOT EXISTS idx_trucks_column ON trucks (column_id);

-- Trailers are tracked units on the Trailers board. `state` colours the card
-- (empty / loaded / damaged / maintenance); `column_id` is the yard/run it sits
-- in. Like trucks, links SET NULL rather than cascade.
CREATE TABLE IF NOT EXISTS trailers (
  id          SERIAL PRIMARY KEY,
  number      TEXT NOT NULL,
  alt_number  TEXT,
  type        TEXT,
  state       TEXT NOT NULL DEFAULT 'empty'
                CHECK (state IN ('empty','loaded','damaged','maintenance')),
  carrier_id  INTEGER REFERENCES carriers(id) ON DELETE SET NULL,
  notes       TEXT,
  column_id   INTEGER REFERENCES board_columns(id) ON DELETE SET NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trailers_column ON trailers (column_id);

-- Loads gain a customer record link plus the assigned truck and trailer. Added
-- via ALTER because the loads table already exists in production.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS truck_id INTEGER REFERENCES trucks(id) ON DELETE SET NULL;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS trailer_id INTEGER REFERENCES trailers(id) ON DELETE SET NULL;

-- ===========================================================================
-- Trips — a truck/driver's route covering one or more loads
-- ===========================================================================

-- A trip groups the loads a truck runs as one route. Its waypoints and delivery
-- timeline are derived from the pickups/deliveries of its loads (ordered by
-- loads.stop_seq), so a trip is a planning + tracking layer over loads, not a
-- second copy of the route data.
CREATE TABLE IF NOT EXISTS trips (
  id          SERIAL PRIMARY KEY,
  seq         INTEGER NOT NULL,
  name        TEXT,
  truck_id    INTEGER REFERENCES trucks(id) ON DELETE SET NULL,
  driver_id   INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  carrier_id  INTEGER REFERENCES carriers(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','dispatched','in_transit','completed','cancelled')),
  start_date  DATE,
  end_date    DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips (status);

-- A load can belong to a trip; stop_seq orders it within the trip's route.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS stop_seq INTEGER;
CREATE INDEX IF NOT EXISTS idx_loads_trip ON loads (trip_id, stop_seq);

-- ===========================================================================
-- Billing — dispatch-fee invoices (a dispatcher's revenue)
-- ===========================================================================

-- A default dispatch fee (% of linehaul) per carrier, so generating an invoice
-- from their loads can pre-fill the fee. 0 = ask each time.
ALTER TABLE carriers ADD COLUMN IF NOT EXISTS dispatch_fee_pct NUMERIC(5,2) NOT NULL DEFAULT 0;

-- One invoice BSG issues to a carrier for dispatching services. The line items
-- carry the money; status + payments track collection. `seq` gives a stable,
-- human invoice number independent of the internal id.
CREATE TABLE IF NOT EXISTS invoices (
  id          SERIAL PRIMARY KEY,
  seq         INTEGER NOT NULL,
  carrier_id  INTEGER REFERENCES carriers(id) ON DELETE SET NULL,
  bill_to     TEXT,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','void')),
  issue_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date    DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoices_carrier ON invoices (carrier_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);

-- A line on an invoice. Usually one per load (dispatch fee = pct × linehaul),
-- but a manual line (flat fee, adjustment) has no load_id.
CREATE TABLE IF NOT EXISTS invoice_lines (
  id           BIGSERIAL PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  load_id      BIGINT REFERENCES loads(id) ON DELETE SET NULL,
  description  TEXT NOT NULL,
  amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invlines_invoice ON invoice_lines (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invlines_load ON invoice_lines (load_id);

-- Payments recorded against an invoice (supports partial payments). Balance =
-- SUM(lines) − SUM(payments).
CREATE TABLE IF NOT EXISTS invoice_payments (
  id           BIGSERIAL PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount       NUMERIC(10,2) NOT NULL DEFAULT 0,
  method       TEXT,
  paid_at      DATE NOT NULL DEFAULT CURRENT_DATE,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invpay_invoice ON invoice_payments (invoice_id);

-- ===========================================================================
-- DVIR — driver vehicle inspection reports (pre-trip / post-trip)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS dvir_reports (
  id            SERIAL PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'pre_trip' CHECK (kind IN ('pre_trip','post_trip')),
  truck_id      INTEGER REFERENCES trucks(id) ON DELETE SET NULL,
  trailer_id    INTEGER REFERENCES trailers(id) ON DELETE SET NULL,
  driver_id     INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  trip_id       INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  odometer      INTEGER,
  location      TEXT,
  defect_items  TEXT,                                  -- list of components with defects
  remarks       TEXT,
  satisfactory  BOOLEAN NOT NULL DEFAULT true,          -- vehicle condition satisfactory to operate
  status        TEXT NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('draft','submitted','reviewed','cleared')),
  inspected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dvir_truck ON dvir_reports (truck_id, inspected_at DESC);
CREATE INDEX IF NOT EXISTS idx_dvir_kind ON dvir_reports (kind, status);

-- ===========================================================================
-- Expenses — company / load / trip costs
-- ===========================================================================
CREATE TABLE IF NOT EXISTS expenses (
  id            SERIAL PRIMARY KEY,
  category      TEXT NOT NULL DEFAULT 'other'
                  CHECK (category IN ('fuel','tolls','repair','insurance','permit','lumper','office','misc','other')),
  amount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  description   TEXT,
  expense_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  load_id       BIGINT REFERENCES loads(id) ON DELETE SET NULL,
  trip_id       INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  truck_id      INTEGER REFERENCES trucks(id) ON DELETE SET NULL,
  carrier_id    INTEGER REFERENCES carriers(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_cat ON expenses (category);

-- ===========================================================================
-- Maintenance — service / repair records for trucks & trailers
-- ===========================================================================
CREATE TABLE IF NOT EXISTS maintenance_records (
  id            SERIAL PRIMARY KEY,
  truck_id      INTEGER REFERENCES trucks(id) ON DELETE SET NULL,
  trailer_id    INTEGER REFERENCES trailers(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL DEFAULT 'service'
                  CHECK (kind IN ('service','repair','inspection','tire','other')),
  description   TEXT,
  vendor        TEXT,
  cost          NUMERIC(10,2),
  odometer      INTEGER,
  service_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  next_due_date DATE,
  status        TEXT NOT NULL DEFAULT 'completed'
                  CHECK (status IN ('scheduled','in_progress','completed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_maint_truck ON maintenance_records (truck_id, service_date DESC);

-- Load deletion requests: a non-admin can flag a load for deletion (with a
-- reason); an admin reviews and either deletes it or dismisses the request.
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delete_requested_by  TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delete_reason        TEXT;
ALTER TABLE loads ADD COLUMN IF NOT EXISTS delete_requested_at  TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_loads_delreq ON loads (delete_requested_at) WHERE delete_requested_by IS NOT NULL;

-- Role-based access: widen the staff role set beyond admin/staff. Done as a
-- drop+add so it re-applies cleanly on every migrate. 'staff' is kept as a
-- legacy alias (treated as manager by the permission layer).
ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check;
ALTER TABLE staff_users ADD CONSTRAINT staff_users_role_check
  CHECK (role IN ('admin','manager','dispatcher','billing','viewer','staff'));

-- Sessions are held in signed cookies (cookie-session), so there is no session
-- table on Postgres — nothing to define here.
