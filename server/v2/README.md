# Đám Cưới Chuột V2 — M1.1 Server / Domain Foundation

This directory contains the M1.1 server/domain foundation for V2.

## Architecture

- **Modular Monolith + Realtime Workers Foundation**
- `server/v2/core/`: Primitive abstractions for commands, events, idempotency, unit of work / outbox, config snapshotting, feature flags, and RBAC.
- `server/v2/domains/`: Domain boundary contracts for 14 V2 domains (`identity`, `profile`, `progress`, `economy`, `assets`, `business`, `employment`, `village`, `social`, `festival`, `games`, `justice`, `security`, `admin`).
- `server/v2/tests/`: Unit test suite using Node's native runner (`node --test`).

## Running Tests

From the repository root:
```bash
cd server/v2 && npm test
```
Or directly using Node:
```bash
node --test server/v2/tests/*.test.js
```
