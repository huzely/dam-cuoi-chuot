import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  AccountService,
  ACCOUNT_STATES,
  PROVIDER_IDENTITY_UNIQUE_CONSTRAINT,
  UnsupportedProviderError,
  DuplicateProviderIdentityError,
  InvalidAccountStateError,
  InvalidProviderAssertionError,
  MockProviderVerifier,
  HttpProviderVerifier,
  handleLinkProviderIdentityCommand,
  validateAndNormalizeProvider,
} from '../domains/identity/index.js';
import { createCommand } from '../core/command.js';

class MemoryDriver {
  constructor() {
    this.accounts = new Map();
    this.identities = new Map();
    this.outboxEvents = [];
  }

  async withTransaction(workFn) {
    const staged = [];
    const tx = {
      accounts: {
        create: async ({ state = 'ACTIVE' } = {}) => {
          const now = new Date().toISOString();
          const account = { userId: randomUUID(), state, createdAt: now, updatedAt: now };
          this.accounts.set(account.userId, account);
          return account;
        },
        getById: async (userId) => this.accounts.get(userId) || null,
      },
      providerIdentities: {
        resolve: async (provider, providerSubject) => this.identities.get(`${provider}:${providerSubject}`) || null,
        link: async ({ provider, providerSubject, userId }) => {
          const key = `${provider}:${providerSubject}`;
          if (this.identities.has(key)) {
            const err = new Error('duplicate provider identity');
            err.code = '23505';
            err.constraint = PROVIDER_IDENTITY_UNIQUE_CONSTRAINT;
            throw err;
          }
          const now = new Date().toISOString();
          const identity = { provider, providerSubject, userId, createdAt: now, linkedAt: now };
          this.identities.set(key, identity);
          return identity;
        },
      },
      outbox: { record: (event) => staged.push(event) },
    };

    const result = await workFn(tx);
    this.outboxEvents.push(...staged);
    return result;
  }
}

test('M2.2 provider registry normalizes supported providers and fails closed', () => {
  assert.equal(validateAndNormalizeProvider('google'), 'GOOGLE');
  assert.equal(validateAndNormalizeProvider(' Facebook '), 'FACEBOOK');
  assert.equal(validateAndNormalizeProvider('threads'), 'THREADS');
  assert.throws(() => validateAndNormalizeProvider('twitter'), UnsupportedProviderError);
  assert.throws(() => validateAndNormalizeProvider(''), UnsupportedProviderError);
});

test('M2.2 verified ProviderAssertion links only the TrustedPrincipal actor', async () => {
  const driver = new MemoryDriver();
  const service = new AccountService({ pgDriver: driver });
  const verifier = new MockProviderVerifier();
  const account = await service.createAccount();
  verifier.registerToken('trusted-token', 'GOOGLE', 'trusted-subject');

  const command = createCommand({
    type: 'identity.link_provider_identity',
    actor: { actorId: account.userId },
    payload: { providerAssertion: { provider: 'google', assertionToken: 'trusted-token' } },
  });

  const result = await handleLinkProviderIdentityCommand({ command, accountService: service, providerVerifier: verifier });
  assert.equal(result.userId, account.userId);
  assert.equal(result.provider, 'GOOGLE');
  assert.equal(result.providerSubject, 'trusted-subject');
});

test('M2.2 rejects untrusted identity injection in command payload', async () => {
  const driver = new MemoryDriver();
  const service = new AccountService({ pgDriver: driver });
  const verifier = new MockProviderVerifier();
  const account = await service.createAccount();

  const malicious = {
    type: 'identity.link_provider_identity',
    actor: { actorId: account.userId },
    payload: {
      userId: randomUUID(),
      actorId: randomUUID(),
      providerSubject: 'client-controlled',
      providerAssertion: { provider: 'GOOGLE', assertionToken: 'valid:GOOGLE:verified' },
    },
  };

  await assert.rejects(
    handleLinkProviderIdentityCommand({ command: malicious, accountService: service, providerVerifier: verifier }),
    /Security Error: Client command payload must not supply userId, actorId, or providerSubject directly/
  );
});

