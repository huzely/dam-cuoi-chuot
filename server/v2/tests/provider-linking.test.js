import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AccountService,
  TrustedPrincipal,
  ProviderAssertion,
  TestProviderVerifier,
  SUPPORTED_PROVIDERS,
  ACCOUNT_STATES,
  UnsupportedProviderError,
  InvalidProviderSubjectError,
  AccountNotFoundError,
  DuplicateProviderIdentityError,
  InvalidTrustedPrincipalError,
  InvalidProviderAssertionError,
  ProviderVerificationRequiredError,
  PROVIDER_IDENTITY_UNIQUE_CONSTRAINT,
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

test('Provider Linking Test 1: Trusted principal links verified provider assertion to account', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account = await service.createAccount();
  const principal = new TrustedPrincipal({ userId: account.userId, state: account.state });
  const assertion = new ProviderAssertion({
    provider: 'GOOGLE',
    providerSubject: 'g_sub_1001',
    metadata: { email: 'user@example.com' },
  });

  const link = await service.linkProviderForPrincipal({ principal, providerAssertion: assertion });
  assert.equal(link.userId, account.userId);
  assert.equal(link.provider, 'GOOGLE');
  assert.equal(link.providerSubject, 'g_sub_1001');

  const resolved = await service.resolveProviderIdentity('GOOGLE', 'g_sub_1001');
  assert.equal(resolved.userId, account.userId);
});

test('Provider Linking Test 2: Invalid or missing trusted principal fails with InvalidTrustedPrincipalError', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const assertion = new ProviderAssertion({
    provider: 'FACEBOOK',
    providerSubject: 'fb_123',
  });

  // Null principal
  await assert.rejects(async () => {
    await service.linkProviderForPrincipal({ principal: null, providerAssertion: assertion });
  }, InvalidTrustedPrincipalError);

  // Raw plain object pretending to be principal
  await assert.rejects(async () => {
    await service.linkProviderForPrincipal({
      principal: { userId: randomUUID(), state: 'ACTIVE' },
      providerAssertion: assertion,
    });
  }, InvalidTrustedPrincipalError);
});

test('Provider Linking Test 3: Invalid or unverified provider assertion fails with InvalidProviderAssertionError', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account = await service.createAccount();
  const principal = new TrustedPrincipal({ userId: account.userId });

  // Null assertion
  await assert.rejects(async () => {
    await service.linkProviderForPrincipal({ principal, providerAssertion: null });
  }, InvalidProviderAssertionError);

  // Raw unverified assertion object
  await assert.rejects(async () => {
    await service.linkProviderForPrincipal({
      principal,
      providerAssertion: { provider: 'GOOGLE', providerSubject: '123', isVerified: false },
    });
  }, InvalidProviderAssertionError);
});

test('Provider Linking Test 4: Supported providers GOOGLE, FACEBOOK, THREADS accepted', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account = await service.createAccount();
  const principal = new TrustedPrincipal({ userId: account.userId });

  for (const provider of ['GOOGLE', 'FACEBOOK', 'THREADS']) {
    const assertion = new ProviderAssertion({
      provider,
      providerSubject: `sub_${provider.toLowerCase()}`,
    });
    const link = await service.linkProviderForPrincipal({ principal, providerAssertion: assertion });
    assert.equal(link.provider, provider);
  }
});

test('Provider Linking Test 5: Unknown provider rejected with UnsupportedProviderError', () => {
  assert.throws(() => {
    new ProviderAssertion({
      provider: 'UNSUPPORTED_OAUTH',
      providerSubject: 'sub_999',
    });
  }, UnsupportedProviderError);
});

test('Provider Linking Test 6: Same identity + same account returns deterministic success', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account = await service.createAccount();
  const principal = new TrustedPrincipal({ userId: account.userId });
  const assertion = new ProviderAssertion({
    provider: 'GOOGLE',
    providerSubject: 'g_relink_101',
  });

  const link1 = await service.linkProviderForPrincipal({ principal, providerAssertion: assertion });
  const link2 = await service.linkProviderForPrincipal({ principal, providerAssertion: assertion });

  assert.equal(link1.userId, link2.userId);
  assert.equal(link1.providerSubject, link2.providerSubject);
});

test('Provider Linking Test 7: No duplicate provider_linked outbox event on no-op re-link', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account = await service.createAccount();
  const principal = new TrustedPrincipal({ userId: account.userId });
  const assertion = new ProviderAssertion({
    provider: 'THREADS',
    providerSubject: 't_outbox_test',
  });

  const initialOutboxCount = driver.outboxEvents.length; // 1 from createAccount

  await service.linkProviderForPrincipal({ principal, providerAssertion: assertion });
  assert.equal(driver.outboxEvents.length, initialOutboxCount + 1);

  await service.linkProviderForPrincipal({ principal, providerAssertion: assertion });
  assert.equal(driver.outboxEvents.length, initialOutboxCount + 1, 'No duplicate outbox event emitted on no-op re-link');
});

