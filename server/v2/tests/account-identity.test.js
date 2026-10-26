import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AccountService,
  SUPPORTED_PROVIDERS,
  ACCOUNT_STATES,
  PROVIDER_IDENTITY_UNIQUE_CONSTRAINT,
  UnsupportedProviderError,
  InvalidProviderSubjectError,
  AccountNotFoundError,
  DuplicateProviderIdentityError,
  validateAndNormalizeProvider,
  validateProviderSubject,
} from '../domains/identity/index.js';

class MemoryAccountDriver {
  constructor() {
    this.accounts = new Map();
    this.providerIdentities = new Map();
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
      providerIdentities: {
        link: async ({ provider, providerSubject, userId }) => {
          const key = `${provider}:${providerSubject}`;
          if (this.providerIdentities.has(key)) {
            const err = new Error(`Unique constraint violation for key ${key}`);
            err.code = '23505';
            err.constraint = PROVIDER_IDENTITY_UNIQUE_CONSTRAINT;
            throw err;
          }
          const now = new Date().toISOString();
          const identity = { provider, providerSubject, userId, createdAt: now, linkedAt: now };
          this.providerIdentities.set(key, identity);
          return identity;
        },
        resolve: async (provider, providerSubject) => {
          const key = `${provider}:${providerSubject}`;
          return this.providerIdentities.get(key) || null;
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

test('Provider Registry Scan 1: Supported provider validation and uppercase normalization', () => {
  assert.equal(validateAndNormalizeProvider('google'), 'GOOGLE');
  assert.equal(validateAndNormalizeProvider('FACEBOOK'), 'FACEBOOK');
  assert.equal(validateAndNormalizeProvider('Threads'), 'THREADS');
});

test('Provider Registry Scan 2: Unknown or empty provider fails closed with UnsupportedProviderError', () => {
  assert.throws(() => validateAndNormalizeProvider('TWITTER'), UnsupportedProviderError);
  assert.throws(() => validateAndNormalizeProvider('TIKTOK'), UnsupportedProviderError);
  assert.throws(() => validateAndNormalizeProvider(''), UnsupportedProviderError);
  assert.throws(() => validateAndNormalizeProvider(null), UnsupportedProviderError);
});

test('Provider Subject Scan: Invalid or empty provider_subject fails with InvalidProviderSubjectError', () => {
  assert.throws(() => validateProviderSubject(''), InvalidProviderSubjectError);
  assert.throws(() => validateProviderSubject('   '), InvalidProviderSubjectError);
  assert.throws(() => validateProviderSubject(null), InvalidProviderSubjectError);
  assert.doesNotThrow(() => validateProviderSubject('user_123456_opaque'));
});

test('Link Provider Unit Test 1: Provider identity resolves to correct account', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account = await service.createAccount();
  const link = await service.linkProviderIdentity({
    userId: account.userId,
    provider: 'GOOGLE',
    providerSubject: 'sub_google_101',
  });

  assert.equal(link.userId, account.userId);
  assert.equal(link.provider, 'GOOGLE');
  assert.equal(link.providerSubject, 'sub_google_101');

  const resolved = await service.resolveProviderIdentity('google', 'sub_google_101');
  assert.ok(resolved);
  assert.equal(resolved.userId, account.userId);
});

test('Link Provider Unit Test 2: Same provider identity cannot belong to two accounts', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account1 = await service.createAccount();
  const account2 = await service.createAccount();

  await service.linkProviderIdentity({
    userId: account1.userId,
    provider: 'FACEBOOK',
    providerSubject: 'fb_user_999',
  });

  await assert.rejects(async () => {
    await service.linkProviderIdentity({
      userId: account2.userId,
      provider: 'FACEBOOK',
      providerSubject: 'fb_user_999',
    });
  }, DuplicateProviderIdentityError);
});

test('Link Provider Unit Test 3: Same provider_subject under different providers is allowed', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account1 = await service.createAccount();
  const account2 = await service.createAccount();

  const googleLink = await service.linkProviderIdentity({
    userId: account1.userId,
    provider: 'GOOGLE',
    providerSubject: 'sub_123',
  });

  const facebookLink = await service.linkProviderIdentity({
    userId: account2.userId,
    provider: 'FACEBOOK',
    providerSubject: 'sub_123',
  });

  assert.equal(googleLink.provider, 'GOOGLE');
  assert.equal(facebookLink.provider, 'FACEBOOK');
  assert.notEqual(googleLink.userId, facebookLink.userId);
});

test('Link Provider Unit Test 4: One account can own multiple provider identities', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account = await service.createAccount();

  await service.linkProviderIdentity({
    userId: account.userId,
    provider: 'GOOGLE',
    providerSubject: 'g_888',
  });

  await service.linkProviderIdentity({
    userId: account.userId,
    provider: 'THREADS',
    providerSubject: 't_888',
  });

  const resG = await service.resolveProviderIdentity('GOOGLE', 'g_888');
  const resT = await service.resolveProviderIdentity('THREADS', 't_888');

  assert.equal(resG.userId, account.userId);
  assert.equal(resT.userId, account.userId);
});

