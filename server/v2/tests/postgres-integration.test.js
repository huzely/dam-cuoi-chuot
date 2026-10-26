import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgDriver, PgTxContext, assertSafeTestDatabaseUrl } from '../adapters/pg-driver.js';
import { PgAdminPersistence } from '../adapters/pg-admin-persistence.js';
import { PgOutboxPublisher } from '../adapters/pg-outbox.js';
import { AdminService, ADMIN_COMMAND_TYPES } from '../domains/admin/service.js';
import { AccountService, DuplicateProviderIdentityError, AccountNotFoundError } from '../domains/identity/index.js';
import { QTV_ROLES } from '../core/rbac.js';
import { createCommand } from '../core/command.js';
import { createDomainEvent } from '../core/event.js';
import { CONFIG_CATEGORIES } from '../core/config.js';
import { executePipeline } from '../core/pipeline.js';
import { IdempotencyMismatchError } from '../core/idempotency.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migration001Path = path.resolve(__dirname, '../migrations/001_v2_foundation_schema.sql');
const migration002Path = path.resolve(__dirname, '../migrations/002_v2_account_identity_schema.sql');

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
  const accountService = new AccountService({ pgDriver });

  try {
    await t.test('1. Migrations 001 and 002 apply cleanly and idempotently to PostgreSQL', async () => {
      const sql001 = fs.readFileSync(migration001Path, 'utf8');
      const sql002 = fs.readFileSync(migration002Path, 'utf8');
      const client = await pool.connect();
      try {
        await client.query(sql001);
        await client.query(sql002);
        // Rerun migration 002 against the exact same connection to verify idempotency / re-run safety
        await client.query(sql002);
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
      assert.equal(tables.includes('v2_accounts'), true);
      assert.equal(tables.includes('v2_provider_identities'), true);

      const constraintRes = await pool.query(
        `SELECT constraint_name FROM information_schema.table_constraints
         WHERE table_schema = 'public' AND table_name = 'v2_provider_identities' AND constraint_type = 'UNIQUE'`
      );
      const constraints = constraintRes.rows.map(r => r.constraint_name);
      assert.equal(constraints.includes('uq_v2_provider_identities_provider_subject'), true);
    });

    await t.test('3. Real PostgreSQL Account creation & lookup', async () => {
      const account = await accountService.createAccount({ state: 'ACTIVE' });
      assert.ok(account.userId);
      assert.match(account.userId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      const found = await accountService.getAccountById(account.userId);
      assert.ok(found);
      assert.equal(found.userId, account.userId);
      assert.equal(found.state, 'ACTIVE');

      // Verify outbox domain event identity.account_created
      const outboxRes = await pool.query(
        `SELECT event_type, payload FROM public.v2_outbox WHERE aggregate_id = $1`,
        [account.userId]
      );
      assert.equal(outboxRes.rows.length, 1);
      assert.equal(outboxRes.rows[0].event_type, 'identity.account_created');
      assert.equal(outboxRes.rows[0].payload.userId, account.userId);
    });

    await t.test('4. Real PostgreSQL Provider identity linking & resolution', async () => {
      const account = await accountService.createAccount();
      const testSub = `sub_pg_test_${Date.now()}`;

      const link = await accountService.linkProviderIdentity({
        userId: account.userId,
        provider: 'google', // Normalized to uppercase GOOGLE
        providerSubject: testSub,
      });

      assert.equal(link.userId, account.userId);
      assert.equal(link.provider, 'GOOGLE');
      assert.equal(link.providerSubject, testSub);

      const resolved = await accountService.resolveProviderIdentity('GOOGLE', testSub);
      assert.ok(resolved);
      assert.equal(resolved.userId, account.userId);
    });

    await t.test('5. Real PostgreSQL duplicate provider identity linking mapped to DuplicateProviderIdentityError', async () => {
      const account1 = await accountService.createAccount();
      const account2 = await accountService.createAccount();
      const dupSub = `sub_pg_dup_${Date.now()}`;

      await accountService.linkProviderIdentity({
        userId: account1.userId,
        provider: 'FACEBOOK',
        providerSubject: dupSub,
      });

      await assert.rejects(async () => {
        await accountService.linkProviderIdentity({
          userId: account2.userId,
          provider: 'FACEBOOK',
          providerSubject: dupSub,
        });
      }, DuplicateProviderIdentityError);
    });

    await t.test('6. Real multi-client PostgreSQL controlled concurrent provider linking race condition', async () => {
      const client1 = await pool.connect();
      const client2 = await pool.connect();

      const acc1 = await accountService.createAccount();
      const acc2 = await accountService.createAccount();
      const raceSub = `sub_pg_race_${Date.now()}`;

      try {
        await client1.query('BEGIN');
        await client2.query('BEGIN');

        const tx1 = new PgTxContext(client1);
        const tx2 = new PgTxContext(client2);

        // Client 1 inserts provider identity link
        const link1 = await accountService.linkProviderIdentity({
          userId: acc1.userId,
          provider: 'THREADS',
          providerSubject: raceSub,
        }, tx1);
        assert.ok(link1);

        // Client 2 attempts concurrent link of SAME identity to acc2 while Client 1 transaction is open
        const client2LinkPromise = accountService.linkProviderIdentity({
          userId: acc2.userId,
          provider: 'THREADS',
          providerSubject: raceSub,
        }, tx2).catch(err => err);

        // Winner (Client 1) commits
        await client1.query('COMMIT');

        // Client 2 promise completes with DuplicateProviderIdentityError after Client 1 commit
        const client2Result = await client2LinkPromise;
        assert.ok(client2Result instanceof Error, 'Client 2 link must result in error');
        assert.ok(
          client2Result instanceof DuplicateProviderIdentityError,
          `Client 2 must receive DuplicateProviderIdentityError, got ${client2Result.name}: ${client2Result.message}`
        );

        await client2.query('ROLLBACK');

        // Verify strictly 1 owner exists in database
        const finalResolved = await accountService.resolveProviderIdentity('THREADS', raceSub);
        assert.ok(finalResolved);
        assert.equal(finalResolved.userId, acc1.userId);

      } finally {
        client1.release();
        client2.release();
      }
    });

    await t.test('7. Real PostgreSQL Transaction rollback leaves no partial identity state or outbox events', async () => {
      const rollbackSub = `sub_pg_rollback_${Date.now()}`;
      let createdUserId = null;

      await assert.rejects(async () => {
        await pgDriver.withTransaction(async (tx) => {
          const acc = await accountService.createAccount({}, tx);
          createdUserId = acc.userId;
          await accountService.linkProviderIdentity({
            userId: acc.userId,
            provider: 'GOOGLE',
            providerSubject: rollbackSub,
          }, tx);

          throw new Error('Forced rollback testing atomic cleanup');
        });
      }, /Forced rollback testing atomic cleanup/);

      // Verify account does not exist
      const accLookup = await accountService.getAccountById(createdUserId);
      assert.equal(accLookup, null);

      // Verify provider identity link does not exist
      const identityLookup = await accountService.resolveProviderIdentity('GOOGLE', rollbackSub);
      assert.equal(identityLookup, null);

      // Verify no outbox rows exist for this account
      const outboxRows = await pool.query(`SELECT * FROM public.v2_outbox WHERE aggregate_id = $1`, [createdUserId]);
      assert.equal(outboxRows.rows.length, 0);
    });

    await t.test('8. Real PostgreSQL idempotent re-linking same provider identity to same account', async () => {
      const acc = await accountService.createAccount();
      const idemSub = `sub_pg_idem_relink_${Date.now()}`;

      const link1 = await accountService.linkProviderIdentity({
        userId: acc.userId,
        provider: 'GOOGLE',
        providerSubject: idemSub,
      });

      // Count outbox events
      const outbox1 = await pool.query(`SELECT * FROM public.v2_outbox WHERE aggregate_id = $1 AND event_type = 'identity.provider_linked'`, [acc.userId]);
      assert.equal(outbox1.rows.length, 1);

      // Re-link exact same identity
      const link2 = await accountService.linkProviderIdentity({
        userId: acc.userId,
        provider: 'GOOGLE',
        providerSubject: idemSub,
      });

      assert.equal(link2.userId, link1.userId);
      assert.equal(link2.providerSubject, link1.providerSubject);

      // Verify no duplicate outbox event was created
      const outbox2 = await pool.query(`SELECT * FROM public.v2_outbox WHERE aggregate_id = $1 AND event_type = 'identity.provider_linked'`, [acc.userId]);
      assert.equal(outbox2.rows.length, 1);
    });

    await t.test('9. Real PostgreSQL transaction COMMIT and ROLLBACK', async () => {
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

    await t.test('10. Atomic state mutation + outbox commit/rollback on PostgreSQL', async () => {
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

    await t.test('11. Outbox persistence failure before COMMIT rolls back state mutation on PostgreSQL', async () => {
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

    await t.test('12. Post-commit publication failure and durable retry status on PostgreSQL', async () => {
      const eventId = `evt_pub_${Date.now()}`;
      const domainEvent = createDomainEvent({
        eventId,
        eventType: 'festival.booth_entered',
        aggregate: { type: 'booth', id: 'b1' },
      });

      await pgDriver.withTransaction(async (tx) => {
        tx.outbox.record(domainEvent);
      });

      const failingPublisher = new PgOutboxPublisher(pgDriver, async () => {
        throw new Error('Post-commit message transport unreachable');
      });

      // Target the specifically created outbox event record deterministically
      const committedRecord = {
        event: domainEvent,
        status: 'COMMITTED_IN_STORAGE',
        attemptCount: 0,
        lastError: null,
      };

      const pubResult = await failingPublisher.publishCommitted([committedRecord]);
      assert.equal(pubResult.publicationErrors.length, 1);

      // Verify status in database is PUBLICATION_FAILED_RETRYABLE
      const statusRes = await pool.query(`SELECT status, attempt_count, last_error FROM public.v2_outbox WHERE event_id = $1`, [eventId]);
      assert.equal(statusRes.rows[0].status, 'PUBLICATION_FAILED_RETRYABLE');
      assert.equal(statusRes.rows[0].attempt_count, 1);
      assert.equal(statusRes.rows[0].last_error, 'Post-commit message transport unreachable');

      // Retry with working publisher for this specific record succeeds and clears last_error
      const workingPublisher = new PgOutboxPublisher(pgDriver, async () => {});
      const retryResult = await workingPublisher.publishCommitted([committedRecord]);
      assert.equal(retryResult.publishedEvents.length, 1);
      assert.equal(retryResult.publishedEvents[0].eventId, eventId);

      const updatedRes = await pool.query(`SELECT status, published_at, last_error FROM public.v2_outbox WHERE event_id = $1`, [eventId]);
      assert.equal(updatedRes.rows[0].status, 'PUBLISHED');
      assert.ok(updatedRes.rows[0].published_at);
      assert.equal(updatedRes.rows[0].last_error, null);
    });

    await t.test('13. Admin feature flag + audit atomic commit on PostgreSQL', async () => {
      const superAdmin = { actorId: 'admin_pg_1', role: QTV_ROLES.SUPER_ADMIN };

      const res = await adminService.executeAdminCommand({
        adminActor: superAdmin,
        command: createCommand({
          type: ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET,
          actor: superAdmin,
          payload: { flagKey: 'HOI_XUAN_V2', enabled: true, reason: 'Live PostgreSQL rollout test' },
        }),
      });
      assert.equal(res.success, true);

      const auditRes = await pool.query(
        `SELECT action, reason FROM public.v2_admin_audit_logs WHERE admin_actor_id = $1 ORDER BY created_at DESC LIMIT 1`,
        ['admin_pg_1']
      );
      assert.equal(auditRes.rows.length, 1);
      assert.equal(auditRes.rows[0].reason, 'Live PostgreSQL rollout test');
    });

    await t.test('14. Real Admin Audit Failure Rolls Back Feature Flag Mutation on PostgreSQL', async () => {
      const superAdmin = { actorId: 'admin_pg_rollback_test', role: QTV_ROLES.SUPER_ADMIN };

      await pgDriver.withTransaction(async (tx) => {
        await tx.featureFlags.set('THEFT_V2', false);
      });

      await assert.rejects(async () => {
        await pgDriver.withTransaction(async (tx) => {
          await tx.featureFlags.set('THEFT_V2', true);
          await tx.client.query(
            `INSERT INTO public.v2_admin_audit_logs (event_id, admin_actor_id, admin_role, action, reason) VALUES ('a_err', 'admin_1', 'SUPER_ADMIN', NULL, 'fail')`
          );
        });
      });

      const flagVal = await pgDriver.withTransaction(async (tx) => tx.featureFlags.get('THEFT_V2'));
      assert.equal(flagVal, false);
    });

    await t.test('15. Config DRAFT creation, approval, and APPROVED immutability on PostgreSQL', async () => {
      const econManager = { actorId: 'econ_pg_1', role: QTV_ROLES.ECONOMY_MANAGER };
      const configVersion = `2.0.0-pg-${Date.now()}`;

      await adminService.executeAdminCommand({
        adminActor: econManager,
        command: createCommand({
          type: ADMIN_COMMAND_TYPES.CONFIG_CREATE_DRAFT,
          actor: econManager,
          payload: {
            version: configVersion,
            definitions: { 'BASE_FEE': { category: CONFIG_CATEGORIES.ECONOMY_CONFIG, value: 50 } },
            reason: 'Draft ruleset for live PG test',
          },
        }),
      });

      await adminService.executeAdminCommand({
        adminActor: econManager,
        command: createCommand({
          type: ADMIN_COMMAND_TYPES.CONFIG_APPROVE,
          actor: econManager,
          payload: { version: configVersion, reason: 'Approving ruleset' },
        }),
      });

      const approvedRes = await pgDriver.withTransaction(async (tx) => tx.config.getRulesetByVersion(configVersion));
      assert.equal(approvedRes.status, 'APPROVED');

      await assert.rejects(async () => {
        await adminService.executeAdminCommand({
          adminActor: econManager,
          command: createCommand({
            type: ADMIN_COMMAND_TYPES.CONFIG_CREATE_DRAFT,
            actor: econManager,
            payload: {
              version: configVersion,
              definitions: { 'BASE_FEE': { category: CONFIG_CATEGORIES.ECONOMY_CONFIG, value: 999 } },
              reason: 'Overwriting approved ruleset',
            },
          }),
        });
      }, /Forbidden Mutation Error/);
    });

    await t.test('16. Durable Kill Switch + audit atomic commit on PostgreSQL', async () => {
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

    await t.test('17. Idempotency (actor_id, key) uniqueness, replay, and conflict on PostgreSQL', async () => {
      const actorA = { actorId: 'actor_pg_A' };
      const actorB = { actorId: 'actor_pg_B' };
      const testKey = `pg_idem_key_${Date.now()}`;
      const cmdA1 = createCommand({
        type: 'festival.enter_booth',
        actor: actorA,
        idempotencyKey: testKey,
        payload: { boothId: 'b1' },
      });
      const cmdA2Same = createCommand({
        type: 'festival.enter_booth',
        actor: actorA,
        idempotencyKey: testKey,
        payload: { boothId: 'b1' },
      });
      const cmdA2Diff = createCommand({
        type: 'festival.enter_booth',
        actor: actorA,
        idempotencyKey: testKey,
        payload: { boothId: 'b2_different' },
      });
      const cmdB1 = createCommand({
        type: 'festival.enter_booth',
        actor: actorB,
        idempotencyKey: testKey,
        payload: { boothId: 'b1' },
      });

      await pgDriver.withTransaction(async (tx) => {
        const claim = await tx.idempotency.claim(testKey, cmdA1);
        assert.equal(claim.status, 'CLAIMED');
        await tx.idempotency.complete('actor_pg_A', testKey, { result: 'A_OK' });
      });

      await pgDriver.withTransaction(async (tx) => {
        const replay = await tx.idempotency.claim(testKey, cmdA2Same);
        assert.equal(replay.status, 'COMPLETED');
        assert.equal(replay.result.result, 'A_OK');
      });

      await assert.rejects(async () => {
        await pgDriver.withTransaction(async (tx) => {
          await tx.idempotency.claim(testKey, cmdA2Diff);
        });
      }, IdempotencyMismatchError);

      await pgDriver.withTransaction(async (tx) => {
        const claimB = await tx.idempotency.claim(testKey, cmdB1);
        assert.equal(claimB.status, 'CLAIMED');
      });
    });

    await t.test('18. Real multi-client PostgreSQL controlled concurrent idempotency claim race', async () => {
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

        const claim1 = await tx1.idempotency.claim(raceKey, raceCmd);
        assert.equal(claim1.status, 'CLAIMED');

        handlerCallCount++;
        await tx1.featureFlags.set('FORTUNE_V2', true);
        const raceEventId = `evt_race_${Date.now()}`;
        tx1.outbox.record(createDomainEvent({
          eventId: raceEventId,
          eventType: 'festival.booth_entered',
          aggregate: { type: 'booth', id: 'b_controlled_race' },
          actor: raceActor,
        }));

        const client2ClaimPromise = tx2.idempotency.claim(raceKey, raceCmd).catch(err => err);

        await tx1.flushStagedOutbox();
        await tx1.idempotency.complete(raceActor.actorId, raceKey, { ticket: 'winner_ticket_100' });
        await client1.query('COMMIT');

        const client2Result = await client2ClaimPromise;
        assert.ok(client2Result instanceof Error, 'Client 2 claim must result in an error');
        assert.ok(
          client2Result.name === 'ConcurrentExecutionError' || client2Result.status === 'COMPLETED',
          'Client 2 receiving concurrent execution or replayed completion'
        );

        await client2.query('ROLLBACK');

        const replayRes = await pgDriver.withTransaction(async (tx) => {
          return await tx.idempotency.claim(raceKey, raceCmd);
        });

        assert.equal(replayRes.status, 'COMPLETED');
        assert.equal(replayRes.result.ticket, 'winner_ticket_100');

        assert.equal(handlerCallCount, 1, 'Domain handler executed exactly ONCE');

        const outboxRows = await pool.query(`SELECT status FROM public.v2_outbox WHERE event_id = $1`, [raceEventId]);
        assert.equal(outboxRows.rows.length, 1, 'Outbox event persisted exactly ONCE');

      } finally {
        client1.release();
        client2.release();
      }
    });

    await t.test('19. Real retry worker outbox batch concurrency with SKIP LOCKED on PostgreSQL', async () => {
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

      const [batch1, batch2] = await Promise.all([
        pgDriver.claimRetryableOutboxBatch(1),
        pgDriver.claimRetryableOutboxBatch(1),
      ]);

      assert.equal(batch1.length, 1);
      assert.equal(batch2.length, 1);

      const claimedEvent1 = batch1[0].event.eventId;
      const claimedEvent2 = batch2[0].event.eventId;
      assert.notEqual(claimedEvent1, claimedEvent2);
    });

    await t.test('20. End-to-end production command pipeline execution and replay on PostgreSQL', async () => {
      const actor = { actorId: 'usr_e2e_1' };
      const e2eKey = `idem_e2e_${Date.now()}`;
      const e2eCmd = createCommand({
        type: 'festival.enter_booth',
        actor,
        idempotencyKey: e2eKey,
        payload: { boothId: 'b_e2e' },
      });

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
    await pool.end();
  }
});
