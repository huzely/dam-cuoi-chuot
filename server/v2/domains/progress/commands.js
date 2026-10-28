/**
 * V2 Progress Domain Commands & Canonical Chapter Registry
 */

import { ChapterNotFoundError, InvalidChapterProgressError } from './errors.js';

export const KNOWN_CHAPTERS = Object.freeze([
  '1', '2', '3', '4', '4b', '5', '6', '7', '8', '9', '10',
]);

/**
 * Chapters that are open by default without prerequisites.
 * Chapter 1 is the cover chapter and open for all new players.
 * Chapter 3 is children's quick games (docs: open from start).
 * Chapter 5 is Hội Làng shared room.
 * Chapter 10 is shared puzzle.
 */
export const DEFAULT_UNLOCKED_CHAPTERS = Object.freeze(['1', '3', '5', '10']);

/**
 * Sequential unlock dependencies for chapters that require prior chapter completion.
 */
export const CHAPTER_PREREQUISITES = Object.freeze({
  '2': ['1'],
  '4': ['2'],
  '4b': ['4'],
  '6': ['2'],
  '7': ['6'],
  '8': ['7'],
  '9': ['8'],
});

export function normalizeChapterId(chapterId) {
  if (chapterId === null || chapterId === undefined) {
    throw new ChapterNotFoundError(chapterId);
  }
  const str = String(chapterId).trim().toLowerCase();
  if (!KNOWN_CHAPTERS.includes(str)) {
    throw new ChapterNotFoundError(chapterId);
  }
  return str;
}

export function validateProgressPayload(chapterId, progressData) {
  const normId = normalizeChapterId(chapterId);
  if (progressData === null || progressData === undefined || typeof progressData !== 'object') {
    throw new InvalidChapterProgressError(normId, 'Progress payload must be a non-null object.');
  }

  return {
    ...progressData,
    chapterId: normId,
  };
}
