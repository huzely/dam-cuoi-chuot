/**
 * V2 Admin / Operations Service & Execution Pipeline.
 * Enforces trusted admin actor context, RBAC authorization, reason requirements,
 * domain validation, and mandatory sanitized atomic audit logging.
 */

import {
  QTV_ROLES,
  ADMIN_PERMISSIONS,
  assertPermission,
  assertReason,
} from '../../core/rbac.js';
import { UnregisteredFlagError } from '../../adapters/pg-feature-flags.js';
import { MissingDatabaseDriverError } from '../../adapters/pg-idempotency.js';
import { FEATURE_FLAGS } from '../../core/feature-flags.js';
import { RulesetSnapshot } from '../../core/config.js';

export const ADMIN_COMMAND_TYPES = Object.freeze({
  FEATURE_FLAG_SET: 'admin.feature_flag.set',
  CONFIG_CREATE_DRAFT: 'admin.config.create_draft',
  CONFIG_APPROVE: 'admin.config.approve',
  KILL_SWITCH_SET: 'admin.kill_switch.set',
  SECURITY_REVIEW_CASE: 'admin.security.review_case',
});

const FORBIDDEN_ADMIN_COMMANDS = new Set([
  'admin.sql.execute',
  'admin.table.update',
  'admin.database.write',
  'admin.money.set',
  'admin.wallet.setBalance',
]);

export class AdminService {
  /**
   * @param {Object} params
   * @param {Object} params.adminPersistence - Transaction-capable admin persistence layer (REQUIRED)
   * @param {Object} [params.prerequisiteRegistry] - Feature prerequisite registry
   */
  constructor({
    adminPersistence,
    prerequisiteRegistry = null,
  }) {
    if (!adminPersistence) {
      throw new MissingDatabaseDriverError('AdminService');
    }
    this.adminPersistence = adminPersistence;
    this.prerequisiteRegistry = prerequisiteRegistry;
  }

  /**
   * Executes a semantic admin command through the authorization, atomic transaction, and audit pipeline.
   *
   * @param {Object} params
   * @param {Object} params.adminActor - Trusted admin actor from server context { actorId, role }
   * @param {Object} params.command - Semantic admin command { type, payload }
   * @returns {Promise<Object>} Execution result
   */
  async executeAdminCommand({ adminActor, command }) {
    if (!adminActor || !adminActor.actorId || !adminActor.role) {
      throw new Error('Security Error: Trusted admin actor with actorId and role is required.');
    }

    if (!Object.values(QTV_ROLES).includes(adminActor.role)) {
      throw new Error(`Security Error: Invalid QTV role "${adminActor.role}".`);
    }

    if (!command || !command.type) {
      throw new Error('Valid semantic admin command object required.');
    }

    // Security check: Payload must not spoof admin identity
    const payload = command.payload || {};
    if (payload.adminActorId || payload.adminRole || payload.role || payload.permissions || payload.isAdmin !== undefined) {
      throw new Error('Security Error: Admin command payload must not dictate admin actor identity, role, or permissions.');
    }

    if (FORBIDDEN_ADMIN_COMMANDS.has(command.type)) {
      throw new Error(`Forbidden Admin Command: "${command.type}" violates semantic domain invariants. Direct database/money overrides are prohibited.`);
    }

    // Atomic transaction execution: State mutation and audit logging commit together on tx
    return await this.adminPersistence.withTransaction(async (tx) => {
      switch (command.type) {
        case ADMIN_COMMAND_TYPES.FEATURE_FLAG_SET:
          return await this._handleFeatureFlagSet(adminActor, command, payload, tx);

        case ADMIN_COMMAND_TYPES.CONFIG_CREATE_DRAFT:
          return await this._handleConfigCreateDraft(adminActor, command, payload, tx);

        case ADMIN_COMMAND_TYPES.CONFIG_APPROVE:
          return await this._handleConfigApprove(adminActor, command, payload, tx);

        case ADMIN_COMMAND_TYPES.KILL_SWITCH_SET:
          return await this._handleKillSwitchSet(adminActor, command, payload, tx);

        case ADMIN_COMMAND_TYPES.SECURITY_REVIEW_CASE:
          return await this._handleSecurityReviewCase(adminActor, command, payload, tx);

        default:
          throw new Error(`Unknown admin command type: "${command.type}".`);
      }
    });
  }

