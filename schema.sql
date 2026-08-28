-- BSG Carriers API — database schema.
--
-- Run once against the fresh MySQL database (cPanel > phpMyAdmin > the API DB >
-- SQL tab > paste > Go). Safe to re-run: every statement is IF NOT EXISTS.
--
-- utf8mb4 throughout so names, notes and the odd emoji survive intact.

-- Every contact / onboarding submission. Common fields are promoted to columns
-- for searching and CSV export; the complete raw field set is kept in `data`
-- so nothing a form sends is ever lost, even fields added later.
CREATE TABLE IF NOT EXISTS submissions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type          ENUM('contact','onboarding') NOT NULL,
  status        ENUM('new','read','archived') NOT NULL DEFAULT 'new',
  full_name     VARCHAR(160)  NULL,
  company       VARCHAR(200)  NULL,
  email         VARCHAR(200)  NULL,
  phone         VARCHAR(60)   NULL,
  mc_number     VARCHAR(40)   NULL,
  dot_number    VARCHAR(40)   NULL,
  equipment     VARCHAR(80)   NULL,
  message       TEXT          NULL,
  data          JSON          NOT NULL,
  source_page   VARCHAR(255)  NULL,
  ip            VARCHAR(45)   NULL,
  user_agent    VARCHAR(400)  NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_type_status (type, status),
  KEY idx_created (created_at),
  KEY idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Individual staff accounts for the admin dashboard. First account is seeded
-- with scripts/create-admin.mjs; admins can add the rest from the UI.
CREATE TABLE IF NOT EXISTS staff_users (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email          VARCHAR(200) NOT NULL,
  name           VARCHAR(160) NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  role           ENUM('admin','staff') NOT NULL DEFAULT 'staff',
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login     DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Delivery audit for notifications, so a missing email/Slack is diagnosable
-- without guessing. One row per attempt per channel.
CREATE TABLE IF NOT EXISTS notifications_log (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  submission_id  BIGINT UNSIGNED NULL,
  channel        ENUM('email','slack') NOT NULL,
  ok             TINYINT(1)   NOT NULL,
  detail         VARCHAR(500) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_submission (submission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Session store table. Defined here (matching express-mysql-session's exact
-- schema) rather than left to the library, because the library creates it once
-- at startup and does NOT retry — on a cold DB that one attempt can fail,
-- leaving no sessions table and breaking login. Folding it into this
-- retry-protected schema guarantees it exists. The app sets
-- createDatabaseTable:false so the library trusts this table.
CREATE TABLE IF NOT EXISTS sessions (
  session_id  VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  expires     INT(11) UNSIGNED NOT NULL,
  data        MEDIUMTEXT COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB;
