/**
 * Identity Domain Errors
 */

export class AccountNotFoundError extends Error {
  constructor(userId) {
    super(`Account not found for user_id: "${userId}".`);
    this.name = 'AccountNotFoundError';
    this.code = 'ACCOUNT_NOT_FOUND';
    this.userId = userId;
  }
}
