/**
 * V2 Progress Domain Service
 * Manages authoritative chapter progress, unlock eligibility evaluation,
 * legacy progress compatibility import, account state gating, and transactional outbox events.
 */

import { MissingDatabaseDriverError } from '../../adapters/pg-idempotency.js';
import { createDomainEvent } from '../../core/event.js';
import { ACCOUNT_STATES } from '../identity/index.js';
import {
  EVENT_TYPES,
  AccountNotFoundError,
  InvalidAccountStateError,
} from './index.js';
import {
  KNOWN_CHAPTERS,
  DEFAULT_UNLOCKED_CHAPTERS,
  CHAPTER_PREREQUISITES,
  normalizeChapterId,
  validateProgressPayload,
} from './commands.js';

export class ProgressService {
  /**
   * @param {Object} params
   * @param {Object} params.pgDriver - PostgreSQL Driver adapter (REQUIRED)
   */
  constructor({ pgDriver }) {
    if (!pgDriver) {
      throw new MissingDatabaseDriverError('ProgressService');
    }
    this.pgDriver = pgDriver;
  }

  /**
   * Helper to execute work inside an active transaction or start a new one.
   */
  async _withTx(tx, workFn) {
    if (tx) {
      return await workFn(tx);
    }
    return await this.pgDriver.withTransaction(workFn);
  }

  /**
   * Verifies that the user account exists and is in ACTIVE state.
   */
  async _assertActiveAccount(userId, action, activeTx) {
    if (!userId || typeof userId !== 'string') {
      throw new AccountNotFoundError(userId);
    }

    const account = await activeTx.accounts.getById(userId);
    if (!account) {
      throw new AccountNotFoundError(userId);
    }

    if (account.state !== ACCOUNT_STATES.ACTIVE) {
      throw new InvalidAccountStateError(userId, account.state, action);
    }

    return account;
  }

  /**
   * Records or updates chapter progress for a V2 account.
   *
   * @param {Object} params
   * @param {string} params.userId - V2 Account UUID
   * @param {string} params.chapterId - Registered chapter ID (e.g. '1', '2')
   * @param {Object} params.progress - Progress details object
   * @param {boolean} [params.completed=false] - Whether chapter is fully completed
   * @param {Object} [tx] - Optional transaction handle
   */
  async recordProgress({ userId, chapterId, progress = {}, completed = false }, tx = null) {
    const normChapterId = normalizeChapterId(chapterId);
    const validPayload = validateProgressPayload(normChapterId, progress);

    return await this._withTx(tx, async (activeTx) => {
      await this._assertActiveAccount(userId, 'record progress', activeTx);

      const existingRecord = await activeTx.progress.getByUserAndChapter(userId, normChapterId);
      const isAlreadyCompleted = existingRecord?.completed || false;
      const willBeCompleted = isAlreadyCompleted || Boolean(completed);

      const record = await activeTx.progress.upsertProgress({
        userId,
        chapterId: normChapterId,
        completed: willBeCompleted,
        progress: validPayload,
      });

      // Emit event if newly completed (idempotent: no duplicate event if already completed)
      if (completed && !isAlreadyCompleted) {
        const completedEvent = createDomainEvent({
          eventType: EVENT_TYPES.CHAPTER_COMPLETED,
          aggregate: { type: 'progress', id: userId },
          payload: {
            userId,
            chapterId: normChapterId,
            completedAt: record.completedAt || new Date().toISOString(),
            progress: validPayload,
          },
        });
        activeTx.outbox.record(completedEvent);
      }

      return record;
    });
  }

  /**
   * Records chapter completion for a V2 account.
   * Shortcut for recordProgress({ ..., completed: true }).
   */
  async recordChapterCompletion({ userId, chapterId, progress = {} }, tx = null) {
    return await this.recordProgress({ userId, chapterId, progress, completed: true }, tx);
  }

