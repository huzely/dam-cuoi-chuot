import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PgIdempotencyStore,
  MemoryIdempotencyDriver,
  computeCanonicalFingerprint,
  MissingDatabaseDriverError,
} from '../adapters/pg-idempotency.js';
import {
  PgTransactionAdapter,
  PgUnitOfWork,
  MemoryTransactionDriver,
} from '../adapters/pg-transaction.js';
import {
  PgOutboxRecorder,
  PgOutboxPublisher,
  MemoryOutboxDriver,
} from '../adapters/pg-outbox.js';
import {
  PgConfigRepository,
  MemoryConfigDriver,
} from '../adapters/pg-config.js';
import {
  PgFeatureFlagRepository,
  MemoryFeatureFlagDriver,
  UnregisteredFlagError,
} from '../adapters/pg-feature-flags.js';
import {
  PgAdminAuditLogger,
  MemoryAuditDriver,
} from '../adapters/pg-audit.js';
import { createCommand } from '../core/command.js';
import { createDomainEvent } from '../core/event.js';
import { CONFIG_CATEGORIES, UnresolvedConfigError } from '../core/config.js';
import { QTV_ROLES } from '../core/rbac.js';
import { IdempotencyMismatchError } from '../core/idempotency.js';

test('Production Pg adapters fail fast with MissingDatabaseDriverError without explicit DB driver', () => {
  assert.throws(() => new PgIdempotencyStore(), MissingDatabaseDriverError);
  assert.throws(() => new PgTransactionAdapter(), MissingDatabaseDriverError);
  assert.throws(() => new PgOutboxPublisher(), MissingDatabaseDriverError);
  assert.throws(() => new PgConfigRepository(), MissingDatabaseDriverError);
  assert.throws(() => new PgFeatureFlagRepository(), MissingDatabaseDriverError);
  assert.throws(() => new PgAdminAuditLogger(), MissingDatabaseDriverError);
});

test('PgIdempotencyStore: scopes idempotency key to actor_id with explicitly injected MemoryIdempotencyDriver', async () => {
  const driver = new MemoryIdempotencyDriver();
  const store = new PgIdempotencyStore(driver);

  const cmdActor1 = createCommand({
    type: 'festival.enter_booth',
    actor: { actorId: 'usr_alice' },
    idempotencyKey: 'shared_key_123',
    payload: { boothId: 'b_01' },
  });

  const cmdActor2 = createCommand({
    type: 'festival.enter_booth',
    actor: { actorId: 'usr_bob' },
    idempotencyKey: 'shared_key_123',
    payload: { boothId: 'b_02' },
  });

  // Alice claims key
  const claimAlice = await store.claim('shared_key_123', cmdActor1);
  assert.equal(claimAlice.status, 'CLAIMED');
  await store.complete('usr_alice', 'shared_key_123', { ticket: 'alice_ticket' });

  // Bob claims key independently
  const claimBob = await store.claim('shared_key_123', cmdActor2);
  assert.equal(claimBob.status, 'CLAIMED');
  await store.complete('usr_bob', 'shared_key_123', { ticket: 'bob_ticket' });
});

test('PgIdempotencyStore: canonical SHA-256 fingerprint mismatch throws IdempotencyMismatchError', async () => {
  const driver = new MemoryIdempotencyDriver();
  const store = new PgIdempotencyStore(driver);
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
    payload: { boothId: 'b_01', param: 'value_B' },
  });

  await store.claim('idem_key_1', cmdA);
  await store.complete('usr_alice', 'idem_key_1', { result: 'A' });

  await assert.rejects(async () => {
    await store.claim('idem_key_1', cmdB);
  }, IdempotencyMismatchError);
});

test('PgTransactionAdapter & PgUnitOfWork: atomic state + outbox commit with explicitly injected driver', async () => {
  const txDriver = new MemoryTransactionDriver();
  const tx = new PgTransactionAdapter(txDriver);
  const outbox = new PgOutboxRecorder();
  const uow = new PgUnitOfWork(tx, outbox);

  const result = await uow.execute(async (activeTx, activeOutbox) => {
    activeOutbox.record(createDomainEvent({
      eventType: 'festival.booth_entered',
      aggregate: { type: 'festival_booth', id: 'b_99' },
    }));
    return { status: 'SUCCESS' };
  });

  assert.equal(result.status, 'SUCCESS');
  assert.equal(tx.committed, true);
  assert.equal(tx.stagedOutboxEvents.length, 1);
  assert.equal(outbox.getCommittedOutboxRecords().length, 1);
});

