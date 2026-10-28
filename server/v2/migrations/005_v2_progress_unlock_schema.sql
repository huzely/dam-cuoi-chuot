-- Đám Cưới Chuột V2 · Milestone M4 Progress / Unlock Compatibility Schema
-- Migration 005: V2 Chapter Progress and Unlock Storage
-- Execution: Run in PostgreSQL / Supabase SQL Editor or migration runner.
-- NOTE: This script is non-destructive and coexists with M1–M3 tables and legacy tables.

BEGIN;

--------------------------------------------------------------------------------
-- 1. V2 CHAPTER PROGRESS STORAGE
-- Primary key (user_id, chapter_id) for authoritative server-side progress tracking.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.v2_chapter_progress (
  user_id UUID NOT NULL REFERENCES public.v2_accounts(user_id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, chapter_id)
);

CREATE INDEX IF NOT EXISTS idx_v2_chapter_progress_user_id ON public.v2_chapter_progress (user_id);
CREATE INDEX IF NOT EXISTS idx_v2_chapter_progress_chapter_completed ON public.v2_chapter_progress (chapter_id, completed);

ALTER TABLE public.v2_chapter_progress ENABLE ROW LEVEL SECURITY;

--------------------------------------------------------------------------------
-- Portable Privilege Scoping for V2 Progress Tables
-- Always revokes direct writes from PUBLIC across all PostgreSQL platforms (Neon, AWS RDS, Supabase).
-- Conditionally revokes for Supabase roles (anon, authenticated) if they exist.
--------------------------------------------------------------------------------
DO $$
BEGIN
  -- Standard ANSI/PostgreSQL privilege revokes (PUBLIC is built-in on all database engines)
  REVOKE INSERT, UPDATE, DELETE ON public.v2_chapter_progress FROM PUBLIC;

  -- Supabase-specific role 'anon' if present
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_chapter_progress FROM anon';
  END IF;

  -- Supabase-specific role 'authenticated' if present
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.v2_chapter_progress FROM authenticated';
  END IF;

END $$;

COMMIT;
