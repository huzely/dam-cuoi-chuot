/**
 * Durable Postgres Admin Audit Log Repository Adapter.
 * Appends admin audit records into the v2_admin_audit_logs table.
 * Enforces least-privilege role permissions and audit record structure.
 */

import { assertPermission, createAdminAuditEvent } from '../core/rbac.js';
import { MissingDatabaseDriverError } from './pg-idempotency.js';

export class PgAdminAuditLogger {
  /**
   * @param {Object} dbClient - Production DB driver or explicit test memory driver
   */
  constructor(dbClient) {
    if (!dbClient) {
      throw new MissingDatabaseDriverError('PgAdminAuditLogger');
    }
    this.db = dbClient;
  }

  /**
   * Records an append-only admin audit event into Postgres.
   * Enforces least-privilege permission checks.
   *
   * @param {Object} params
   * @param {Object} params.adminActor - { actorId, role }
   * @param {string} params.action - Admin action
   * @param {Object} [params.targetRef] - Target entity reference
   * @param {string} [params.reason] - Explanation for admin action
   * @param {string} [params.commandId] - Associated command ID
   * @param {Object} [params.metadata] - Audit metadata
   */
  async logAuditEvent({
    adminActor,
    action,
    targetRef = null,
    reason = '',
    commandId = null,
    metadata = {},
  }) {
    if (!adminActor || !adminActor.actorId || !adminActor.role) {
      throw new Error('Audit logger requires an authenticated admin actor object with actorId and role.');
    }

    // Verify permission
    assertPermission(adminActor.role, action);

    const auditRecord = createAdminAuditEvent({
      adminActor,
      action,
      targetRef,
      reason,
      metadata,
    });

    const dbRecord = {
      ...auditRecord,
      adminActorId: adminActor.actorId,
      adminRole: adminActor.role,
      commandId,
    };

    await this.db.insertAuditRecord(dbRecord);
    return auditRecord;
  }
}

/**
 * EXPLICIT TEST DOUBLE: In-memory driver for audit logger unit tests.
 */
export class MemoryAuditDriver {
  constructor() {
    this.records = [];
  }

  async insertAuditRecord(record) {
    this.records.push({ ...record });
  }

  async getAuditRecords() {
    return [...this.records];
  }
}
