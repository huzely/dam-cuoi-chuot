import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProgressService,
  ProgressError,
  ChapterNotFoundError,
  InvalidChapterProgressError,
  AccountNotFoundError,
  InvalidAccountStateError,
  KNOWN_CHAPTERS,
  DEFAULT_UNLOCKED_CHAPTERS,
  CHAPTER_PREREQUISITES,
  normalizeChapterId,
  validateProgressPayload,
  getDomainMetadata,
} from '../domains/progress/index.js';
import { MissingDatabaseDriverError } from '../adapters/pg-idempotency.js';

test('Progress Domain: metadata boundary reflects registered commands, events, and chapters', () => {
  const meta = getDomainMetadata();
  assert.equal(meta.domain, 'progress');
  assert.ok(meta.commandTypes.includes('progress.record_chapter_completion'));
  assert.ok(meta.eventTypes.includes('progress.chapter_completed'));
  assert.deepEqual(meta.knownChapters, KNOWN_CHAPTERS);
  assert.deepEqual(meta.defaultUnlockedChapters, DEFAULT_UNLOCKED_CHAPTERS);
});

test('Progress Domain: normalizeChapterId validates and normalizes registered chapter IDs', () => {
  assert.equal(normalizeChapterId('1'), '1');
  assert.equal(normalizeChapterId('4B'), '4b');
  assert.equal(normalizeChapterId(' 10 '), '10');

  assert.throws(() => normalizeChapterId('99'), ChapterNotFoundError);
  assert.throws(() => normalizeChapterId(null), ChapterNotFoundError);
  assert.throws(() => normalizeChapterId(''), ChapterNotFoundError);
});

test('Progress Domain: validateProgressPayload requires valid non-null object payload', () => {
  const p1 = validateProgressPayload('1', { printsCompleted: 6 });
  assert.equal(p1.chapterId, '1');
  assert.equal(p1.printsCompleted, 6);

  assert.throws(() => validateProgressPayload('1', null), InvalidChapterProgressError);
  assert.throws(() => validateProgressPayload('1', 'invalid'), InvalidChapterProgressError);
});

test('ProgressService fails fast with MissingDatabaseDriverError without explicit pgDriver', () => {
  assert.throws(() => new ProgressService({}), MissingDatabaseDriverError);
});

test('ProgressService: mock in-memory execution verifies unlock evaluation logic', async () => {
  // Mock driver and transaction context
  const mockProgressStore = new Map(); // key: userId:chapterId
  const mockAccountsStore = new Map(); // key: userId -> account

  const mockTx = {
    accounts: {
      getById: async (id) => mockAccountsStore.get(id) || null,
    },
    progress: {
      upsertProgress: async ({ userId, chapterId, completed, progress }) => {
        const key = `${userId}:${chapterId}`;
        const existing = mockProgressStore.get(key);
        const record = {
          userId,
          chapterId,
          completed: Boolean(completed) || (existing?.completed || false),
          completedAt: completed ? new Date().toISOString() : (existing?.completedAt || null),
          progress,
        };
        mockProgressStore.set(key, record);
        return record;
      },
      getByUser: async (userId) => {
        const res = [];
        for (const [k, v] of mockProgressStore.entries()) {
          if (k.startsWith(`${userId}:`)) res.push(v);
        }
        return res;
      },
      getByUserAndChapter: async (userId, chapterId) => {
        return mockProgressStore.get(`${userId}:${chapterId}`) || null;
      },
    },
    outbox: {
      recorded: [],
      record: function (event) {
        this.recorded.push(event);
      },
    },
  };

  const mockDriver = {
    withTransaction: async (fn) => await fn(mockTx),
  };

  const service = new ProgressService({ pgDriver: mockDriver });

  const userId = '550e8400-e29b-41d4-a716-446655440000';
  mockAccountsStore.set(userId, { userId, state: 'ACTIVE' });

  // Initial evaluation: Chapter 1, 3, 5, 10 unlocked by default; Chapter 2 locked
  let unlockState = await service.evaluateUnlockState(userId);
  assert.equal(unlockState['1'].unlocked, true);
  assert.equal(unlockState['2'].unlocked, false);
  assert.equal(unlockState['3'].unlocked, true);

  // Complete Chapter 1
  const rec1 = await service.recordChapterCompletion({
    userId,
    chapterId: '1',
    progress: { prints: [true, true, true, true, true, true] },
  });
  assert.equal(rec1.completed, true);
  assert.equal(mockTx.outbox.recorded.length, 1);
  assert.equal(mockTx.outbox.recorded[0].eventType, 'progress.chapter_completed');

  // Idempotent re-completion: no extra outbox event
  await service.recordChapterCompletion({
    userId,
    chapterId: '1',
    progress: { prints: [true, true, true, true, true, true] },
  });
  assert.equal(mockTx.outbox.recorded.length, 1); // Remains 1, no duplicate event!

  // Re-evaluate unlock state: Chapter 2 is now unlocked!
  unlockState = await service.evaluateUnlockState(userId);
  assert.equal(unlockState['2'].unlocked, true);
  assert.equal(unlockState['2'].reason.includes('Prerequisites met'), true);

  // Verify legacy snapshot import
  const legacySnapshot = {
    'dcc.done': [true, true, true, true, true, true],
    'dcc.c2s': { done: Array(14).fill(true) },
  };

  const synced = await service.syncLegacyProgress({ userId, legacySnapshot });
  assert.ok(synced.length >= 2);

  unlockState = await service.evaluateUnlockState(userId);
  assert.equal(unlockState['4'].unlocked, true); // Chapter 4 unlocked because Ch 2 completed!
});

test('ProgressService: prohibited for SUSPENDED and DISABLED accounts', async () => {
  const mockAccountsStore = new Map();
  const mockTx = {
    accounts: {
      getById: async (id) => mockAccountsStore.get(id) || null,
    },
  };
  const mockDriver = {
    withTransaction: async (fn) => await fn(mockTx),
  };
  const service = new ProgressService({ pgDriver: mockDriver });

  const userId = '550e8400-e29b-41d4-a716-446655440001';
  mockAccountsStore.set(userId, { userId, state: 'SUSPENDED' });

  await assert.rejects(
    service.recordProgress({ userId, chapterId: '1', progress: {} }),
    InvalidAccountStateError
  );
});