test('Provider Linking Test 8: Same provider identity cannot be linked to another account', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const acc1 = await service.createAccount();
  const acc2 = await service.createAccount();

  const princ1 = new TrustedPrincipal({ userId: acc1.userId });
  const princ2 = new TrustedPrincipal({ userId: acc2.userId });

  const assertion = new ProviderAssertion({
    provider: 'FACEBOOK',
    providerSubject: 'fb_conflict_999',
  });

  await service.linkProviderForPrincipal({ principal: princ1, providerAssertion: assertion });

  await assert.rejects(async () => {
    await service.linkProviderForPrincipal({ principal: princ2, providerAssertion: assertion });
  }, DuplicateProviderIdentityError);
});

test('Provider Linking Test 9: Same subject under different providers remains valid', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const acc1 = await service.createAccount();
  const acc2 = await service.createAccount();

  const linkG = await service.linkProviderForPrincipal({
    principal: new TrustedPrincipal({ userId: acc1.userId }),
    providerAssertion: new ProviderAssertion({ provider: 'GOOGLE', providerSubject: 'shared_id_100' }),
  });

  const linkF = await service.linkProviderForPrincipal({
    principal: new TrustedPrincipal({ userId: acc2.userId }),
    providerAssertion: new ProviderAssertion({ provider: 'FACEBOOK', providerSubject: 'shared_id_100' }),
  });

  assert.notEqual(linkG.userId, linkF.userId);
  assert.equal(linkG.provider, 'GOOGLE');
  assert.equal(linkF.provider, 'FACEBOOK');
});

test('Provider Linking Test 10: Email/profile metadata cannot cause account merge', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const acc1 = await service.createAccount();
  const acc2 = await service.createAccount();

  // Two different accounts with identical email metadata in provider assertions
  await service.linkProviderForPrincipal({
    principal: new TrustedPrincipal({ userId: acc1.userId }),
    providerAssertion: new ProviderAssertion({ provider: 'GOOGLE', providerSubject: 'g_user_1', metadata: { email: 'same@example.com' } }),
  });

  await service.linkProviderForPrincipal({
    principal: new TrustedPrincipal({ userId: acc2.userId }),
    providerAssertion: new ProviderAssertion({ provider: 'FACEBOOK', providerSubject: 'fb_user_2', metadata: { email: 'same@example.com' } }),
  });

  // Accounts remain completely separate
  const res1 = await service.getAccountById(acc1.userId);
  const res2 = await service.getAccountById(acc2.userId);

  assert.notEqual(res1.userId, res2.userId);
});

test('Provider Linking Test 11: SUSPENDED or DISABLED account state blocks provider linking', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });

  const account = await service.createAccount({ state: 'SUSPENDED' });

  // Creating principal with non-active state throws InvalidTrustedPrincipalError
  assert.throws(() => {
    new TrustedPrincipal({ userId: account.userId, state: 'SUSPENDED' });
  }, InvalidTrustedPrincipalError);

  // Attempting to bypass by passing active state on stale principal fails during DB check
  const fakeActivePrincipal = new TrustedPrincipal({ userId: account.userId, state: 'ACTIVE' });
  const assertion = new ProviderAssertion({ provider: 'GOOGLE', providerSubject: 'g_suspended_test' });

  await assert.rejects(async () => {
    await service.linkProviderForPrincipal({ principal: fakeActivePrincipal, providerAssertion: assertion });
  }, InvalidTrustedPrincipalError);
});

test('Provider Verifier Port Test 1: TestProviderVerifier verifies valid token into ProviderAssertion', async () => {
  const verifier = new TestProviderVerifier();
  verifier.registerCredential('valid_fb_token_100', {
    provider: 'FACEBOOK',
    providerSubject: 'fb_subject_777',
    metadata: { name: 'Test User' },
  });

  const assertion = await verifier.verifyCredential({ provider: 'FACEBOOK', credential: 'valid_fb_token_100' });
  assert.ok(assertion instanceof ProviderAssertion);
  assert.equal(assertion.provider, 'FACEBOOK');
  assert.equal(assertion.providerSubject, 'fb_subject_777');
  assert.equal(assertion.isVerified, true);
});

test('Provider Verifier Port Test 2: verifyAndLinkProvider pipeline verifies token and links provider', async () => {
  const driver = new MemoryAccountDriver();
  const service = new AccountService({ pgDriver: driver });
  const verifier = new TestProviderVerifier();

  const account = await service.createAccount();
  const principal = new TrustedPrincipal({ userId: account.userId });

  const link = await service.verifyAndLinkProvider({
    principal,
    provider: 'THREADS',
    credential: 'test_token_THREADS_threads_user_555',
    verifier,
  });

  assert.equal(link.userId, account.userId);
  assert.equal(link.provider, 'THREADS');
  assert.equal(link.providerSubject, 'threads_user_555');
});

test('Provider Verifier Port Test 3: Invalid or missing credential fails with ProviderVerificationRequiredError', async () => {
  const verifier = new TestProviderVerifier();

  await assert.rejects(async () => {
    await verifier.verifyCredential({ provider: 'GOOGLE', credential: '' });
  }, ProviderVerificationRequiredError);

  await assert.rejects(async () => {
    await verifier.verifyCredential({ provider: 'GOOGLE', credential: 'invalid_fake_token' });
  }, ProviderVerificationRequiredError);
});