  /**
   * Retrieves chapter progress for a user and specific chapter.
   */
  async getChapterProgress(userId, chapterId, tx = null) {
    const normChapterId = normalizeChapterId(chapterId);

    return await this._withTx(tx, async (activeTx) => {
      return await activeTx.progress.getByUserAndChapter(userId, normChapterId);
    });
  }

  /**
   * Retrieves all chapter progress records for a user.
   */
  async getUserProgress(userId, tx = null) {
    if (!userId || typeof userId !== 'string') {
      return [];
    }

    return await this._withTx(tx, async (activeTx) => {
      return await activeTx.progress.getByUser(userId);
    });
  }

  /**
   * Evaluates authoritative server-side unlock status for all registered chapters for a user.
   *
   * @param {string} userId - V2 Account UUID
   * @param {Object} [tx] - Optional transaction handle
   * @returns {Promise<Object>} Map of chapterId -> { unlocked: boolean, completed: boolean, reason: string }
   */
  async evaluateUnlockState(userId, tx = null) {
    if (!userId || typeof userId !== 'string') {
      throw new AccountNotFoundError(userId);
    }

    return await this._withTx(tx, async (activeTx) => {
      const records = await activeTx.progress.getByUser(userId);
      const completedSet = new Set(
        records.filter(r => r.completed).map(r => r.chapterId)
      );

      const unlockState = {};

      for (const chId of KNOWN_CHAPTERS) {
        const isCompleted = completedSet.has(chId);
        let unlocked = false;
        let reason = '';

        if (DEFAULT_UNLOCKED_CHAPTERS.includes(chId)) {
          unlocked = true;
          reason = 'Open by default';
        } else if (isCompleted) {
          unlocked = true;
          reason = 'Completed';
        } else {
          const prereqs = CHAPTER_PREREQUISITES[chId] || [];
          const prereqsMet = prereqs.every(req => completedSet.has(req));
          if (prereqsMet) {
            unlocked = true;
            reason = `Prerequisites met: ${prereqs.join(', ')}`;
          } else {
            unlocked = false;
            reason = `Requires completion of chapter(s): ${prereqs.filter(r => !completedSet.has(r)).join(', ')}`;
          }
        }

        unlockState[chId] = {
          chapterId: chId,
          unlocked,
          completed: isCompleted,
          reason,
        };
      }

      return unlockState;
    });
  }