test('M2.2 rejects unverified provider assertions', async () => {
  const driver = new MemoryDriver();
  const service = new AccountService({ pgDriver: driver });
  const verifier = new MockProviderVerifier();
  const account = await service.createAccount();

  await assert.rejects(
    service.linkProviderIdentityWithAssertion({
      trustedPrincipal: { actorId: account.userId },
      providerAssertion: { provider: 'GOOGLE', assertionToken: 'not-verified' },
      providerVerifier: verifier,
    }),
    InvalidProviderAssertionError
  );
});

test('M2.2 SUSPENDED and DISABLED accounts cannot link providers', async () => {
  const driver = new MemoryDriver();
  const service = new AccountService({ pgDriver: driver });
  for (const state of [ACCOUNT_STATES.SUSPENDED, ACCOUNT_STATES.DISABLED]) {
    const account = await service.createAccount({ state });
    await assert.rejects(
      service.linkProviderIdentity({ userId: account.userId, provider: 'GOOGLE', providerSubject: `blocked-${state}` }),
      InvalidAccountStateError
    );
  }
});

test('M2.2 same-account relink is idempotent and emits no duplicate provider_linked outbox event', async () => {
  const driver = new MemoryDriver();
  const service = new AccountService({ pgDriver: driver });
  const account = await service.createAccount();
  const initial = driver.outboxEvents.length;

  const first = await service.linkProviderIdentity({ userId: account.userId, provider: 'GOOGLE', providerSubject: 'same-subject' });
  const second = await service.linkProviderIdentity({ userId: account.userId, provider: 'google', providerSubject: 'same-subject' });

  assert.equal(second.userId, first.userId);
  assert.equal(driver.outboxEvents.length, initial + 1);
  assert.equal(driver.outboxEvents.at(-1).eventType, 'identity.provider_linked');
});

test('M2.2 cross-account provider identity ownership is unique', async () => {
  const driver = new MemoryDriver();
  const service = new AccountService({ pgDriver: driver });
  const first = await service.createAccount();
  const second = await service.createAccount();
  await service.linkProviderIdentity({ userId: first.userId, provider: 'FACEBOOK', providerSubject: 'unique-subject' });
  await assert.rejects(
    service.linkProviderIdentity({ userId: second.userId, provider: 'FACEBOOK', providerSubject: 'unique-subject' }),
    DuplicateProviderIdentityError
  );
});

test('M2.2 maps PostgreSQL 23505 only for the exact provider identity constraint', async () => {
  const makeDriver = (constraint) => {
    const driver = new MemoryDriver();
    driver.withTransaction = async (workFn) => {
      const accountId = [...driver.accounts.keys()][0];
      const tx = {
        accounts: { getById: async () => driver.accounts.get(accountId) },
        providerIdentities: {
          resolve: async () => null,
          link: async () => {
            const err = new Error('forced 23505');
            err.code = '23505';
            err.constraint = constraint;
            throw err;
          },
        },
        outbox: { record: () => {} },
      };
      return workFn(tx);
    };
    return driver;
  };

  const exactDriver = makeDriver(PROVIDER_IDENTITY_UNIQUE_CONSTRAINT);
  const exactService = new AccountService({ pgDriver: exactDriver });
  const exactAccount = { userId: randomUUID(), state: 'ACTIVE' };
  exactDriver.accounts.set(exactAccount.userId, exactAccount);
  await assert.rejects(
    exactService.linkProviderIdentity({ userId: exactAccount.userId, provider: 'GOOGLE', providerSubject: 'race-a' }),
    DuplicateProviderIdentityError
  );

  const otherDriver = makeDriver('some_other_unique_constraint');
  const otherService = new AccountService({ pgDriver: otherDriver });
  const otherAccount = { userId: randomUUID(), state: 'ACTIVE' };
  otherDriver.accounts.set(otherAccount.userId, otherAccount);
  await assert.rejects(
    otherService.linkProviderIdentity({ userId: otherAccount.userId, provider: 'GOOGLE', providerSubject: 'race-b' }),
    (err) => err.code === '23505' && err.constraint === 'some_other_unique_constraint' && !(err instanceof DuplicateProviderIdentityError)
  );
});

