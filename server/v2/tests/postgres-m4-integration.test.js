import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PgDriver } from '../adapters/pg-driver.js';
import { AccountService } from '../domains/identity/index.js';
import { ProgressService, InvalidAccountStateError } from '../domains/progress/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migration001Path = path.resolve(__dirname, '../migrations/001_v2_foundation_schema.sql');
const migration002Path = path.resolve(__dirname, '../migrations/002_v2_account_identity_schema.sql');
const migration005Path = path.resolve(__dirname, '../migrations/005_v2_progress_unlock_schema.sql');
const testDbUrl = process.env.POSTGRES_TEST_URL || process.env.PGDATABASE_TEST_URL || null;

test('M4 PostgreSQL Progress & Unlock Compatibility Integration', { skip: !testDbUrl }, async (t) => {
  const pgDriver = new PgDriver(testDbUrl);
  const pool = pgDriver.pool;
  const accountService = new AccountService({ pgDriver });
  const progressService = new ProgressService({ pgDriver });

  try {
    await t.test('migration 005 applies twice cleanly and installs progress tables', async () => {
      const sql001 = fs.readFileSync(migration001Path, 'utf8');
      const sql002 = fs.readFileSync(migration002Path, 'utf8');
      const sql005 = fs.readFileSync(migration005Path, 'utf8');

      const client = await pool.connect();
      try {
        await client.query(sql001);
        await client.query(sql002);
        await client.query(sql005);
        // Repeat migration 005 to verify repeatability
        await client.query(sql005);
      } finally {
        client.release();
      }

      const tablesRes = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'v2_chapter_progress'`
      );
      assert.equal(tablesRes.rows.length, 1);
    });

    await t.test('record progress, completion, and evaluate unlock state in live database', async () => {
      const account = await accountService.createAccount();
      const userId = account.userId;

      // Initial unlock evaluation: Ch 1 open, Ch 2 locked
      let unlockState = await progressService.evaluateUnlockState(userId);
      assert.equal(unlockState['1'].unlocked, true);
      assert.equal(unlockState['2'].unlocked, false);

      // Record progress for Ch 1 (in-progress)
      const prog1 = await progressService.recordProgress({
        userId,
        chapterId: '1',
        progress: { printsCompleted: 3 },
        completed: false,
      });
      assert.equal(prog1.completed, false);

      // Complete Ch 1
      const comp1 = await progressService.recordChapterCompletion({
        userId,
        chapterId: '1',
        progress: { printsCompleted: 6 },
      });
      assert.equal(comp1.completed, true);

      // Evaluate unlock state again: Ch 2 is now unlocked!
      unlockState = await progressService.evaluateUnlockState(userId);
      assert.equal(unlockState['2'].unlocked, true);

      // Verify outbox event recorded for Ch 1 completion
      const outboxRes = await pool.query(
        `SELECT * FROM public.v2_outbox WHERE aggregate_type = 'progress' AND aggregate_id = $1 AND event_type = 'progress.chapter_completed'`,
        [userId]
      );
      assert.equal(outboxRes.rows.length, 1);

      // Retry Ch 1 completion (idempotent, no duplicate outbox event)
      await progressService.recordChapterCompletion({
        userId,
        chapterId: '1',
        progress: { printsCompleted: 6 },
      });

      const outboxRetryRes = await pool.query(
        `SELECT * FROM public.v2_outbox WHERE aggregate_type = 'progress' AND aggregate_id = $1 AND event_type = 'progress.chapter_completed'`,
        [userId]
      );
      assert.equal(outboxRetryRes.rows.length, 1); // Exact same count!
    });

    await t.test('legacy progress sync in live PostgreSQL database', async () => {
      const account = await accountService.createAccount();
      const userId = account.userId;

      const legacySnapshot = {
        'dcc.done': JSON.stringify([true, true, true, true, true, true]),
        'dcc.c2s': JSON.stringify({ done: Array(14).fill(true) }),
        'dcc.c3s': JSON.stringify({ done: Array(5).fill(true) }),
      };

      await progressService.syncLegacyProgress({ userId, legacySnapshot });

      const unlockState = await progressService.evaluateUnlockState(userId);
      assert.equal(unlockState['1'].completed, true);
      assert.equal(unlockState['2'].completed, true);
      assert.equal(unlockState['3'].completed, true);
      assert.equal(unlockState['4'].unlocked, true); // Ch 4 unlocked by Ch 2 completion
    });

    await t.test('suspended account prohibited from recording progress in live database', async () => {
      const account = await accountService.createAccount({ state: 'SUSPENDED' });
      await assert.rejects(
        progressService.recordProgress({ userId: account.userId, chapterId: '1', progress: {} }),
        InvalidAccountStateError
      );
    });

    await t.test('atomic transaction rollback leaves zero partial progress state', async () => {
      const account = await accountService.createAccount();
      const userId = account.userId;

      await assert.rejects(
        pgDriver.withTransaction(async (tx) => {
          await progressService.recordChapterCompletion({ userId, chapterId: '1', progress: {} }, tx);
          throw new Error('Forced M4 rollback test');
        }),
        /Forced M4 rollback test/
      );

      const records = await progressService.getUserProgress(userId);
      assert.equal(records.length, 0);
    });
  } finally {
    await pgDriver.close();
  }
});
