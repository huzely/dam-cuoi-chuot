/**
 * V2 Economy Domain Contract Boundary
 */
import { FEATURE_FLAGS } from '../../core/feature-flags.js';

export const DOMAIN_NAME = 'economy';

export const COMMAND_TYPES = Object.freeze({
  INITIATE_TRANSFER: 'economy.initiate_transfer',
});

export const EVENT_TYPES = Object.freeze({
  TRANSFER_INITIATED: 'economy.transfer_initiated',
  LEDGER_ENTRY_RECORDED: 'economy.ledger_entry_recorded',
});

export const REQUIRED_FEATURE_FLAGS = Object.freeze([
  FEATURE_FLAGS.WALLET_V2,
]);

export function getDomainMetadata() {
  return {
    domain: DOMAIN_NAME,
    commandTypes: Object.values(COMMAND_TYPES),
    eventTypes: Object.values(EVENT_TYPES),
    requiredFlags: [...REQUIRED_FEATURE_FLAGS],
  };
}