  /**
   * Syncs / imports legacy localStorage or cloud save snapshot into V2 authoritative progress state.
   *
   * Legacy format mapping:
   * - `dcc.done` -> Chapter 1 completed prints array (e.g. [true, true, true, true, true, true])
   * - `dcc.c2s`  -> Chapter 2 done level array/mask
   * - `dcc.c3s`  -> Chapter 3 done games array
   * - `dcc.c4s`  -> Chapter 4 save state object
   * - `dcc.c6s`  -> Chapter 6 done level array
   * - `dcc.c7s`  -> Chapter 7 done cases array
   * - `dcc.c8s`  -> Chapter 8 done level array
   *
   * @param {Object} params
   * @param {string} params.userId - V2 Account UUID
   * @param {Object} params.legacySnapshot - Key-value pair object of legacy dcc.* keys
   * @param {Object} [tx] - Optional transaction handle
   */
  async syncLegacyProgress({ userId, legacySnapshot }, tx = null) {
    if (!legacySnapshot || typeof legacySnapshot !== 'object') {
      throw new Error('Valid legacySnapshot object is required.');
    }

    return await this._withTx(tx, async (activeTx) => {
      await this._assertActiveAccount(userId, 'sync legacy progress', activeTx);

      const imported = [];

      // Chapter 1 mapping: dcc.done
      if (legacySnapshot['dcc.done']) {
        let arr = legacySnapshot['dcc.done'];
        if (typeof arr === 'string') {
          try { arr = JSON.parse(arr); } catch (_e) { arr = null; }
        }
        if (Array.isArray(arr)) {
          const completedCount = arr.filter(Boolean).length;
          const isCompleted = completedCount >= 6; // 6 prints in Ch 1
          const rec = await this.recordProgress({
            userId,
            chapterId: '1',
            progress: { doneArray: arr, completedCount },
            completed: isCompleted,
          }, activeTx);
          imported.push(rec);
        }
      }

      // Chapter 2 mapping: dcc.c2s
      if (legacySnapshot['dcc.c2s']) {
        let c2Data = legacySnapshot['dcc.c2s'];
        if (typeof c2Data === 'string') {
          try { c2Data = JSON.parse(c2Data); } catch (_e) { c2Data = null; }
        }
        if (c2Data) {
          const doneArray = Array.isArray(c2Data.done) ? c2Data.done : (Array.isArray(c2Data) ? c2Data : []);
          const completedCount = doneArray.filter(Boolean).length;
          const isCompleted = completedCount >= 14; // baseline required for Ch 2
          const rec = await this.recordProgress({
            userId,
            chapterId: '2',
            progress: { raw: c2Data, completedCount },
            completed: isCompleted,
          }, activeTx);
          imported.push(rec);
        }
      }

      // Chapter 3 mapping: dcc.c3s
      if (legacySnapshot['dcc.c3s']) {
        let c3Data = legacySnapshot['dcc.c3s'];
        if (typeof c3Data === 'string') {
          try { c3Data = JSON.parse(c3Data); } catch (_e) { c3Data = null; }
        }
        if (c3Data) {
          const doneArray = Array.isArray(c3Data.done) ? c3Data.done : [];
          const rec = await this.recordProgress({
            userId,
            chapterId: '3',
            progress: { raw: c3Data },
            completed: doneArray.filter(Boolean).length >= 5,
          }, activeTx);
          imported.push(rec);
        }
      }

      // Chapter 4 mapping: dcc.c4s
      if (legacySnapshot['dcc.c4s']) {
        let c4Data = legacySnapshot['dcc.c4s'];
        if (typeof c4Data === 'string') {
          try { c4Data = JSON.parse(c4Data); } catch (_e) { c4Data = null; }
        }
        if (c4Data) {
          const rec = await this.recordProgress({
            userId,
            chapterId: '4',
            progress: { raw: c4Data },
            completed: Boolean(c4Data.goal || c4Data.completed),
          }, activeTx);
          imported.push(rec);
        }
      }

      // Chapter 6 mapping: dcc.c6s
      if (legacySnapshot['dcc.c6s']) {
        let c6Data = legacySnapshot['dcc.c6s'];
        if (typeof c6Data === 'string') {
          try { c6Data = JSON.parse(c6Data); } catch (_e) { c6Data = null; }
        }
        if (c6Data) {
          const rec = await this.recordProgress({
            userId,
            chapterId: '6',
            progress: { raw: c6Data },
            completed: Boolean(c6Data.completed),
          }, activeTx);
          imported.push(rec);
        }
      }

      // Chapter 7 mapping: dcc.c7s
      if (legacySnapshot['dcc.c7s']) {
        let c7Data = legacySnapshot['dcc.c7s'];
        if (typeof c7Data === 'string') {
          try { c7Data = JSON.parse(c7Data); } catch (_e) { c7Data = null; }
        }
        if (c7Data) {
          const rec = await this.recordProgress({
            userId,
            chapterId: '7',
            progress: { raw: c7Data },
            completed: Boolean(c7Data.completed),
          }, activeTx);
          imported.push(rec);
        }
      }

      // Chapter 8 mapping: dcc.c8s
      if (legacySnapshot['dcc.c8s']) {
        let c8Data = legacySnapshot['dcc.c8s'];
        if (typeof c8Data === 'string') {
          try { c8Data = JSON.parse(c8Data); } catch (_e) { c8Data = null; }
        }
        if (c8Data) {
          const rec = await this.recordProgress({
            userId,
            chapterId: '8',
            progress: { raw: c8Data },
            completed: Boolean(c8Data.completed),
          }, activeTx);
          imported.push(rec);
        }
      }

      return imported;
    });
  }
}
