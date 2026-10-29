import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PgDriver } from '../adapters/pg-driver.js';
import { AccountService } from '../domains/identity/index.js';
import {
  EconomyService,
  InsufficientBalanceError,
  WalletConcurrencyError,
  InvalidHoldStatusError,
  InvalidTransactionTypeError,
  DuplicateLedgerIdempotencyError,
} from '../domains/economy/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migration001Path = path.resolve(__dirname, '../migrations/001_v2_foundation_schema.sql');
const migration002Path = path.resolve(__dirname, '../migrations/002_v2_account_identity_schema.sql');
const migration004Path = path.resolve(__dirname, '../migrations/004_v2_economy_wallet_schema.sql');
const testDbUrl = process.env.POSTGRES_TEST_URL || process.env.PGDATABASE_TEST_URL || null;

test('M3 PostgreSQL Economy, Wallet V2, Ledger & Holds Integration', { skip: !testDbUrl }, async (t) => {
  const pgDriver = new PgDriver(testDbUrl);
  const pool = pgDriver.pool;
  const accountService = new AccountService({ pgDriver });
  const economyService = new EconomyService({ pgDriver });

  try {
    await t.test('migration 004 applies twice cleanly and installs economy tables & constraints', async () => {
      const sql001 = fs.readFileSync(migration001Path, 'utf8');
      const sql002 = fs.readFileSync(migration002Path, 'utf8');
      const sql004 = fs.readFileSync(migration004Path, 'utf8');

      const client = await pool.connect();
      try {
        await client.query(sql001);
        await client.query(sql002);
        await client.query(sql004);
        // Repeat migration 004 to verify repeatability
        await client.query(sql004);
      } finally {
        client.release();
      }

      const tablesRes = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('v2_wallets', 'v2_ledger_entries', 'v2_holds')`
      );
      assert.equal(tablesRes.rows.length, 3);

      const idxRes = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'v2_ledger_entries' AND indexname = 'uq_v2_ledger_entries_user_idempotency'`
      );
      assert.equal(idxRes.rows.length, 1);
    });

    await t.test('faucet grant, sink charge, and nonnegative balance invariants with frozen registry enforcement', async () => {
      const account = await accountService.createAccount();
      const userId = account.userId;

      // Faucet grant 1000 đồng using registered type CHAPTER_REWARD
      const grantRes = await economyService.grantFaucet({ userId, amount: 1000, type: 'CHAPTER_REWARD' });
      assert.equal(grantRes.wallet.availableBalance, 1000n);
      assert.equal(grantRes.wallet.version, 2);
      assert.equal(grantRes.ledgerEntry.amount, 1000n);
      assert.equal(grantRes.ledgerEntry.balanceAfter, 1000n);
      assert.equal(grantRes.ledgerEntry.class, 'FAUCET');
      assert.equal(grantRes.ledgerEntry.type, 'CHAPTER_REWARD');

      // Unregistered transaction type or incompatible class fails closed
      await assert.rejects(
        economyService.grantFaucet({ userId, amount: 500, type: 'UNREGISTERED_TYPE' }),
        InvalidTransactionTypeError
      );
      await assert.rejects(
        economyService.grantFaucet({ userId, amount: 500, type: 'SHOP_UPGRADE' }), // SHOP_UPGRADE is a SINK type!
        InvalidTransactionTypeError
      );

      // Sink charge 400 đồng using registered type SHOP_UPGRADE
      const sinkRes = await economyService.chargeSink({ userId, amount: 400, type: 'SHOP_UPGRADE' });
      assert.equal(sinkRes.wallet.availableBalance, 600n);
      assert.equal(sinkRes.wallet.version, 3);
      assert.equal(sinkRes.ledgerEntry.amount, -400n);
      assert.equal(sinkRes.ledgerEntry.balanceAfter, 600n);
      assert.equal(sinkRes.ledgerEntry.class, 'SINK');

      // Attempt sink charge 700 đồng exceeding 600 đồng available -> InsufficientBalanceError
      await assert.rejects(
        economyService.chargeSink({ userId, amount: 700, type: 'SHOP_UPGRADE' }),
        InsufficientBalanceError
      );

      // Verify wallet balance remained 600 đồng
      const wallet = await economyService.getWallet(userId);
      assert.equal(wallet.availableBalance, 600n);
    });

    await t.test('DB-level idempotency strategy prevents duplicate ledger and wallet mutations on retries', async () => {
      const account = await accountService.createAccount();
      const userId = account.userId;
      const idempotencyKey = `idempotent_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      // Initial faucet grant with idempotencyKey
      const first = await economyService.grantFaucet({ userId, amount: 500, type: 'CHAPTER_REWARD', idempotencyKey });
      assert.equal(first.wallet.availableBalance, 500n);

      // Retry with same idempotencyKey throws DuplicateLedgerIdempotencyError
      await assert.rejects(
        economyService.grantFaucet({ userId, amount: 500, type: 'CHAPTER_REWARD', idempotencyKey }),
        DuplicateLedgerIdempotencyError
      );

      // Verify wallet available balance is still 500n (no duplicate credit)
      const wallet = await economyService.getWallet(userId);
      assert.equal(wallet.availableBalance, 500n);

      // Verify only 1 ledger entry exists for this user and idempotencyKey
      const ledgerRes = await pool.query(
        `SELECT count(*)::int AS count FROM public.v2_ledger_entries WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey]
      );
      assert.equal(ledgerRes.rows[0].count, 1);
    });

    await t.test('P2P Transfer conserves value (sum of deltas = 0) and creates double-entry ledger records', async () => {
      const sender = await accountService.createAccount();
      const recipient = await accountService.createAccount();

      await economyService.grantFaucet({ userId: sender.userId, amount: 2000, type: 'CHAPTER_REWARD' });

      const xferRes = await economyService.transferP2P({
        senderId: sender.userId,
        recipientId: recipient.userId,
        amount: 800,
        type: 'CARD_SETTLEMENT',
      });

      assert.equal(xferRes.senderWallet.availableBalance, 1200n);
      assert.equal(xferRes.recipientWallet.availableBalance, 800n);
      assert.equal(xferRes.ledgerEntries.length, 2);

      const [senderEntry, recipientEntry] = xferRes.ledgerEntries;
      assert.equal(senderEntry.amount, -800n);
      assert.equal(recipientEntry.amount, 800n);
      assert.equal(senderEntry.amount + recipientEntry.amount, 0n); // Value Conservation Guaranteed!
      assert.equal(senderEntry.counterparty, recipient.userId);
      assert.equal(recipientEntry.counterparty, sender.userId);
    });

    await t.test('Complete Hold lifecycle: CREATED -> ACTIVE -> RELEASED or CAPTURED with coherent accounting & durable idempotency', async () => {
      const account = await accountService.createAccount();
      const userId = account.userId;
      await economyService.grantFaucet({ userId, amount: 3000, type: 'CHAPTER_REWARD' });

      // 1. CREATE HOLD (CREATED state)
      const hold = await economyService.createHold({
        userId,
        amount: 1000,
        purpose: 'CARD_MATCH',
        reference: 'match_123',
      });
      assert.equal(hold.status, 'CREATED');

      // Available balance is still 3000 (not locked yet)
      let w1 = await economyService.getWallet(userId);
      assert.equal(w1.availableBalance, 3000n);
      assert.equal(w1.lockedBalance, 0n);

      // 2. ACTIVATE HOLD (CREATED -> ACTIVE)
      // Internal lock shift: total value 3000n unchanged, ledger amount = 0n
      const activeRes = await economyService.activateHold({ holdId: hold.holdId, userId });
      assert.equal(activeRes.hold.status, 'ACTIVE');
      assert.equal(activeRes.wallet.availableBalance, 2000n);
      assert.equal(activeRes.wallet.lockedBalance, 1000n);
      assert.equal(activeRes.ledgerEntry.amount, 0n); // Total wallet value conserved!
      assert.equal(activeRes.ledgerEntry.balanceAfter, 3000n);
      assert.equal(activeRes.ledgerEntry.metadata.newAvailable, '2000');
      assert.equal(activeRes.ledgerEntry.metadata.newLocked, '1000');

      // Retry activation idempotently (returns active state without duplicate ledger or balance shifts)
      const retryActive = await economyService.activateHold({ holdId: hold.holdId, userId });
      assert.equal(retryActive.hold.status, 'ACTIVE');
      assert.equal(retryActive.wallet.availableBalance, 2000n);

      // 3a. RELEASE HOLD (ACTIVE -> RELEASED)
      // Internal unlock shift: total value 3000n unchanged, ledger amount = 0n
      const releaseRes = await economyService.releaseHold({ holdId: hold.holdId, userId });
      assert.equal(releaseRes.hold.status, 'RELEASED');
      assert.equal(releaseRes.wallet.availableBalance, 3000n);
      assert.equal(releaseRes.wallet.lockedBalance, 0n);
      assert.equal(releaseRes.ledgerEntry.amount, 0n); // Total wallet value conserved!
      assert.equal(releaseRes.ledgerEntry.balanceAfter, 3000n);

      // Retry release idempotently
      const retryRelease = await economyService.releaseHold({ holdId: hold.holdId, userId });
      assert.equal(retryRelease.hold.status, 'RELEASED');

      // 3b. CAPTURE HOLD Lifecycle (CREATED -> ACTIVE -> CAPTURED with payout to target)
      const hold2 = await economyService.createHold({ userId, amount: 500, purpose: 'EMPLOYMENT_WAGE' });
      await economyService.activateHold({ holdId: hold2.holdId, userId });

      const targetAccount = await accountService.createAccount();
      const captureRes = await economyService.captureHold({
        holdId: hold2.holdId,
        userId,
        targetUserId: targetAccount.userId,
      });

      assert.equal(captureRes.hold.status, 'CAPTURED');
      assert.equal(captureRes.wallet.availableBalance, 2500n);
      assert.equal(captureRes.wallet.lockedBalance, 0n);
      assert.equal(captureRes.targetWallet.availableBalance, 500n);

      // Value Conservation across source and target in capture transfer:
      const [sourceEntry, targetEntry] = captureRes.ledgerEntries;
      assert.equal(sourceEntry.amount, -500n);
      assert.equal(targetEntry.amount, 500n);
      assert.equal(sourceEntry.amount + targetEntry.amount, 0n); // Exact value conservation!

      // Retry capture idempotently
      const retryCapture = await economyService.captureHold({
        holdId: hold2.holdId,
        userId,
        targetUserId: targetAccount.userId,
      });
      assert.equal(retryCapture.hold.status, 'CAPTURED');
    });

    await t.test('Atomic rollback leaves zero partial wallet, ledger, or hold state on failure', async () => {
      const account = await accountService.createAccount();
      const userId = account.userId;
      await economyService.grantFaucet({ userId, amount: 1500, type: 'CHAPTER_REWARD' });

      await assert.rejects(
        pgDriver.withTransaction(async (tx) => {
          const hold = await economyService.createHold({ userId, amount: 500, purpose: 'COURT_ESCROW' }, tx);
          await economyService.activateHold({ holdId: hold.holdId, userId }, tx);
          throw new Error('Forced M3 transaction rollback');
        }),
        /Forced M3 transaction rollback/
      );

      // Verify wallet balance restored to 1500 available, 0 locked
      const wallet = await economyService.getWallet(userId);
      assert.equal(wallet.availableBalance, 1500n);
      assert.equal(wallet.lockedBalance, 0n);

      // Verify no holds or extra ledger entries persisted
      const holdsRes = await pool.query(`SELECT count(*)::int AS count FROM public.v2_holds WHERE user_id = $1`, [userId]);
      assert.equal(holdsRes.rows[0].count, 0);

      const ledgerRes = await pool.query(
        `SELECT count(*)::int AS count FROM public.v2_ledger_entries WHERE user_id = $1 AND type = 'hold.activate'`,
        [userId]
      );
      assert.equal(ledgerRes.rows[0].count, 0);
    });
  } finally {
    await pgDriver.close();
  }
});
