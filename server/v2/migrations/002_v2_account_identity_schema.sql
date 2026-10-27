-- Đám Cưới Chuột V2 · Milestone M2.1 Account Domain Foundation Schema
-- Migration 002: V2 Accounts Storage
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
-- Portable Privilege Scoping for V2 Account Table
-- Always revokes direct writes from PUBLIC across all PostgreSQL platforms (Neon, AWS RDS, Supabase).
-- Conditionally revokes for Supabase roles (anon, authenticated) if they exist.
--------------------------------------------------------------------------------
DO $$
BEGIN
  -- Standard ANSI/PostgreSQL privilege revokes (PUBLIC is built-in on all database engines)
  REVOKE INSERT, UPDATE, DELETE ON public.v2_accounts FROM PUBLIC;

  -- Supabase-specific role 'anon' if present
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_accounts FROM anon';
  END IF;

  -- Supabase-specific role 'authenticated' if present
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_accounts FROM authenticated';
  END IF;

END $$;

COMMIT;