test('HttpProviderVerifier verifies Google, Facebook, Threads assertions and fails closed on invalid credentials', async () => {
  // 1. Missing configured client IDs / app secrets fails closed
  const unconfiguredVerifier = new HttpProviderVerifier({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await assert.rejects(
    unconfiguredVerifier.verifyAssertion({ provider: 'GOOGLE', assertionToken: 'tok123' }),
    InvalidProviderAssertionError
  );
  await assert.rejects(
    unconfiguredVerifier.verifyAssertion({ provider: 'FACEBOOK', assertionToken: 'tok123' }),
    InvalidProviderAssertionError
  );
  await assert.rejects(
    unconfiguredVerifier.verifyAssertion({ provider: 'THREADS', assertionToken: 'tok123' }),
    InvalidProviderAssertionError
  );

  // 2. Google verification success and audience mismatch rejection
  const googleVerifier = new HttpProviderVerifier({
    googleClientId: 'expected-google-client-id',
    fetchImpl: async (url) => {
      if (url.includes('id_token=valid-google-token')) {
        return {
          ok: true,
          json: async () => ({
            aud: 'expected-google-client-id',
            iss: 'https://accounts.google.com',
            sub: 'google-user-sub-123',
          }),
        };
      }
      if (url.includes('id_token=wrong-aud-token')) {
        return {
          ok: true,
          json: async () => ({
            aud: 'forged-client-id',
            iss: 'https://accounts.google.com',
            sub: 'google-user-sub-456',
          }),
        };
      }
      return { ok: false };
    },
  });

  const validGoogle = await googleVerifier.verifyAssertion({ provider: 'GOOGLE', assertionToken: 'valid-google-token' });
  assert.equal(validGoogle.provider, 'GOOGLE');
  assert.equal(validGoogle.providerSubject, 'google-user-sub-123');

  await assert.rejects(
    googleVerifier.verifyAssertion({ provider: 'GOOGLE', assertionToken: 'wrong-aud-token' }),
    InvalidProviderAssertionError
  );

  // 3. Facebook verification success and app_id mismatch rejection
  const facebookVerifier = new HttpProviderVerifier({
    facebookAppId: 'expected-fb-app-id',
    facebookAppAccessToken: 'valid-fb-app-token',
    fetchImpl: async (url) => {
      if (url.includes('input_token=valid-fb-token')) {
        return {
          ok: true,
          json: async () => ({
            data: { is_valid: true, app_id: 'expected-fb-app-id', user_id: 'fb-user-789' },
          }),
        };
      }
      return { ok: true, json: async () => ({ data: { is_valid: false } }) };
    },
  });

  const validFb = await facebookVerifier.verifyAssertion({ provider: 'FACEBOOK', assertionToken: 'valid-fb-token' });
  assert.equal(validFb.provider, 'FACEBOOK');
  assert.equal(validFb.providerSubject, 'fb-user-789');

  await assert.rejects(
    facebookVerifier.verifyAssertion({ provider: 'FACEBOOK', assertionToken: 'invalid-fb-token' }),
    InvalidProviderAssertionError
  );

  // 4. Threads verification querying graph.threads.net
  const threadsVerifier = new HttpProviderVerifier({
    threadsAppId: 'expected-threads-app-id',
    threadsAppAccessToken: 'valid-threads-app-token',
    fetchImpl: async (url) => {
      assert.ok(url.includes('graph.threads.net'), 'Threads verifier must query graph.threads.net');
      if (url.includes('access_token=valid-threads-token')) {
        return {
          ok: true,
          json: async () => ({ id: 'threads-user-101', username: 'threads_user' }),
        };
      }
      return { ok: false };
    },
  });

  const validThreads = await threadsVerifier.verifyAssertion({ provider: 'THREADS', assertionToken: 'valid-threads-token' });
  assert.equal(validThreads.provider, 'THREADS');
  assert.equal(validThreads.providerSubject, 'threads-user-101');
});
