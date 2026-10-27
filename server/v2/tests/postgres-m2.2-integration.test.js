import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PgDriver } from '../adapters/pg-driver.js';
import {
  AccountService,
  DuplicateProviderIdentityError,
  InvalidAccountStateError,
  MockProviderVerifier,
  handleLinkProviderIdentityCommand,
} from '../domains/identity/index.js';
import { createCommand } from '../core/command.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migration003Path = path.resolve(__dirname, '../migrations/003_v2_provider_identity_schema.sql');
const testDbUrl = process.env.POSTGRES_TEST_URL || process.env.PGDATABASE_TEST_URL || null;

test('M2.2 PostgreSQL Provider Linking Integration', { skip: !testDbUrl }, async (t) => {
  const pgDriver = new PgDriver(testDbUrl);
  const pool = pgDriver.pool;
  const accountService = new AccountService({ pgDriver });

  try {
    await t.test('migration 003 applies twice and installs the exact provider identity constraint', async () => {
      const sql003 = fs.readFileSync(migration003Path, 'utf8');
      const client = await pool.connect();
      try {
        await client.query(sql003);
        await client.query(sql003);
      } finally {
        client.release();
      }

      const tableRes = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'v2_provider_identities'`
      );
      assert.equal(tableRes.rows.length, 1);
      const constraintRes = await pool.query(
        `SELECT constraint_name FROM information_schema.table_constraints
         WHERE table_schema = 'public' AND table_name = 'v2_provider_identities' AND constraint_type = 'UNIQUE'`
      );
      assert.equal(constraintRes.rows.some((row) => row.constraint_name === 'uq_v2_provider_identities_provider_subject'), true);
    });

    await t.test('trusted verified assertion persists provider link and relink is idempotent', async () => {
      const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const account = await accountService.createAccount();
      const verifier = new MockProviderVerifier();
      verifier.registerToken(`token_${suffix}`, 'GOOGLE', `subject_${suffix}`);
      const command = createCommand({
        type: 'identity.link_provider_identity',
        actor: { actorId: account.userId },
        payload: { providerAssertion: { provider: 'google', assertionToken: `token_${suffix}` } },
      });

      const first = await pgDriver.withTransaction((tx) => handleLinkProviderIdentityCommand({ command, accountService, providerVerifier: verifier, tx }));
      assert.equal(first.userId, account.userId);
      assert.equal(first.provider, 'GOOGLE');

      const before = await pool.query(
        `SELECT count(*)::int AS count FROM public.v2_outbox WHERE aggregate_id = $1 AND event_type = 'identity.provider_linked'`,
        [account.userId]
      );
      assert.equal(before.rows[0].count, 1);

      const second = await pgDriver.withTransaction((tx) => handleLinkProviderIdentityCommand({ command, accountService, providerVerifier: verifier, tx }));
      assert.equal(second.providerSubject, first.providerSubject);
      const after = await pool.query(
        `SELECT count(*)::int AS count FROM public.v2_outbox WHERE aggregate_id = $1 AND event_type = 'identity.provider_linked'`,
        [account.userId]
      );
      assert.equal(after.rows[0].count, 1);
    });

    await t.test('cross-account duplicates and non-ACTIVE accounts fail closed', async () => {
      const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const owner = await accountService.createAccount();
      const other = await accountService.createAccount();
      const suspended = await accountService.createAccount({ state: 'SUSPENDED' });
      await accountService.linkProviderIdentity({ userId: owner.userId, provider: 'FACEBOOK', providerSubject: `dup_${suffix}` });
      await assert.rejects(
        accountService.linkProviderIdentity({ userId: other.userId, provider: 'FACEBOOK', providerSubject: `dup_${suffix}` }),
        DuplicateProviderIdentityError
      );
      await assert.rejects(
        accountService.linkProviderIdentity({ userId: suspended.userId, provider: 'THREADS', providerSubject: `blocked_${suffix}` }),
        InvalidAccountStateError
      );
    });

    await t.test('provider link and outbox roll back atomically', async () => {
      const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const subject = `rollback_${suffix}`;
      let userId = null;
      await assert.rejects(
        pgDriver.withTransaction(async (tx) => {
          const account = await accountService.createAccount({}, tx);
          userId = account.userId;
          await accountService.linkProviderIdentity({ userId, provider: 'GOOGLE', providerSubject: subject }, tx);
          throw new Error('forced M2.2 rollback');
        }),
        /forced M2.2 rollback/
      );
      assert.equal(await accountService.getAccountById(userId), null);
      assert.equal(await accountService.resolveProviderIdentity('GOOGLE', subject), null);
      const outbox = await pool.query(`SELECT count(*)::int AS count FROM public.v2_outbox WHERE aggregate_id = $1`, [userId]);
      assert.equal(outbox.rows[0].count, 0);
    });
  } finally {
    await pgDriver.close();
  }
});
