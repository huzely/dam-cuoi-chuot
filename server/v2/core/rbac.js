/**
 * QTV / RBAC Primitive for V2 Server Foundation.
 * Enforces least privilege access control, reason requirements, and Admin Audit Event logging.
 */

export const QTV_ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  MODERATOR: 'MODERATOR',
  SUPPORT: 'SUPPORT',
  ECONOMY_MANAGER: 'ECONOMY_MANAGER',
  EVENT_MANAGER: 'EVENT_MANAGER',
  SECURITY_REVIEWER: 'SECURITY_REVIEWER',
});

export const ADMIN_PERMISSIONS = Object.freeze({
  AUDIT_READ: 'admin.audit.read',
  FEATURE_FLAGS_READ: 'feature_flags.read',
  FEATURE_FLAGS_MANAGE: 'feature_flags.manage',
  CONFIG_READ: 'config.read',
  CONFIG_DRAFT: 'config.draft',
  CONFIG_APPROVE: 'config.approve',
  KILL_SWITCH_MANAGE: 'kill_switch.manage',
  SECURITY_REVIEW: 'security.review',
  MODERATION_REVIEW: 'moderation.review',
  SUPPORT_READ: 'support.read',
  EVENT_MANAGE: 'event.manage',
});

// Forbidden permission patterns that violate semantic domain constraints
const FORBIDDEN_PERMISSIONS = new Set([
  'database.write',
  'table.update',
  'money.set',
  'wallet.edit',
  'ledger.override',
  'admin.sql.execute',
]);

// Role permission matrix enforcing Least Privilege and Separation of Duties
const ROLE_PERMISSIONS = Object.freeze({
  [QTV_ROLES.SUPER_ADMIN]: new Set(['*']),
  [QTV_ROLES.ADMIN]: new Set([
    'admin.user.view',
    'admin.user.suspend',
    'admin.system.status',
    'admin.event.trigger',
    ADMIN_PERMISSIONS.AUDIT_READ,
    ADMIN_PERMISSIONS.FEATURE_FLAGS_READ,
    ADMIN_PERMISSIONS.CONFIG_READ,
    ADMIN_PERMISSIONS.CONFIG_DRAFT,
    ADMIN_PERMISSIONS.MODERATION_REVIEW,
    ADMIN_PERMISSIONS.SUPPORT_READ,
    ADMIN_PERMISSIONS.EVENT_MANAGE,
  ]),
  [QTV_ROLES.MODERATOR]: new Set([
    'admin.user.view',
    'admin.user.warn',
    'admin.chat.mute',
    ADMIN_PERMISSIONS.MODERATION_REVIEW,
    ADMIN_PERMISSIONS.SUPPORT_READ,
  ]),
  [QTV_ROLES.SUPPORT]: new Set([
    'admin.user.view',
    'admin.ticket.read',
    ADMIN_PERMISSIONS.SUPPORT_READ,
    ADMIN_PERMISSIONS.CONFIG_READ,
  ]),
  [QTV_ROLES.ECONOMY_MANAGER]: new Set([
    'admin.economy.view_stats',
    'admin.economy.propose_config',
    ADMIN_PERMISSIONS.CONFIG_READ,
    ADMIN_PERMISSIONS.CONFIG_DRAFT,
    ADMIN_PERMISSIONS.CONFIG_APPROVE,
  ]),
  [QTV_ROLES.EVENT_MANAGER]: new Set([
    'admin.event.view',
    'admin.event.schedule',
    ADMIN_PERMISSIONS.EVENT_MANAGE,
    ADMIN_PERMISSIONS.CONFIG_READ,
  ]),
  [QTV_ROLES.SECURITY_REVIEWER]: new Set([
    'admin.audit.view',
    'admin.security.review_logs',
    ADMIN_PERMISSIONS.AUDIT_READ,
    ADMIN_PERMISSIONS.SECURITY_REVIEW,
    ADMIN_PERMISSIONS.KILL_SWITCH_MANAGE,
  ]),
});

export class InvalidReasonError extends Error {
  constructor(message = 'A non-empty human-readable reason is required for sensitive administrative operations.') {
    super(message);
    this.name = 'InvalidReasonError';
    this.code = 'INVALID_ADMIN_REASON';
  }
}

/**
 * Asserts that a valid, non-empty, non-whitespace reason is provided for sensitive mutations.
 * @param {string} reason
 */
export function assertReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new InvalidReasonError();
  }
}

/**
 * Checks if a role has permission for a specific admin action.
 * @param {string} role
 * @param {string} permission
 * @returns {boolean}
 */
export function hasPermission(role, permission) {
  if (FORBIDDEN_PERMISSIONS.has(permission)) {
    return false;
  }
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  if (perms.has('*')) return true;
  return perms.has(permission);
}

/**
 * Asserts that the actor role possesses the requested permission.
 */
export function assertPermission(role, permission) {
  if (FORBIDDEN_PERMISSIONS.has(permission)) {
    throw new Error(`Forbidden Permission Error: Permission "${permission}" violates semantic domain constraints.`);
  }
  if (!hasPermission(role, permission)) {
    throw new Error(`Permission Denied: Role "${role}" lacks permission "${permission}".`);
  }
}

/**
 * Sanitizes metadata to strip sensitive secrets (passwords, tokens, keys) before audit recording.
 * @param {Object} metadata
 * @returns {Object}
 */
export function sanitizeAuditMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  const secretKeys = new Set([
    'password', 'token', 'secret', 'access_token', 'apiKey',
    'serviceKey', 'credential', 'authHeader', 'privateKey',
  ]);

  const sanitized = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (secretKeys.has(key) || secretKeys.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeAuditMetadata(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Creates an Admin Audit Event contract for tracking all QTV actions.
 */
export function createAdminAuditEvent({
  eventId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
  adminActor,
  action,
  targetRef = null,
  reason = '',
  timestamp = new Date().toISOString(),
  metadata = {},
}) {
  if (!adminActor || !adminActor.actorId || !adminActor.role) {
    throw new Error('Admin audit event requires an authenticated admin actor object with actorId and role.');
  }

  if (!Object.values(QTV_ROLES).includes(adminActor.role)) {
    throw new Error(`Invalid QTV role "${adminActor.role}" for admin audit event.`);
  }

  if (!action || typeof action !== 'string') {
    throw new Error('Admin audit event requires a valid action string.');
  }

  assertPermission(adminActor.role, action);

  return Object.freeze({
    eventId,
    adminActor: Object.freeze({
      actorId: adminActor.actorId,
      role: adminActor.role,
    }),
    action,
    targetRef: targetRef ? Object.freeze({ ...targetRef }) : null,
    reason: String(reason || ''),
    timestamp,
    metadata: Object.freeze(sanitizeAuditMetadata(metadata)),
  });
}
