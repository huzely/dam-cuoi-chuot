import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = path.resolve(__dirname, '../migrations/001_v2_foundation_schema.sql');

test('Schema Migration Static Verification: 001_v2_foundation_schema.sql format & integrity', () => {
  assert.ok(fs.existsSync(migrationPath), 'Migration file 001_v2_foundation_schema.sql must exist');

  const sqlContent = fs.readFileSync(migrationPath, 'utf8');

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

  // Verify audit log immutability (REVOKE UPDATE, DELETE)
  assert.ok(
    sqlContent.includes('REVOKE UPDATE, DELETE ON public.v2_admin_audit_logs'),
    'Audit logs must revoke UPDATE and DELETE permissions'
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
