/**
 * QTV / RBAC Primitive for V2 Server Foundation.
 * Enforces least privilege access control and generates Admin Audit Events.
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

// Role permission mapping (Least Privilege principle)
const ROLE_PERMISSIONS = Object.freeze({
  [QTV_ROLES.SUPER_ADMIN]: new Set(['*']),
  [QTV_ROLES.ADMIN]: new Set([
    'admin.user.view',
    'admin.user.suspend',
    'admin.system.status',
    'admin.event.trigger',
  ]),
  [QTV_ROLES.MODERATOR]: new Set([
    'admin.user.view',
    'admin.user.warn',
    'admin.chat.mute',
  ]),
  [QTV_ROLES.SUPPORT]: new Set([
    'admin.user.view',
    'admin.ticket.read',
  ]),
  [QTV_ROLES.ECONOMY_MANAGER]: new Set([
    'admin.economy.view_stats',
    'admin.economy.propose_config',
  ]),
  [QTV_ROLES.EVENT_MANAGER]: new Set([
    'admin.event.view',
    'admin.event.schedule',
  ]),
  [QTV_ROLES.SECURITY_REVIEWER]: new Set([
    'admin.audit.view',
    'admin.security.review_logs',
  ]),
});

/**
 * Checks if a role has permission for a specific admin action.
 * @param {string} role
 * @param {string} permission
 * @returns {boolean}
 */
export function hasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  if (perms.has('*')) return true;
  return perms.has(permission);
}

/**
 * Asserts that the actor role possesses the requested permission.
 */
export function assertPermission(role, permission) {
  if (!hasPermission(role, permission)) {
    throw new Error(`Permission Denied: Role "${role}" lacks permission "${permission}".`);
  }
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
    reason,
    timestamp,
  });
}
