/**
 * V2 Progress Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';
import {
  ProgressError,
  ChapterNotFoundError,
  InvalidChapterProgressError,
  AccountNotFoundError,
  InvalidAccountStateError,
} from './errors.js';
import {
  KNOWN_CHAPTERS,
  DEFAULT_UNLOCKED_CHAPTERS,
  CHAPTER_PREREQUISITES,
  normalizeChapterId,
  validateProgressPayload,
} from './commands.js';
import { ProgressService } from './service.js';

export const DOMAIN_NAME = 'progress';

export const COMMAND_TYPES = Object.freeze({
  RECORD_CHAPTER_COMPLETION: 'progress.record_chapter_completion',
  RECORD_CHAPTER_PROGRESS: 'progress.record_chapter_progress',
  SYNC_LEGACY_PROGRESS: 'progress.sync_legacy_progress',
});

export const EVENT_TYPES = Object.freeze({
  CHAPTER_COMPLETED: 'progress.chapter_completed',
  PROGRESS_UPDATED: 'progress.progress_updated',
  LEGACY_PROGRESS_SYNCED: 'progress.legacy_progress_synced',
});

export const REQUIRED_FEATURE_FLAGS = Object.freeze([
  FEATURE_FLAGS.ACCOUNT_V2,
]);

export function getDomainMetadata() {
  return {
    domain: DOMAIN_NAME,
    commandTypes: Object.values(COMMAND_TYPES),
    eventTypes: Object.values(EVENT_TYPES),
    knownChapters: [...KNOWN_CHAPTERS],
    defaultUnlockedChapters: [...DEFAULT_UNLOCKED_CHAPTERS],
    requiredFlags: [...REQUIRED_FEATURE_FLAGS],
  };
}

export {
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
};
