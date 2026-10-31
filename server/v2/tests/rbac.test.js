import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QTV_ROLES,
  hasPermission,
  assertPermission,
  createAdminAuditEvent,
} from '../core/rbac.js';

test('RBAC enforces least privilege for QTV roles', () => {
  // SUPER_ADMIN has full permission
  assert.equal(hasPermission(QTV_ROLES.SUPER_ADMIN, 'any.action'), true);

  // ADMIN can suspend user
  assert.equal(hasPermission(QTV_ROLES.ADMIN, 'admin.user.suspend'), true);
  // ADMIN cannot perform economy config changes
  assert.equal(hasPermission(QTV_ROLES.ADMIN, 'admin.economy.propose_config'), false);

  // MODERATOR can mute chat, cannot suspend user
  assert.equal(hasPermission(QTV_ROLES.MODERATOR, 'admin.chat.mute'), true);
  assert.equal(hasPermission(QTV_ROLES.MODERATOR, 'admin.user.suspend'), false);

  // SUPPORT is read-only
  assert.equal(hasPermission(QTV_ROLES.SUPPORT, 'admin.user.view'), true);
  assert.equal(hasPermission(QTV_ROLES.SUPPORT, 'admin.user.warn'), false);

  // ECONOMY_MANAGER
  assert.equal(hasPermission(QTV_ROLES.ECONOMY_MANAGER, 'admin.economy.propose_config'), true);
  assert.equal(hasPermission(QTV_ROLES.ECONOMY_MANAGER, 'admin.chat.mute'), false);
});

test('assertPermission throws Error for unauthorized role actions', () => {
  assert.throws(() => {
    assertPermission(QTV_ROLES.SUPPORT, 'admin.user.suspend');
  }, /Permission Denied: Role "SUPPORT" lacks permission/);
});

test('createAdminAuditEvent generates structured audit record for valid admin action', () => {
  const adminActor = { actorId: 'admin_007', role: QTV_ROLES.ADMIN };
  const auditEvt = createAdminAuditEvent({
    adminActor,
    action: 'admin.user.suspend',
    targetRef: { type: 'user', id: 'usr_bad_actor' },
    reason: 'Repeated toxic behavior in chat',
  });

  assert.equal(auditEvt.adminActor.actorId, 'admin_007');
  assert.equal(auditEvt.adminActor.role, 'ADMIN');
  assert.equal(auditEvt.action, 'admin.user.suspend');
  assert.equal(auditEvt.targetRef.id, 'usr_bad_actor');
  assert.equal(auditEvt.reason, 'Repeated toxic behavior in chat');
  assert.ok(auditEvt.eventId.startsWith('audit_'));
});

test('createAdminAuditEvent rejects audit creation if role lacks required permission', () => {
  const adminActor = { actorId: 'mod_001', role: QTV_ROLES.MODERATOR };
  assert.throws(() => {
    createAdminAuditEvent({
      adminActor,
      action: 'admin.economy.propose_config',
      reason: 'Attempting unauthorized economy parameter update',
    });
  }, /Permission Denied/);
});