test('PgOutboxPublisher: persists PUBLISHED state durably via outbox driver on success', async () => {
  const outboxDriver = new MemoryOutboxDriver();
  const event = createDomainEvent({
    eventType: 'festival.booth_entered',
    aggregate: { type: 'booth', id: 'b_ok' },
  });

  await outboxDriver.insertOutboxRecord({
    event,
    status: 'COMMITTED_IN_STORAGE',
  });

  const publisher = new PgOutboxPublisher(outboxDriver, async () => {
    // Transport succeeds
  });

  const pubResult = await publisher.publishCommitted([{ event, status: 'COMMITTED_IN_STORAGE' }]);

  assert.equal(pubResult.publishedEvents.length, 1);
  assert.equal(pubResult.publicationErrors.length, 0);

  // Assert state is durably updated in outbox driver to PUBLISHED
  const persistedRecord = await outboxDriver.getOutboxRecord(event.eventId);
  assert.equal(persistedRecord.status, 'PUBLISHED');
  assert.ok(persistedRecord.publishedAt);
});

test('PgOutboxPublisher: persists PUBLICATION_FAILED_RETRYABLE status, attempt count & error on failure', async () => {
  const outboxDriver = new MemoryOutboxDriver();
  const event = createDomainEvent({
    eventType: 'festival.booth_entered',
    aggregate: { type: 'booth', id: 'b_fail' },
  });

  await outboxDriver.insertOutboxRecord({
    event,
    status: 'COMMITTED_IN_STORAGE',
    attemptCount: 0,
  });

  const publisher = new PgOutboxPublisher(outboxDriver, async () => {
    throw new Error('Message broker connection reset');
  });

  const pubResult = await publisher.publishCommitted([{ event, status: 'COMMITTED_IN_STORAGE', attemptCount: 0 }]);

  assert.equal(pubResult.publishedEvents.length, 0);
  assert.equal(pubResult.publicationErrors.length, 1);

  // Assert state is durably updated in outbox driver to PUBLICATION_FAILED_RETRYABLE
  const persistedRecord = await outboxDriver.getOutboxRecord(event.eventId);
  assert.equal(persistedRecord.status, 'PUBLICATION_FAILED_RETRYABLE');
  assert.equal(persistedRecord.attemptCount, 1);
  assert.equal(persistedRecord.lastError, 'Message broker connection reset');
});

test('PgConfigRepository: loads approved ruleset snapshot via injected driver', async () => {
  const configDriver = new MemoryConfigDriver();
  const configRepo = new PgConfigRepository(configDriver);

  await configDriver.saveRuleset('2.0.0', 'APPROVED', {
    'BOOTH_FEE': { category: CONFIG_CATEGORIES.ECONOMY_CONFIG, value: 10 },
  });

  const snapshot = await configRepo.getRulesetSnapshot('2.0.0');
  assert.equal(snapshot.get('BOOTH_FEE'), 10);
});

test('PgFeatureFlagRepository: resolves missing rows safely to false; rejects unregistered flags', async () => {
  const flagDriver = new MemoryFeatureFlagDriver();
  const flagsRepo = new PgFeatureFlagRepository(flagDriver);

  // Registered flag missing in database resolves safely to false (OFF)
  const enabled = await flagsRepo.isEnabled('HOI_XUAN_V2');
  assert.equal(enabled, false);

  // Unregistered flag name is strictly rejected
  await assert.rejects(async () => {
    await flagsRepo.isEnabled('UNREGISTERED_INVALID_FLAG');
  }, UnregisteredFlagError);
});

test('PgAdminAuditLogger: creates append-only audit record via injected audit driver', async () => {
  const auditDriver = new MemoryAuditDriver();
  const logger = new PgAdminAuditLogger(auditDriver);

  const auditRecord = await logger.logAuditEvent({
    adminActor: { actorId: 'admin_1', role: QTV_ROLES.ADMIN },
    action: 'admin.user.suspend',
    targetRef: { type: 'user', id: 'usr_spammer' },
    reason: 'Violated terms of service',
  });

  assert.equal(auditRecord.adminActor.actorId, 'admin_1');
  const storedRecords = await auditDriver.getAuditRecords();
  assert.equal(storedRecords.length, 1);
  assert.equal(storedRecords[0].action, 'admin.user.suspend');
});
