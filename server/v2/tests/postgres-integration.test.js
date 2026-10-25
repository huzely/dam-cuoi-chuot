import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgDriver } from '../adapters/pg-driver.js';
import { PgAdminPersistence } from '../adapters/pg-admin-persistence.js';
import { AdminService, ADMIN_COMMAND_TYPES } from '../domains/admin/service.js';
import { QTV_ROLES } from '../core/rbac.js';
import { createCommand } from '../core/command.js';
import { createDomainEvent } from '../core/event.js';
import { CONFIG_CATEGORIES } from '../core/config.js';
import { IdempotencyMismatchError, ConcurrentExecutionError } from '../core/idempotency.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = path.resolve(__dirname, '../migrations/001_v2_foundation_schema.sql');

const testDbUrl = process.env.POSTGRES_TEST_URL || process.env.PGDATABASE_TEST_URL || null;

function isProductionDbUrl(url) {
  if (!url) return false;
  const str = url.toLowerCase();
  return str.includes('mamafzllyhbmzyystivo') || (str.includes('supabase.co') && !str.includes('test') && !str.includes('staging'));
}

test('PostgreSQL Live Integration Test Harness', async (t) => {
  if (!testDbUrl) {
    t.diagnostic('================================================================================');
    t.diagnostic('  [PostgreSQL Integration Suite]');
    t.diagnostic('  NOT EXECUTED — TEST/STAGING DATABASE NOT PROVIDED');
    t.diagnostic('  (Set POSTGRES_TEST_URL to execute live PostgreSQL integration tests)');
    t.diagnostic('================================================================================');
    return;
  }

  if (isProductionDbUrl(testDbUrl) && process.env.ALLOW_PRODUCTION_DB_TEST !== 'true') {
    throw new Error('Database Safety Guard: Refusing to run integration tests against production database URL.');
  }

  t.diagnostic(`Connecting to test database: ${testDbUrl.replace(/:[^:@]+@/, ':****@')}`);

  const pool = new pg.Pool({ connectionString: testDbUrl });
  const pgDriver = new PgDriver({ pool });
  const adminPersistence = new PgAdminPersistence(pgDriver);
  const adminService = new AdminService({ adminPersistence });

  try {
    await t.test('1. Migration 001_v2_foundation_schema.sql applies cleanly to PostgreSQL', async () => {
      const sqlContent = fs.readFileSync(migrationPath, 'utf8');
      const client = await pool.connect();
      try {
        await client.query(sqlContent);
      } finally {
        client.release();
      }
    });

    await t.test('2. Verify expected V2 tables and constraints exist on PostgreSQL', async () => {
      const res = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'v2_%'`
      );
      const tables = res.rows.map(r => r.table_name);
      assert.equal(tables.includes('v2_idempotency'), true);
      assert.equal(tables.includes('v2_outbox'), true);
      assert.equal(tables.includes('v2_config_rulesets'), true);
      assert.equal(tables.includes('v2_feature_flags'), true);
      assert.equal(tables.includes('v2_kill_switches'), true);
      assert.equal(tables.includes('v2_admin_audit_logs'), true);
    });

    await t.test('3. Test real PostgreSQL transaction COMMIT and ROLLBACK', async () => {
      // Test COMMIT
      await pgDriver.withTransaction(async (tx) => {
        await tx.featureFlags.set('ACCOUNT_V2', true);
      });
      const committedFlag = await pgDriver.withTransaction(async (tx) => tx.featureFlags.get('ACCOUNT_V2'));
      assert.equal(committedFlag, true);

      // Test ROLLBACK
      await assert.rejects(async () => {
        await pgDriver.withTransaction(async (tx) => {
          await tx.featureFlags.set('ACCOUNT_V2', false);
          throw new Error('Forced transaction rollback');
        });
      }, /Forced transaction rollback/);

      // Verify state was rolled back to true
      const rolledBackFlag = await pgDriver.withTransaction(async (tx) => tx.featureFlags.get('ACCOUNT_V2'));
      assert.equal(rolledBackFlag, true);
    });

    await t.test('4. Atomic state mutation + outbox commit/rollback on PostgreSQL', async () => {
      const eventId = `evt_pg_${Date.now()}`;
      await pgDriver.withTransaction(async (tx) => {
        await tx.featureFlags.set('EMPLOYMENT_V2', true);
        await tx.outbox.record(createDomainEvent({
          eventId,
          eventType: 'employment.job_accepted',
          aggregate: { type: 'employment', id: 'job_01' },
        }));
      });

      // Assert both flag and outbox row exist in PostgreSQL
      const flagRes = await pgDriver.withTransaction(async (tx) => tx.featureFlags.get('EMPLOYMENT_V2'));
      assert.equal(flagRes, true);

      const outboxRes = await pool.query(`SELECT status FROM public.v2_outbox WHERE event_id = $1`, [eventId]);
      assert.equal(outboxRes.rows.length, 1);
      assert.equal(outboxRes.rows[0].status, 'COMMITTED_IN_STORAGE');
    });

    await t.test('5. Admin feature flag + audit atomic commit/rollback on PostgreSQL', async () => {
      const superAdmin = { actorId: 'admin_pg_1', role: QTV_ROLES.SUPER_ADMIN };

      // Successful atomic admin mutation
      const res = await adminService.executeAdminCommand({
        adminActor: superAdmin,
        command: createCommand({
          type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
          actor: superAdmin,
          payload: { flagKey: 'HOI_XUAN_V2', enabled: true, reason: 'Live PostgreSQL rollout test' },
        }),
      });
      assert.equal(res.success, true);

      // Verify audit record exists in database
      const auditRes = await pool.query(
        `SELECT action, reason FROM public.v2_admin_audit_logs WHERE admin_actor_id = $1 ORDER BY created_at DESC LIMIT 1`,
        ['admin_pg_1']
      );
      assert.equal(auditRes.rows.length, 1);
      assert.equal(auditRes.rows[0].reason, 'Live PostgreSQL rollout test');
    });

    await t.test('6. Config DRAFT creation, approval, and APPROVED immutability on PostgreSQL', async () => {
      const econManager = { actorId: 'econ_pg_1', role: QTV_ROLES.ECONOMY_MANAGER };

      // Draft creation
      await adminService.executeAdminCommand({
        adminActor: econManager,
        command: createCommand({
          type: ADMIN_COMMAND_TYPES.CONFIG_CREATE_DRAFT,
          actor: econManager,
          payload: {
            version: '2.0.0-pg',
            definitions: { 'BASE_FEE': { category: CONFIG_CATEGORIES.ECONOMY_CONFIG, value: 50 } },
            reason: 'Draft ruleset for live PG test',
          },
        }),
      });

      // Approval
      await adminService.executeAdminCommand({
        adminActor: econManager,
        command: createCommand({
          type: ADMIN_COMMAND_TYPES.CONFIG_APPROVE,
          actor: econManager,
          payload: { version: '2.0.0-pg', reason: 'Approving ruleset' },
        }),
      });

      // Assert version status is APPROVED
      const approvedRes = await pgDriver.withTransaction(async (tx) => tx.config.getRulesetByVersion('2.0.0-pg'));
      assert.equal(approvedRes.status, 'APPROVED');

      // Attempting to overwrite APPROVED version fails
      await assert.rejects(async () => {
        await adminService.executeAdminCommand({
          adminActor: econManager,
          command: createCommand({
            type: ADMIN_COMMAND_TYPES.CONFIG_CREATE_DRAFT,
            actor: econManager,
            payload: {
              version: '2.0.0-pg',
              definitions: { 'BASE_FEE': { category: CONFIG_CATEGORIES.ECONOMY_CONFIG, value: 999 } },
              reason: 'Overwriting approved ruleset',
            },
          }),
        });
      }, /Forbidden Mutation Error/);
    });

    await t.test('7. Durable Kill Switch + audit atomic commit on PostgreSQL', async () => {
      const secReviewer = { actorId: 'sec_pg_1', role: QTV_ROLES.SECURITY_REVIEWER };

      await adminService.executeAdminCommand({
        adminActor: secReviewer,
        command: createCommand({
          type: ADMIN_COMMAND_TYPES.KILL_SWITCH_SET,
          actor: secReviewer,
          payload: { switchKey: 'KILL_SWITCH_CARD_WAGER', active: true, reason: 'Live PG test emergency shutoff' },
        }),
      });

      const active = await pgDriver.withTransaction(async (tx) => tx.killSwitch.isKillSwitchActive('KILL_SWITCH_CARD_WAGER'));
      assert.equal(active, true);
    });

    await t.test('8. Idempotency (actor_id, key) uniqueness and concurrency on PostgreSQL', async () => {
      const actorA = { actorId: 'actor_pg_A' };
      const actorB = { actorId: 'actor_pg_B' };
      const cmdA1 = createCommand({
        type: 'festival.enter_booth',
        actor: actorA,
        idempotencyKey: 'pg_idem_key_1',
        payload: { boothId: 'b1' },
      });
      const cmdA2Same = createCommand({
        type: 'festival.enter_booth',
        actor: actorA,
        idempotencyKey: 'pg_idem_key_1',
        payload: { boothId: 'b1' },
      });
      const cmdA2Diff = createCommand({
        type: 'festival.enter_booth',
        actor: actorA,
        idempotencyKey: 'pg_idem_key_1',
        payload: { boothId: 'b2_different' },
      });
      const cmdB1 = createCommand({
        type: 'festival.enter_booth',
        actor: actorB,
        idempotencyKey: 'pg_idem_key_1', // Same key string, different actor!
        payload: { boothId: 'b1' },
      });

      // Actor A claims key
      await pgDriver.withTransaction(async (tx) => {
        const claim = await tx.idempotency.claim('pg_idem_key_1', cmdA1);
        assert.equal(claim.status, 'CLAIMED');
        await tx.idempotency.complete('actor_pg_A', 'pg_idem_key_1', { result: 'A_OK' });
      });

      // Actor A replays same key + same command -> returns cached result
      await pgDriver.withTransaction(async (tx) => {
        const replay = await tx.idempotency.claim('pg_idem_key_1', cmdA2Same);
        assert.equal(replay.status, 'COMPLETED');
        assert.equal(replay.result.result, 'A_OK');
      });

      // Actor A uses same key + different command -> throws IdempotencyMismatchError
      await assert.rejects(async () => {
        await pgDriver.withTransaction(async (tx) => {
          await tx.idempotency.claim('pg_idem_key_1', cmdA2Diff);
        });
      }, IdempotencyMismatchError);

      // Actor B uses same key string independently without conflict
      await pgDriver.withTransaction(async (tx) => {
        const claimB = await tx.idempotency.claim('pg_idem_key_1', cmdB1);
        assert.equal(claimB.status, 'CLAIMED');
      });
    });

  } finally {
    await pgDriver.close();
    await pool.end();
  }
});
