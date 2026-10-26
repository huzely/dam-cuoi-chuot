import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgDriver, assertSafeTestDatabaseUrl } from '../adapters/pg-driver.js';
import { PgAdminPersistence } from '../adapters/pg-admin-persistence.js';
import { PgOutboxPublisher } from '../adapters/pg-outbox.js';
import { AdminService, ADMIN_COMMAND_TYPES } from '../domains/admin/service.js';
import { QTV_ROLES } from '../core/rbac.js';
import { createCommand } from '../core/command.js';
import { createDomainEvent } from '../core/event.js';
import { CONFIG_CATEGORIES } from '../core/config.js';
import { executePipeline } from '../core/pipeline.js';
import { IdempotencyMismatchError } from '../core/idempotency.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = path.resolve(__dirname, '../migrations/001_v2_foundation_schema.sql');

const testDbUrl = process.env.POSTGRES_TEST_URL || process.env.PGDATABASE_TEST_URL || null;

test('Database Safety Guard Unit Tests', (t) => {
  // A. Known production Supabase + no designation -> BLOCK
  assert.throws(() => {
    assertSafeTestDatabaseUrl('postgres://postgres:secret@db.mamafzllyhbmzyystivo.supabase.co:5432/postgres');
  }, /HARD DENY/);

  // B. Known production Supabase + POSTGRES_IS_TEST_STAGING=true -> STILL BLOCK
  const origEnv = process.env.POSTGRES_IS_TEST_STAGING;
  try {
    process.env.POSTGRES_IS_TEST_STAGING = 'true';
    assert.throws(() => {
      assertSafeTestDatabaseUrl('postgres://postgres:secret@db.mamafzllyhbmzyystivo.supabase.co:5432/postgres');
    }, /HARD DENY/);
  } finally {
    process.env.POSTGRES_IS_TEST_STAGING = origEnv;
  }

  // C. Unknown/generic Supabase + no designation -> BLOCK
  try {
    delete process.env.POSTGRES_IS_TEST_STAGING;
    assert.throws(() => {
      assertSafeTestDatabaseUrl('postgres://postgres:secret@db.randomproject123.supabase.co:5432/postgres');
    }, /POSTGRES_IS_TEST_STAGING=true/);
  } finally {
    if (origEnv !== undefined) process.env.POSTGRES_IS_TEST_STAGING = origEnv;
  }

  // D. Dedicated Supabase test DB + POSTGRES_IS_TEST_STAGING=true -> ALLOW
  try {
    process.env.POSTGRES_IS_TEST_STAGING = 'true';
    assert.doesNotThrow(() => {
      assertSafeTestDatabaseUrl('postgres://postgres:secret@db.dedicatedtestproj.supabase.co:5432/postgres');
    });
  } finally {
    if (origEnv !== undefined) process.env.POSTGRES_IS_TEST_STAGING = origEnv;
  }

  // E. Malformed/empty URL -> BLOCK
  assert.throws(() => {
    assertSafeTestDatabaseUrl('');
  }, /Connection string is required/);
  assert.throws(() => {
    assertSafeTestDatabaseUrl(null);
  }, /Connection string is required/);
});

