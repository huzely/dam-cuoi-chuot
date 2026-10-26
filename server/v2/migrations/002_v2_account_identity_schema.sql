-- Đám Cưới Chuột V2 · Milestone M2.1 Account / Auth Domain Foundation Schema
-- Migration 002: V2 Accounts & Provider Identities Storage
-- Execution: Run in PostgreSQL / Supabase SQL Editor or migration runner.
-- NOTE: This script is non-destructive and coexists with M1 tables and legacy tables.

BEGIN;

--------------------------------------------------------------------------------
-- 1. V2 ACCOUNTS STORAGE
-- Authoritative internal account store with immutable UUID user_id.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_accounts (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_v2_accounts_state CHECK (state IN ('ACTIVE', 'SUSPENDED', 'DISABLED'))
);

ALTER TABLE public.v2_accounts ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- 2. V2 PROVIDER IDENTITIES STORAGE
-- Maps external authentication providers (GOOGLE, FACEBOOK, THREADS) to V2 accounts.
-- Uniqueness is strictly enforced on (provider, provider_subject).
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_provider_identities (
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES public.v2_accounts(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, provider_subject),
  CONSTRAINT uq_v2_provider_identities UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_v2_provider_identities_user_id
  ON public.v2_provider_identities (user_id);

ALTER TABLE public.v2_provider_identities ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- Explicit privilege scoping for V2 Account & Identity tables
--------------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON public.v2_accounts FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.v2_provider_identities FROM PUBLIC, anon, authenticated;

COMMIT;