  async _handleFeatureFlagSet(adminActor, command, payload, tx) {
    assertPermission(adminActor.role, ADMIN_PERMISSIONS.FEATURE_FLAGS_MANAGE);
    assertReason(payload.reason);

    const { flagKey, enabled } = payload;
    if (!Object.values(FEATURE_FLAGS).includes(flagKey)) {
      throw new UnregisteredFlagError(flagKey);
    }

    // Server-driven prerequisite check when enabling
    if (Boolean(enabled) && this.prerequisiteRegistry) {
      let rulesetSnapshot = null;
      const targetVersion = payload.version || '1.0.0';
      const rawRecord = await tx.config.getRulesetByVersion(targetVersion);
      if (rawRecord && rawRecord.status === 'APPROVED') {
        rulesetSnapshot = new RulesetSnapshot(targetVersion, rawRecord.definitions);
      }
      this.prerequisiteRegistry.checkPrerequisites(flagKey, rulesetSnapshot);
    }

    await tx.featureFlags.set(flagKey, Boolean(enabled));

    await tx.audit.logAuditEvent({
      adminActor,
      action: ADMIN_PERMISSIONS.FEATURE_FLAGS_MANAGE,
      targetRef: { type: 'feature_flag', id: flagKey },
      reason: payload.reason,
      commandId: command.commandId,
      metadata: { ...payload, flagKey, enabled: Boolean(enabled) },
    });

    return { success: true, flagKey, enabled: Boolean(enabled) };
  }

  async _handleConfigCreateDraft(adminActor, command, payload, tx) {
    assertPermission(adminActor.role, ADMIN_PERMISSIONS.CONFIG_DRAFT);
    assertReason(payload.reason);

    const { version, definitions } = payload;
    if (!version || typeof version !== 'string') {
      throw new Error('Config version string required.');
    }

    await tx.config.saveRuleset(version, 'DRAFT', definitions || {});

    await tx.audit.logAuditEvent({
      adminActor,
      action: ADMIN_PERMISSIONS.CONFIG_DRAFT,
      targetRef: { type: 'config_ruleset', id: version },
      reason: payload.reason,
      commandId: command.commandId,
      metadata: { ...payload, version, status: 'DRAFT' },
    });

    return { success: true, version, status: 'DRAFT' };
  }

  async _handleConfigApprove(adminActor, command, payload, tx) {
    assertPermission(adminActor.role, ADMIN_PERMISSIONS.CONFIG_APPROVE);
    assertReason(payload.reason);

    const { version } = payload;
    if (!version || typeof version !== 'string') {
      throw new Error('Config version string required.');
    }

    // Server-side check: Load DRAFT ruleset directly from trusted database storage
    const rawRecord = await tx.config.getRulesetByVersion(version);
    if (!rawRecord) {
      throw new Error(`Ruleset version "${version}" not found in database.`);
    }

    if (rawRecord.status !== 'DRAFT') {
      throw new Error(`Ruleset version "${version}" is in "${rawRecord.status}" status and cannot be approved.`);
    }

    // Validate persisted definitions server-side.
    // Throws UnresolvedConfigError if any parameter is TBD_FROM_DATA or missing.
    const snapshot = new RulesetSnapshot(version, rawRecord.definitions);
    snapshot.validateAllResolved();

    await tx.config.saveRuleset(version, 'APPROVED', rawRecord.definitions);

    await tx.audit.logAuditEvent({
      adminActor,
      action: ADMIN_PERMISSIONS.CONFIG_APPROVE,
      targetRef: { type: 'config_ruleset', id: version },
      reason: payload.reason,
      commandId: command.commandId,
      metadata: { ...payload, version, status: 'APPROVED' },
    });

    return { success: true, version, status: 'APPROVED' };
  }

  async _handleKillSwitchSet(adminActor, command, payload, tx) {
    assertPermission(adminActor.role, ADMIN_PERMISSIONS.KILL_SWITCH_MANAGE);
    assertReason(payload.reason);

    const { switchKey, active } = payload;
    if (!switchKey || typeof switchKey !== 'string') {
      throw new Error('Kill switchKey is required.');
    }

    await tx.killSwitch.setKillSwitch(switchKey, Boolean(active));

    await tx.audit.logAuditEvent({
      adminActor,
      action: ADMIN_PERMISSIONS.KILL_SWITCH_MANAGE,
      targetRef: { type: 'kill_switch', id: switchKey },
      reason: payload.reason,
      commandId: command.commandId,
      metadata: { ...payload, switchKey, active: Boolean(active) },
    });

    return { success: true, switchKey, active: Boolean(active) };
  }

  async _handleSecurityReviewCase(adminActor, command, payload, tx) {
    assertPermission(adminActor.role, ADMIN_PERMISSIONS.SECURITY_REVIEW);
    assertReason(payload.reason);

    const { caseId, outcome } = payload;
    if (!caseId || typeof caseId !== 'string') {
      throw new Error('Security caseId is required.');
    }

    await tx.audit.logAuditEvent({
      adminActor,
      action: ADMIN_PERMISSIONS.SECURITY_REVIEW,
      targetRef: { type: 'security_case', id: caseId },
      reason: payload.reason,
      commandId: command.commandId,
      metadata: { ...payload, caseId, outcome },
    });

    return { success: true, caseId, outcome };
  }
}
