/**
 * V2 Progress & Unlock Domain Errors
 */

export class ProgressError extends Error {
  constructor(message, code = 'PROGRESS_ERROR') {
    super(message);
    this.name = 'ProgressError';
    this.code = code;
  }
}

export class ChapterNotFoundError extends ProgressError {
  constructor(chapterId) {
    super(`Chapter "${chapterId}" was not found in registered chapters.`, 'CHAPTER_NOT_FOUND');
    this.name = 'ChapterNotFoundError';
    this.chapterId = chapterId;
  }
}

export class InvalidChapterProgressError extends ProgressError {
  constructor(chapterId, reason) {
    super(`Invalid progress payload for chapter "${chapterId}": ${reason}`, 'INVALID_CHAPTER_PROGRESS');
    this.name = 'InvalidChapterProgressError';
    this.chapterId = chapterId;
  }
}

export class AccountNotFoundError extends ProgressError {
  constructor(userId) {
    super(`V2 account with ID "${userId}" was not found.`, 'ACCOUNT_NOT_FOUND');
    this.name = 'AccountNotFoundError';
    this.userId = userId;
  }
}

export class InvalidAccountStateError extends ProgressError {
  constructor(userId, state, action = 'record progress') {
    super(
      `Account "${userId}" is in state "${state}" and is prohibited from attempting to ${action}.`,
      'INVALID_ACCOUNT_STATE'
    );
    this.name = 'InvalidAccountStateError';
    this.userId = userId;
    this.state = state;
    this.action = action;
  }
}
