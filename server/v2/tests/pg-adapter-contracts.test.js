import test from 'node:test';
import assert from 'node:assert/strict';
import { PgIdempotencyStore, computeCanonicalFingerprint } from '../adapters/pg-idempotency.js';
import { PgTransactionAdapter, PgUnitOfWork } from '../adapters/pg-transaction.js';
import { PgOutboxRecorder, PgOutboxPublisher } from '../adapters/pg-outbox.js';
import { PgConfigRepository } from '../adapters/pg-config.js';
import { PgFeatureFlagRepository, UnregisteredFlagError } from '../adapters/pg-feature-flags.js';
import { PgAdminAuditLogger } from '../adapters/pg-audit.js';
import { createCommand } from '../core/command.js';
import { createDomainEvent } from '../core/event.js';
import { CONFIG_CATEGORIES, UnresolvedConfigError } from '../core/config.js';
import { QTV_ROLES } from '../core/rbac.js';
import { IdempotencyMismatchError, ConcurrentExecutionError } from '../core/idempotency.js';

test('PgIdempotencyStore: scopes idempotency key to actor_id (different actors, same key string)', async () => {
  const store = new PgIdempotencyStore();

  const cmdActor1 = createCommand({
    type: 'festival.enter_booth',
    actor: { actorId: 'usr_alice' },
    idempotencyKey: 'shared_key_123',
    payload: { boothId: 'b_01' },
  });

  const cmdActor2 = createCommand({
    type: 'festival.enter_booth',
    actor: { actorId: 'usr_bob' },
    idempotencyKey: 'shared_key_123', // Same key string as Alice!
    payload: { boothId: 'b_02' },
  });

  // Alice claims key 'shared_key_123'
  const claimAlice = await store.claim('shared_key_123', cmdActor1);
  assert.equal(claimAlice.status, 'CLAIMED');
  await store.complete('usr_alice', 'shared_key_123', { ticket: 'alice_ticket' });

  // Bob claims key 'shared_key_123' independently without conflict
  const claimBob = await store.claim('shared_key_123', cmdActor2);
  assert.equal(claimBob.status, 'CLAIMED');
  await store.complete('usr_bob', 'shared_key_123', { ticket: 'bob_ticket' });
});

test('PgIdempotencyStore: canonical SHA-256 fingerprint mismatch throws IdempotencyMismatchError', async () => {
  const store = new PgIdempotencyStore();
  const actor = { actorId: 'usr_alice' };

  const cmdA = createCommand({
    type: 'festival.enter_booth',
    actor,
    idempotencyKey: 'idem_key_1',
    payload: { boothId: 'b_01', param: 'value_A' },
  });

  const cmdB = createCommand({
    type: 'festival.enter_booth',
    actor,
    idempotencyKey: 'idem_key_1',
    payload: { boothId: 'b_01', param: 'value_B' }, // Different payload fingerprint
  });

  await store.claim('idem_key_1', cmdA);
  await store.complete('usr_alice', 'idem_key_1', { result: 'A' });

  await assert.rejects(async () => {
    await store.claim('idem_key_1', cmdB);
  }, IdempotencyMismatchError);
});

test('PgIdempotencyStore: canonical SHA-256 fingerprint treats key ordering as identical', () => {
  const fp1 = computeCanonicalFingerprint('festival.enter_booth', { a: 1, b: 2 });
  const fp2 = computeCanonicalFingerprint('festival.enter_booth', { b: 2, a: 1 });
  assert.equal(fp1, fp2);
});

