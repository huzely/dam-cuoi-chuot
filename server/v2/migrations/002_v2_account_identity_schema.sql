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
-- Authoritative uniqueness constraint is strictly uq_v2_provider_identities_provider_subject.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_provider_identities (
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES public.v2_accounts(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safely reconcile existing constraints without data loss if migration 002 ran previously on TEST/STAGING
ALTER TABLE public.v2_provider_identities
  DROP CONSTRAINT IF EXISTS uq_v2_provider_identities,
  DROP CONSTRAINT IF EXISTS v2_provider_identities_pkey;

-- Add authoritative single named constraint uq_v2_provider_identities_provider_subject
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_v2_provider_identities_provider_subject'
  ) THEN
    ALTER TABLE public.v2_provider_identities
      ADD CONSTRAINT uq_v2_provider_identities_provider_subject
      UNIQUE (provider, provider_subject);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_v2_provider_identities_user_id
  ON public.v2_provider_identities (user_id);

ALTER TABLE public.v2_provider_identities ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- Portable Privilege Scoping for V2 Account & Identity Tables
-- Always revokes direct writes from PUBLIC across all PostgreSQL platforms (Neon, AWS RDS, Supabase).
-- Conditionally revokes for Supabase roles (anon, authenticated) if they exist.
--------------------------------------------------------------------------------
DO $$
BEGIN
  -- Standard ANSI/PostgreSQL privilege revokes (PUBLIC is built-in on all database engines)
  REVOKE INSERT, UPDATE, DELETE ON public.v2_accounts FROM PUBLIC;
  REVOKE INSERT, UPDATE, DELETE ON public.v2_provider_identities FROM PUBLIC;

  -- Supabase-specific role 'anon' if present
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_accounts FROM anon';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_provider_identities FROM anon';
  END IF;

  -- Supabase-specific role 'authenticated' if present
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_accounts FROM authenticated';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_provider_identities FROM authenticated';
  END IF;
END $$;

COMMIT;
