import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AccountService,
  ACCOUNT_STATES,
  AccountNotFoundError,
} from '../domains/identity/index.js';

class MemoryAccountDriver {
  constructor() {
    this.accounts = new Map();
    this.outboxEvents = [];
  }

  async withTransaction(workFn) {
    const stagedOutboxEvents = [];
    const tx = {
      accounts: {
        create: async ({ state = 'ACTIVE' } = {}) => {
          const userId = randomUUID();
          const now = new Date().toISOString();
          const account = { userId, state, createdAt: now, updatedAt: now };
          this.accounts.set(userId, account);
          return account;
        },
        getById: async (userId) => {
          return this.accounts.get(userId) || null;
        },
      },
      outbox: {
        record: (domainEvent) => {
          stagedOutboxEvents.push(domainEvent);
        },
      },
    };

    const result = await workFn(tx);
    this.outboxEvents.push(...stagedOutboxEvents);
    return result;
  }
}

test('Account Unit Test 1: Account creation returns/persists immutable UUID user_id & ACTIVE state', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account = await service.createAccount({ state: ACCOUNT_STATES.ACTIVE });
  assert.ok(account.userId, 'Account must have a user_id');
  assert.match(
    account.userId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'user_id must be standard UUID'
  );
  assert.equal(account.state, 'ACTIVE');

  const retrieved = await service.getAccountById(account.userId);
  assert.equal(retrieved.userId, account.userId);
  assert.equal(retrieved.state, 'ACTIVE');

  assert.equal(driver.outboxEvents.length, 1);
  assert.equal(driver.outboxEvents[0].eventType, 'identity.account_created');
  assert.equal(driver.outboxEvents[0].payload.userId, account.userId);
});

test('Account Unit Test 2: Invalid account state throws error', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  await assert.rejects(async () => {
    await service.createAccount({ state: 'SUPER_ADMIN_STATE' });
  }, /Invalid account state/);
});

test('Account Unit Test 3: Account states support ACTIVE, SUSPENDED, DISABLED', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const activeAccount = await service.createAccount({ state: ACCOUNT_STATES.ACTIVE });
  assert.equal(activeAccount.state, 'ACTIVE');

  const suspendedAccount = await service.createAccount({ state: ACCOUNT_STATES.SUSPENDED });
  assert.equal(suspendedAccount.state, 'SUSPENDED');

  const disabledAccount = await service.createAccount({ state: ACCOUNT_STATES.DISABLED });
  assert.equal(disabledAccount.state, 'DISABLED');
});

test('Account Unit Test 4: Account lookup by unknown ID returns null', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const nonExistent = await service.getAccountById(randomUUID());
  assert.equal(nonExistent, null);
});