test('PgTransactionAdapter & PgUnitOfWork: state mutation + outbox atomicity contract', async () => {
  const tx = new PgTransactionAdapter();
  const outbox = new PgOutboxRecorder();
  const uow = new PgUnitOfWork(tx, outbox);

  const result = await uow.execute(async (activeTx, activeOutbox) => {
    await activeTx.recordMutation({ table: 'festival_visitors', action: 'INSERT' });
    activeOutbox.record(createDomainEvent({
      eventType: 'festival.booth_entered',
      aggregate: { type: 'festival_booth', id: 'b_99' },
    }));
    return { status: 'SUCCESS' };
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(tx.committed, true);
  assert.equal(tx.mutations.length, 1);
  assert.equal(tx.stagedOutboxEvents.length, 1);
  assert.equal(outbox.getCommittedOutboxRecords().length, 1);
  assert.equal(outbox.getCommittedOutboxRecords()[0].status, 'COMMITTED_IN_STORAGE');
});

test('PgOutboxPublisher: post-commit publication failure leaves state committed and record retryable', async () => {
  const outboxRecords = [{
    event: createDomainEvent({
      eventType: 'festival.booth_entered',
      aggregate: { type: 'booth', id: 'b_1' },
    }),
    status: 'COMMITTED_IN_STORAGE',
  }];

  const publisher = new PgOutboxPublisher(async () => {
    throw new Error('Message broker unreachable');
  });

  const pubResult = await publisher.publishCommitted(outboxRecords);

  assert.equal(pubResult.publishedEvents.length, 0);
  assert.equal(pubResult.publicationErrors.length, 1);
  assert.equal(outboxRecords[0].status, 'PUBLICATION_FAILED_RETRYABLE');
  assert.equal(outboxRecords[0].attemptCount, 1);
});

test('PgConfigRepository: loads approved ruleset and rejects TBD_FROM_DATA', async () => {
  const configRepo = new PgConfigRepository();

  // Save approved ruleset
  await configRepo.db.saveRuleset('2.0.0', 'APPROVED', {
    'BOOTH_FEE': { category: CONFIG_CATEGORIES.ECONOMY_CONFIG, value: 10 },
  });

  const snapshot = await configRepo.getRulesetSnapshot('2.0.0');
  assert.equal(snapshot.get('BOOTH_FEE'), 10);

  // Unapproved ruleset with TBD_FROM_DATA throws UnresolvedConfigError
  await configRepo.db.saveRuleset('2.1.0-draft', 'DRAFT', {
    'THEFT_FEE': { category: CONFIG_CATEGORIES.TBD_FROM_DATA, value: CONFIG_CATEGORIES.TBD_FROM_DATA },
  });

  await assert.rejects(async () => {
    await configRepo.getRulesetSnapshot('2.1.0-draft');
  }, UnresolvedConfigError);
});

test('PgFeatureFlagRepository: missing rows resolve safely to false; unregistered flags rejected', async () => {
  const flagsRepo = new PgFeatureFlagRepository();

  // Registered flag missing in database resolves safely to false (OFF)
  const enabled = await flagsRepo.isEnabled('HOI_XUAN_V2');
  assert.equal(enabled, false);

  // Unregistered flag name is strictly rejected
  await assert.rejects(async () => {
    await flagsRepo.isEnabled('UNREGISTERED_INVALID_FLAG');
  }, UnregisteredFlagError);
});

test('PgAdminAuditLogger: creates append-only audit record enforcing RBAC least privilege', async () => {
  const logger = new PgAdminAuditLogger();

  const auditRecord = await logger.logAuditEvent({
    adminActor: { actorId: 'admin_1', role: QTV_ROLES.ADMIN },
    action: 'admin.user.suspend',
    targetRef: { type: 'user', id: 'usr_spammer' },
    reason: 'Violated terms of service',
  });

  assert.equal(auditRecord.adminActorId, 'admin_1');
  assert.equal(auditRecord.action, 'admin.user.suspend');

  // Unauthorized action throws Error
  await assert.rejects(async () => {
    await logger.logAuditEvent({
      adminActor: { actorId: 'mod_1', role: QTV_ROLES.MODERATOR },
      action: 'admin.economy.propose_config',
    });
  }, /Permission Denied/);
});
