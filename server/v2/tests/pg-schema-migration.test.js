import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migration001Path = path.resolve(__dirname, '../migrations/001_v2_foundation_schema.sql');
const migration002Path = path.resolve(__dirname, '../migrations/002_v2_account_identity_schema.sql');

test('Schema Migration Static Verification: 001_v2_foundation_schema.sql format & integrity', () => {
  assert.ok(fs.existsSync(migration001Path), 'Migration file 001_v2_foundation_schema.sql must exist');

  const sqlContent = fs.readFileSync(migration001Path, 'utf8');

  // Verify V2 tables are declared
  assert.ok(sqlContent.includes('v2_idempotency'), 'v2_idempotency table must be declared');
  assert.ok(sqlContent.includes('v2_outbox'), 'v2_outbox table must be declared');
  assert.ok(sqlContent.includes('v2_config_rulesets'), 'v2_config_rulesets table must be declared');
  assert.ok(sqlContent.includes('v2_feature_flags'), 'v2_feature_flags table must be declared');
  assert.ok(sqlContent.includes('v2_admin_audit_logs'), 'v2_admin_audit_logs table must be declared');

  // Verify idempotency uniqueness scope is (actor_id, key)
  assert.ok(
    sqlContent.includes('PRIMARY KEY (actor_id, key)'),
    'v2_idempotency must declare composite PRIMARY KEY (actor_id, key)'
  );

  // Verify audit log immutability (REVOKE UPDATE, DELETE, INSERT)
  assert.ok(
    sqlContent.includes('REVOKE UPDATE, DELETE, INSERT ON public.v2_admin_audit_logs'),
    'Audit logs must revoke UPDATE, DELETE, and direct INSERT permissions'
  );

  // BLOCKER 1 REGRESSION CHECK: Verify NO schema-wide REVOKE ON ALL TABLES statements exist
  assert.equal(
    sqlContent.includes('ON ALL TABLES IN SCHEMA'),
    false,
    'Migration must NOT contain schema-wide REVOKE/GRANT statements on ALL TABLES IN SCHEMA public'
  );

  // BLOCKER 2 REGRESSION CHECK: Assert NO generic arbitrary table-mutation RPC exists
  assert.equal(
    sqlContent.includes('v2_execute_atomic_unit_of_work'),
    false,
    'Migration must NOT define a generic arbitrary table-mutation RPC'
  );

  // Verify non-destructive guarantee: NO DROP or ALTER on legacy tables
  const legacyTables = ['dcc_saves', 'dcc_rank', 'dcc_rank_review', 'dcc_ho_so'];
  for (const legacyTable of legacyTables) {
    assert.equal(
      sqlContent.includes(`DROP TABLE ${legacyTable}`) || sqlContent.includes(`DROP TABLE public.${legacyTable}`),
      false,
      `Migration must not drop legacy table ${legacyTable}`
    );
    assert.equal(
      sqlContent.includes(`ALTER TABLE ${legacyTable}`) || sqlContent.includes(`ALTER TABLE public.${legacyTable}`),
      false,
      `Migration must not alter legacy table ${legacyTable}`
    );
  }
});

test('Schema Migration Static Verification: 002_v2_account_identity_schema.sql format & integrity', () => {
  assert.ok(fs.existsSync(migration002Path), 'Migration file 002_v2_account_identity_schema.sql must exist');

  const sqlContent = fs.readFileSync(migration002Path, 'utf8');

  // Verify Account table is declared
  assert.ok(sqlContent.includes('v2_accounts'), 'v2_accounts table must be declared');

  // Verify UUID primary key
  assert.ok(
    sqlContent.includes('user_id UUID PRIMARY KEY DEFAULT gen_random_uuid()'),
    'v2_accounts must declare UUID primary key default gen_random_uuid()'
  );

  // Verify RLS is enabled
  assert.ok(
    sqlContent.includes('ALTER TABLE public.v2_accounts ENABLE ROW LEVEL SECURITY;'),
    'v2_accounts must enable RLS'
  );

  // Verify privilege scoping (REVOKE direct client writes)
  assert.ok(
    sqlContent.includes('REVOKE INSERT, UPDATE, DELETE ON public.v2_accounts'),
    'v2_accounts must revoke direct client writes'
  );

  // Verify non-destructive guarantee: NO DROP or ALTER on legacy tables
  const legacyTables = ['dcc_saves', 'dcc_rank', 'dcc_rank_review', 'dcc_ho_so'];
  for (const legacyTable of legacyTables) {
    assert.equal(
      sqlContent.includes(`DROP TABLE ${legacyTable}`) || sqlContent.includes(`DROP TABLE public.${legacyTable}`),
      false,
      `Migration 002 must not drop legacy table ${legacyTable}`
    );
    assert.equal(
      sqlContent.includes(`ALTER TABLE ${legacyTable}`) || sqlContent.includes(`ALTER TABLE public.${legacyTable}`),
      false,
      `Migration 002 must not alter legacy table ${legacyTable}`
    );
  }
});
