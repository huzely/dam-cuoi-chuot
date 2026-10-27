-- Đám Cưới Chuột V2 · Milestone M3 Wallet V2, Ledger & Holds Schema
-- Migration 004: V2 Economy Storage (Wallets, Ledger Entries, Holds)
-- Execution: Run in PostgreSQL / Supabase SQL Editor or migration runner.
-- NOTE: This script is non-destructive and coexists with M1, M2.1, M2.2 tables and legacy tables.

BEGIN;

--------------------------------------------------------------------------------
-- 1. V2 WALLETS STORAGE
-- Authoritative monetary storage per user_id in integer đồng.
-- Optimistic concurrency protection via version column.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_wallets (
  user_id UUID PRIMARY KEY REFERENCES public.v2_accounts(user_id) ON DELETE CASCADE,
  available_balance BIGINT NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
  locked_balance BIGINT NOT NULL DEFAULT 0 CHECK (locked_balance >= 0),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.v2_wallets ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- 2. V2 LEDGER ENTRIES STORAGE
-- Append-only double-entry audit log for all authoritative value mutations.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_ledger_entries (
  entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES public.v2_accounts(user_id),
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('FAUCET', 'SINK', 'TRANSFER', 'SPECIAL')),
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  reference_id TEXT,
  counterparty UUID REFERENCES public.v2_accounts(user_id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  idempotency_key TEXT,
  config_version TEXT
);

CREATE INDEX IF NOT EXISTS idx_v2_ledger_entries_user_id ON public.v2_ledger_entries (user_id);
CREATE INDEX IF NOT EXISTS idx_v2_ledger_entries_transaction_id ON public.v2_ledger_entries (transaction_id);
CREATE INDEX IF NOT EXISTS idx_v2_ledger_entries_created_at ON public.v2_ledger_entries (created_at);

-- DB-Level Uniqueness / Idempotency Strategy for ledger mutations
CREATE UNIQUE INDEX IF NOT EXISTS uq_v2_ledger_entries_user_idempotency
  ON public.v2_ledger_entries (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.v2_ledger_entries ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- 3. V2 HOLDS STORAGE
-- Holds/Escrow lifecycle state (CREATED -> ACTIVE -> RELEASED or CAPTURED).
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_holds (
  hold_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.v2_accounts(user_id),
  amount BIGINT NOT NULL CHECK (amount > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('CARD_MATCH', 'EMPLOYMENT_WAGE', 'THEFT_ESCROW', 'COURT_ESCROW')),
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'ACTIVE', 'RELEASED', 'CAPTURED')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v2_holds_user_id ON public.v2_holds (user_id);
CREATE INDEX IF NOT EXISTS idx_v2_holds_status ON public.v2_holds (status);

ALTER TABLE public.v2_holds ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- Portable Privilege Scoping for V2 Economy Tables
-- Always revokes direct writes from PUBLIC across all PostgreSQL platforms (Neon, AWS RDS, Supabase).
-- Conditionally revokes for Supabase roles (anon, authenticated) if they exist.
--------------------------------------------------------------------------------
DO $$
BEGIN
  -- Standard ANSI/PostgreSQL privilege revokes (PUBLIC is built-in on all database engines)
  REVOKE INSERT, UPDATE, DELETE ON public.v2_wallets FROM PUBLIC;
  REVOKE INSERT, UPDATE, DELETE ON public.v2_ledger_entries FROM PUBLIC;
  REVOKE INSERT, UPDATE, DELETE ON public.v2_holds FROM PUBLIC;

  -- Supabase-specific role 'anon' if present
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_wallets FROM anon';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_ledger_entries FROM anon';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_holds FROM anon';
  END IF;

  -- Supabase-specific role 'authenticated' if present
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_wallets FROM authenticated';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_ledger_entries FROM authenticated';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_holds FROM authenticated';
  END IF;

END $$;

COMMIT;
