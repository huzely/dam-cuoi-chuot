# Đám Cưới Chuột V2 — M1 Foundation Documentation

This directory contains the M1 Server, Persistence, and Admin Foundation for V2.

## Architecture Overview

- **Modular Monolith + Realtime Workers**:
  - `server/v2/core/`: Primitive contracts for semantic commands, domain events, idempotency, unit-of-work transactions, outbox, configuration rulesets, feature flags, and RBAC.
  - `server/v2/adapters/`: Production PostgreSQL persistence adapters (`PgDriver`, `PgAdminPersistence`, `PgIdempotencyStore`, `PgOutboxRecorder`, `PgOutboxPublisher`, `PgConfigRepository`, `PgFeatureFlagRepository`, `PgAdminAuditLogger`) and explicit memory test doubles (`MemoryAdminPersistence`, etc.).
  - `server/v2/domains/`: Domain contract boundary index modules for all 14 V2 domains (`identity`, `profile`, `progress`, `economy`, `assets`, `business`, `employment`, `village`, `social`, `festival`, `games`, `justice`, `security`, `admin`).
  - `server/v2/migrations/`: Ordered database schema migrations (`001_v2_foundation_schema.sql`).

## Core Invariants & Security Principles

1. **Fail-Fast Production Adapters**: Production `Pg*` adapters require an explicit DB driver instance and throw `MissingDatabaseDriverError` if omitted. Silent fallback to memory in production code is prohibited.
2. **Atomic Single-Transaction Handles**: Administrative state mutations and audit event logs commit atomically inside a single transaction context (`withTransaction`). If audit logging fails, the state mutation rolls back cleanly.
3. **Scoped Idempotency**: Idempotency keys are scoped to `(actor_id, key)` in PostgreSQL and verified using canonical SHA-256 request payload digests (`computeCanonicalFingerprint`).
4. **Trusted Server Auth Context**: Actor identity is derived strictly from trusted server auth context. Client command payloads must not contain `userId` or `actorId` fields.
5. **Fail-Closed Configuration**: Unresolved `TBD_FROM_DATA` parameters fail closed via `UnresolvedConfigError` during ruleset approval or feature activation. Config approvals load draft rulesets directly from trusted database storage server-side.
6. **Safe Feature Flag Defaults**: All V2 feature flags default to `false` (OFF). Unregistered flag names are strictly rejected (`UnregisteredFlagError`).

## Running Tests

### 1. Unit & Security Static Test Suite (No External Credentials Required)
From the repository root:
```bash
cd server/v2 && npm test
```
Or directly:
```bash
node --test server/v2/tests/*.test.js
```

### 2. PostgreSQL Live Integration Test Suite
To execute live integration tests against a dedicated PostgreSQL test/staging database:
```bash
cd server/v2 && POSTGRES_TEST_URL="postgres://user:password@localhost:5432/dcc_v2_test" npm run test:integration
```
*Note: If `POSTGRES_TEST_URL` is omitted, the integration suite reports `SKIPPED — TEST/STAGING DATABASE NOT PROVIDED` without connecting to production.*

## Database Migration Execution

To apply V2 schema migrations to a PostgreSQL/Supabase database:
```bash
psql $POSTGRES_TEST_URL -f server/v2/migrations/001_v2_foundation_schema.sql
```
*V2 migrations are non-destructive and coexist safely with legacy `dcc_*` tables.*

## M2 Handoff & Boundaries

- **M1 Completed Capabilities**: Domain boundaries, semantic commands/events, scoped idempotency, transactional outbox, versioned rulesets, safe feature flags, RBAC admin shell, atomic audit logging, PostgreSQL migration schema, static security verification.
- **Out of Scope for M1 (Reserved for M2+)**: Account V2, provider authentication, Wallet V2, Ledger entries, Holds/Escrow, player money migration, client UI modifications.