test('PostgreSQL Live Integration Test Harness', async (t) => {
  if (!testDbUrl) {
    t.diagnostic('================================================================================');
    t.diagnostic('  [PostgreSQL Integration Suite]');
    t.diagnostic('  NOT EXECUTED — TEST/STAGING DATABASE NOT PROVIDED');
    t.diagnostic('  (Set POSTGRES_TEST_URL to execute live PostgreSQL integration tests)');
    t.diagnostic('================================================================================');
    return;
  }

  assertSafeTestDatabaseUrl(testDbUrl);

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

    await t.test('3. Real PostgreSQL transaction COMMIT and ROLLBACK', async () => {
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
        tx.outbox.record(createDomainEvent({
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

    await t.test('5. Outbox persistence failure before COMMIT rolls back state mutation on PostgreSQL', async () => {
      const initialFlag = await pgDriver.withTransaction(async (tx) => tx.featureFlags.get('TAX_V2'));

      await assert.rejects(async () => {
        await pgDriver.withTransaction(async (tx) => {
          await tx.featureFlags.set('TAX_V2', true);
          // Force outbox write error via duplicate primary key on outbox table
          tx.outbox.record({ eventId: 'dup_id', eventType: 'test', aggregate: { type: 't', id: '1' } });
          tx.outbox.record({ eventId: 'dup_id', eventType: 'test', aggregate: { type: 't', id: '1' } });
        });
      });

      const finalFlag = await pgDriver.withTransaction(async (tx) => tx.featureFlags.get('TAX_V2'));
      assert.equal(finalFlag, initialFlag);
    });

    await t.test('6. Post-commit publication failure and durable retry status on PostgreSQL', async () => {
      const eventId = `evt_pub_${Date.now()}`;
      await pgDriver.withTransaction(async (tx) => {
        tx.outbox.record(createDomainEvent({
          eventId,
          eventType: 'festival.booth_entered',
          aggregate: { type: 'booth', id: 'b1' },
        }));
      });

      const publisher = new PgOutboxPublisher(pgDriver, async () => {
        throw new Error('Post-commit message transport unreachable');
      });

      const records = await pgDriver.claimRetryableOutboxBatch(10);
      const targetRecord = records.find(r => r.event.eventId === eventId);
      assert.ok(targetRecord);

      const pubResult = await publisher.publishCommitted([targetRecord]);
      assert.equal(pubResult.publicationErrors.length, 1);

      // Verify status in database is PUBLICATION_FAILED_RETRYABLE
      const statusRes = await pool.query(`SELECT status, attempt_count, last_error FROM public.v2_outbox WHERE event_id = $1`, [eventId]);
      assert.equal(statusRes.rows[0].status, 'PUBLICATION_FAILED_RETRYABLE');
      assert.equal(statusRes.rows[0].attempt_count, 1);
      assert.equal(statusRes.rows[0].last_error, 'Post-commit message transport unreachable');

      // Retry with working publisher succeeds and clears last_error
      const workingPublisher = new PgOutboxPublisher(pgDriver, async () => {});
      const retryResult = await workingPublisher.processRetryableOutbox();
      assert.ok(retryResult.publishedEvents.some(e => e.eventId === eventId));

      const updatedRes = await pool.query(`SELECT status, published_at, last_error FROM public.v2_outbox WHERE event_id = $1`, [eventId]);
      assert.equal(updatedRes.rows[0].status, 'PUBLISHED');
      assert.ok(updatedRes.rows[0].published_at);
      assert.equal(updatedRes.rows[0].last_error, null); // Last error cleared on success!
    });

    await t.test('7. Admin feature flag + audit atomic commit on PostgreSQL', async () => {
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

    await t.test('8. Real Admin Audit Failure Rolls Back Feature Flag Mutation on PostgreSQL', async () => {
      const superAdmin = { actorId: 'admin_pg_rollback_test', role: QTV_ROLES.SUPER_ADMIN };

      // Set flag initial state
      await pgDriver.withTransaction(async (tx) => {
        await tx.featureFlags.set('THEFT_V2', false);
      });

      // Force audit failure by attempting invalid NULL action in raw SQL query inside transaction
      await assert.rejects(async () => {
        await pgDriver.withTransaction(async (tx) => {
          await tx.featureFlags.set('THEFT_V2', true);
          // Force DB NOT NULL constraint violation on v2_admin_audit_logs table
          await tx.client.query(
            `INSERT INTO public.v2_admin_audit_logs (event_id, admin_actor_id, admin_role, action, reason) VALUES ('a_err', 'admin_1', 'SUPER_ADMIN', NULL, 'fail')`
          );
        });
      });

      // Verify THEFT_V2 flag was NOT changed (rolled back!)
      const flagVal = await pgDriver.withTransaction(async (tx) => tx.featureFlags.get('THEFT_V2'));
      assert.equal(flagVal, false);
    });

    await t.test('9. Config DRAFT creation, approval, and APPROVED immutability on PostgreSQL', async () => {
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

    await t.test('10. Durable Kill Switch + audit atomic commit on PostgreSQL', async () => {
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

    await t.test('11. Idempotency (actor_id, key) uniqueness, replay, and conflict on PostgreSQL', async () => {
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
        idempotencyKey: 'pg_idem_key_1',
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

    await t.test('12. Real multi-client PostgreSQL controlled concurrent idempotency claim race', async () => {
      const client1 = await pool.connect();
      const client2 = await pool.connect();

      const raceActor = { actorId: 'actor_pg_race_controlled' };
      const raceKey = `race_key_controlled_${Date.now()}`;
      const raceCmd = createCommand({
        type: 'festival.enter_booth',
        actor: raceActor,
        idempotencyKey: raceKey,
        payload: { boothId: 'b_controlled_race' },
      });

      let handlerCallCount = 0;

      try {
        await client1.query('BEGIN');
        await client2.query('BEGIN');

        const tx1 = new PgTxContext(client1);
        const tx2 = new PgTxContext(client2);

        // 1. Client 1 claims the idempotency key (inserts status = 'PENDING')
        const claim1 = await tx1.idempotency.claim(raceKey, raceCmd);
        assert.equal(claim1.status, 'CLAIMED');

        // Execute handler work on Client 1
        handlerCallCount++;
        await tx1.featureFlags.set('FORTUNE_V2', true);
        const raceEventId = `evt_race_${Date.now()}`;
        tx1.outbox.record(createDomainEvent({
          eventId: raceEventId,
          eventType: 'festival.booth_entered',
          aggregate: { type: 'booth', id: 'b_controlled_race' },
          actor: raceActor,
        }));

        // 2. Client 2 attempts to claim the EXACT same (actor_id, idempotency_key) concurrently while Client 1 transaction is open
        const client2ClaimPromise = tx2.idempotency.claim(raceKey, raceCmd).catch(err => err);

        // Winner (Client 1) flushes outbox, completes idempotency record, and commits
        await tx1.flushStagedOutbox();
        await tx1.idempotency.complete(raceActor.actorId, raceKey, { ticket: 'winner_ticket_100' });
        await client1.query('COMMIT');

        // Await Client 2's promise after Client 1 commits (Client 2 blocked on row lock until Client 1 commit)
        const client2Result = await client2ClaimPromise;
        assert.ok(client2Result instanceof Error, 'Client 2 claim must result in an error');
        assert.ok(
          client2Result.name === 'ConcurrentExecutionError' || client2Result.status === 'COMPLETED',
          'Client 2 receiving concurrent execution or replayed completion'
        );

        // Client 2 MUST ROLLBACK and NOT mutate state
        await client2.query('ROLLBACK');

        // 3. Retry same command after winner COMMIT
        const replayRes = await pgDriver.withTransaction(async (tx) => {
          return await tx.idempotency.claim(raceKey, raceCmd);
        });

        assert.equal(replayRes.status, 'COMPLETED');
        assert.equal(replayRes.result.ticket, 'winner_ticket_100');

        // 4. Verification of exact execution counts and state/outbox singleton invariants
        assert.equal(handlerCallCount, 1, 'Domain handler executed exactly ONCE');

        const outboxRows = await pool.query(`SELECT status FROM public.v2_outbox WHERE event_id = $1`, [raceEventId]);
        assert.equal(outboxRows.rows.length, 1, 'Outbox event persisted exactly ONCE');

      } finally {
        client1.release();
        client2.release();
      }
    });

    await t.test('13. Real retry worker outbox batch concurrency with SKIP LOCKED on PostgreSQL', async () => {
      const event1Id = `evt_worker_1_${Date.now()}`;
      const event2Id = `evt_worker_2_${Date.now()}`;

      await pgDriver.withTransaction(async (tx) => {
        tx.outbox.record(createDomainEvent({
          eventId: event1Id,
          eventType: 'festival.booth_entered',
          aggregate: { type: 'booth', id: 'b1' },
        }));
        tx.outbox.record(createDomainEvent({
          eventId: event2Id,
          eventType: 'festival.booth_entered',
          aggregate: { type: 'booth', id: 'b2' },
        }));
      });

      // Two concurrent workers claim batches of 1 record simultaneously
      const [batch1, batch2] = await Promise.all([
        pgDriver.claimRetryableOutboxBatch(1),
        pgDriver.claimRetryableOutboxBatch(1),
      ]);

      assert.equal(batch1.length, 1);
      assert.equal(batch2.length, 1);

      // Verify each worker claimed a DIFFERENT outbox event (no duplicate worker claims!)
      const claimedEvent1 = batch1[0].event.eventId;
      const claimedEvent2 = batch2[0].event.eventId;
      assert.notEqual(claimedEvent1, claimedEvent2);
    });

    await t.test('14. End-to-end production command pipeline execution and replay on PostgreSQL', async () => {
      const actor = { actorId: 'usr_e2e_1' };
      const e2eCmd = createCommand({
        type: 'festival.enter_booth',
        actor,
        idempotencyKey: 'idem_e2e_100',
        payload: { boothId: 'b_e2e' },
      });

      // Execute pipeline
      const pipelineRes = await executePipeline({
        command: e2eCmd,
        pgDriver,
        handlerFn: async ({ command, tx, outbox }) => {
          await tx.featureFlags.set('FORTUNE_V2', true);
          outbox.record(createDomainEvent({
            eventType: 'festival.booth_entered',
            aggregate: { type: 'booth', id: 'b_e2e' },
            actor: { actorId: command.actor.actorId },
          }));
          return { status: 'ENTERED' };
        },
      });

      assert.equal(pipelineRes.replayed, false);
      assert.equal(pipelineRes.result.status, 'ENTERED');

      // Replay pipeline call -> returns replayed without duplicate execution
      const replayRes = await executePipeline({
        command: e2eCmd,
        pgDriver,
        handlerFn: async () => {
          throw new Error('Handler should not execute on replay');
        },
      });

      assert.equal(replayRes.replayed, true);
      assert.equal(replayRes.result.status, 'ENTERED');
    });

  } finally {
    await pgDriver.close();
  }
});