test('Link Provider Unit Test 5: Re-linking same provider identity to same account returns existing identity without duplicate outbox event', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account = await service.createAccount();
  const initialOutboxCount = driver.outboxEvents.length;

  const firstLink = await service.linkProviderIdentity({
    userId: account.userId,
    provider: 'GOOGLE',
    providerSubject: 'g_idem_100',
  });

  assert.equal(driver.outboxEvents.length, initialOutboxCount + 1);

  const secondLink = await service.linkProviderIdentity({
    userId: account.userId,
    provider: 'GOOGLE',
    providerSubject: 'g_idem_100',
  });

  assert.equal(secondLink.userId, firstLink.userId);
  assert.equal(secondLink.providerSubject, firstLink.providerSubject);
  assert.equal(driver.outboxEvents.length, initialOutboxCount + 1);
});

test('Link Provider Unit Test 6: Linking to non-existent account fails with AccountNotFoundError', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const nonExistentUserId = randomUUID();

  await assert.rejects(async () => {
    await service.linkProviderIdentity({
      userId: nonExistentUserId,
      provider: 'GOOGLE',
      providerSubject: 'g_sub_404',
    });
  }, AccountNotFoundError);
});

test('Strict 23505 Constraint Mapping Test A: Correct provider constraint 23505 maps to DuplicateProviderIdentityError', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account = await service.createAccount();

  const originalLink = driver.withTransaction;
  driver.withTransaction = async (workFn) => {
    return await originalLink.call(driver, async (tx) => {
      tx.providerIdentities.link = async () => {
        const pgErr = new Error('duplicate key value violates unique constraint "uq_v2_provider_identities_provider_subject"');
        pgErr.code = '23505';
        pgErr.constraint = PROVIDER_IDENTITY_UNIQUE_CONSTRAINT;
        throw pgErr;
      };
      return await workFn(tx);
    });
  };

  await assert.rejects(async () => {
    await service.linkProviderIdentity({
      userId: account.userId,
      provider: 'GOOGLE',
      providerSubject: 'exact_constraint_sub',
    });
  }, DuplicateProviderIdentityError);
});

test('Strict 23505 Constraint Mapping Test B: Unrelated named 23505 does NOT map to DuplicateProviderIdentityError', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account = await service.createAccount();

  const originalLink = driver.withTransaction;
  driver.withTransaction = async (workFn) => {
    return await originalLink.call(driver, async (tx) => {
      tx.providerIdentities.link = async () => {
        const pgErr = new Error('duplicate key value violates unique constraint "unrelated_other_table_key"');
        pgErr.code = '23505';
        pgErr.constraint = 'unrelated_other_table_key';
        throw pgErr;
      };
      return await workFn(tx);
    });
  };

  await assert.rejects(async () => {
    await service.linkProviderIdentity({
      userId: account.userId,
      provider: 'GOOGLE',
      providerSubject: 'unrelated_sub',
    });
  }, (err) => {
    assert.equal(err instanceof DuplicateProviderIdentityError, false, 'Must NOT be DuplicateProviderIdentityError');
    assert.equal(err.code, '23505');
    assert.equal(err.constraint, 'unrelated_other_table_key');
    return true;
  });
});

test('Strict 23505 Constraint Mapping Test C: 23505 with missing constraint name does NOT map to DuplicateProviderIdentityError', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account = await service.createAccount();

  const originalLink = driver.withTransaction;
  driver.withTransaction = async (workFn) => {
    return await originalLink.call(driver, async (tx) => {
      tx.providerIdentities.link = async () => {
        const pgErr = new Error('duplicate key value violates unique constraint with null constraint field');
        pgErr.code = '23505';
        pgErr.constraint = undefined;
        throw pgErr;
      };
      return await workFn(tx);
    });
  };

  await assert.rejects(async () => {
    await service.linkProviderIdentity({
      userId: account.userId,
      provider: 'GOOGLE',
      providerSubject: 'missing_constraint_sub',
    });
  }, (err) => {
    assert.equal(err instanceof DuplicateProviderIdentityError, false, 'Must NOT be DuplicateProviderIdentityError');
    assert.equal(err.code, '23505');
    return true;
  });
});
