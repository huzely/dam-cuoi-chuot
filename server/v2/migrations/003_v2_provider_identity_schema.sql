-- Đám Cưới Chuột V2 · Milestone M2.2 Provider Linking Schema
-- Migration 003: V2 Provider Identities Mapping
-- Execution: Run in PostgreSQL / Supabase SQL Editor or migration runner.
-- NOTE: This script is non-destructive and coexists with M1 and M2.1 tables.

BEGIN;

--------------------------------------------------------------------------------
-- 1. V2 PROVIDER IDENTITIES MAPPING
-- Maps external OAuth/federated identity (provider, provider_subject) to v2_accounts(user_id).
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_provider_identities (
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES public.v2_accounts(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_v2_provider_identities_provider_subject UNIQUE (provider, provider_subject)
);

CREATE INDEX IF NOT EXISTS idx_v2_provider_identities_user_id ON public.v2_provider_identities (user_id);

ALTER TABLE public.v2_provider_identities ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- Portable Privilege Scoping for V2 Provider Identities Table
-- Always revokes direct writes from PUBLIC across all PostgreSQL platforms (Neon, AWS RDS, Supabase).
-- Conditionally revokes for Supabase roles (anon, authenticated) if they exist.
--------------------------------------------------------------------------------
DO $$
BEGIN
  -- Standard ANSI/PostgreSQL privilege revokes (PUBLIC is built-in on all database engines)
  REVOKE INSERT, UPDATE, DELETE ON public.v2_provider_identities FROM PUBLIC;

  -- Supabase-specific role 'anon' if present
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_provider_identities FROM anon';
  END IF;

  -- Supabase-specific role 'authenticated' if present
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_provider_identities FROM authenticated';
  END IF;

END $$;

COMMIT;
