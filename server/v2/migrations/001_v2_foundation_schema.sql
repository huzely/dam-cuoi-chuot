-- Đám Cưới Chuột V2 · Milestone M1.2 Database Foundation Schema
-- Migration 001: V2 Core Foundation Tables (Idempotency, Outbox, Config, Flags, Kill-Switches, Audit)
-- Execution: Run in PostgreSQL / Supabase SQL Editor or migration runner.
-- NOTE: This script is non-destructive. It coexists with legacy tables (dcc_saves, dcc_rank, etc.)

BEGIN;

--------------------------------------------------------------------------------
-- 1. DURABLE IDEMPOTENCY STORAGE
-- Uniqueness is scoped to (actor_id, key) to prevent cross-player conflicts.
-- Uses SHA-256 request_fingerprint for request payload verification.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_idempotency (
  actor_id TEXT NOT NULL,
  key TEXT NOT NULL,
  command_type TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  result JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  PRIMARY KEY (actor_id, key)
);

CREATE INDEX IF NOT EXISTS idx_v2_idempotency_lookup
  ON public.v2_idempotency (actor_id, key, status);

ALTER TABLE public.v2_idempotency ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- 2. TRANSACTIONAL OUTBOX STORAGE
-- Stores domain events persisted within the same atomic DB transaction.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_outbox (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  actor_id TEXT,
  schema_version TEXT NOT NULL DEFAULT '1.0.0',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMMITTED_IN_STORAGE',
  attempt_count INT NOT NULL DEFAULT 0,
  last_error TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Schema compatibility guard for existing v2_outbox tables created before updated_at was added
ALTER TABLE public.v2_outbox
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_v2_outbox_pending_pub
  ON public.v2_outbox (status, created_at)
  WHERE status IN ('COMMITTED_IN_STORAGE', 'PUBLICATION_FAILED_RETRYABLE');

ALTER TABLE public.v2_outbox ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- 3. CONFIGURATION & RULESET VERSION STORAGE
-- Stores versioned config snapshots. APPROVED versions are immutable.
-- TBD_FROM_DATA parameters must fail closed.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_config_rulesets (
  version TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'DRAFT', -- 'DRAFT' | 'APPROVED' | 'ARCHIVED'
  definitions JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.v2_config_rulesets ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- 4. FEATURE FLAGS STORAGE
-- All V2 feature flags default to false (disabled).
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_feature_flags (
  flag_key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.v2_feature_flags ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.v2_feature_flags TO anon, authenticated;

--------------------------------------------------------------------------------
-- 5. DURABLE KILL-SWITCHES STORAGE
-- Emergency controls for V2 capabilities.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_kill_switches (
  switch_key TEXT PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.v2_kill_switches ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- 6. ADMIN / QTV AUDIT LOG STORAGE
-- Append-only audit table. Direct client writes, UPDATE, and DELETE privileges
-- are explicitly revoked. Audit rows are inserted only via trusted server endpoints.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_admin_audit_logs (
  event_id TEXT PRIMARY KEY,
  admin_actor_id TEXT NOT NULL,
  admin_role TEXT NOT NULL,
  action TEXT NOT NULL,
  target_ref JSONB,
  reason TEXT,
  command_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.v2_admin_audit_logs ENABLE ROW LEVEL SECURITY;

-- Explicit privilege scoping: Revoke UPDATE, DELETE, and direct client INSERT on v2_admin_audit_logs
REVOKE UPDATE, DELETE, INSERT ON public.v2_admin_audit_logs FROM PUBLIC, anon, authenticated;

--------------------------------------------------------------------------------
-- Explicit privilege scoping for V2 tables (Does NOT alter legacy tables)
--------------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON public.v2_idempotency FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.v2_outbox FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.v2_config_rulesets FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.v2_feature_flags FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.v2_kill_switches FROM PUBLIC, anon, authenticated;

COMMIT;
