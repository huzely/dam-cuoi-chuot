import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommand } from '../core/command.js';

test('createCommand creates a valid semantic command with trusted actor', () => {
  const actor = { actorId: 'usr_123', role: 'PLAYER' };
  const cmd = createCommand({
    type: 'festival.enter_booth',
    actor,
    payload: { boothId: 'b_456', targetUserId: 'usr_friend' },
  });

  assert.equal(cmd.type, 'festival.enter_booth');
  assert.equal(cmd.actor.actorId, 'usr_123');
  assert.equal(cmd.actor.role, 'PLAYER');
  assert.equal(cmd.payload.boothId, 'b_456');
  assert.equal(cmd.payload.targetUserId, 'usr_friend');
  assert.ok(cmd.commandId.startsWith('cmd_'));
  assert.ok(cmd.timestamp);
});

test('createCommand rejects unauthenticated actor', () => {
  assert.throws(() => {
    createCommand({
      type: 'festival.enter_booth',
      actor: null,
    });
  }, /Authenticated actor with a valid actorId/);

  assert.throws(() => {
    createCommand({
      type: 'festival.enter_booth',
      actor: {},
    });
  }, /Authenticated actor with a valid actorId/);
});

test('createCommand rejects command payload carrying userId or actorId', () => {
  const actor = { actorId: 'usr_real' };
  assert.throws(() => {
    createCommand({
      type: 'festival.enter_booth',
      actor,
      payload: { userId: 'usr_imposter' },
    });
  }, /Security Error: Command payload must not specify userId or actorId/);

  assert.throws(() => {
    createCommand({
      type: 'festival.enter_booth',
      actor,
      payload: { actorId: 'usr_real' },
    });
  }, /Security Error: Command payload must not specify userId or actorId/);
});

test('createCommand rejects generic public commands', () => {
  const actor = { actorId: 'usr_123' };
  const forbidden = ['money.add', 'wallet.update', 'inventory.set', 'profile.setRank'];

  for (const type of forbidden) {
    assert.throws(() => {
      createCommand({ type, actor });
    }, /Forbidden generic command type/);
  }
});
