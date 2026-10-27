# DCC Multi-Agent Coordination Protocol

This file defines the control-plane contract for ChatGPT, Work, GitHub Actions, and Jules.

## Single source of truth

- Always read `main:.dcc/control-state.json` immediately before taking any control action.
- `generation` is a fencing token. Never act using a stale generation.
- The live PR head is always read from GitHub PR metadata. Do not cache it in conversation state.
- Milestone transitions update `control-state.json` using compare-and-swap semantics: fetch the current blob SHA, verify the expected generation, then replace the file. A stale write must fail rather than overwrite a newer checkpoint.

## Roles

- Jules: implementation worker. It edits code and updates the active PR. It does not decide milestone PASS or create duplicate sessions/PRs.
- GitHub Actions: mechanical control loop. It serializes control operations, validates the active checkpoint, runs exact-head CI, and sends narrowly scoped mechanical failure/resume feedback.
- Work: long-running operator. It reads this protocol and the current checkpoint, inspects GitHub/Jules through connectors or the GitHub bridge, and performs only actions allowed by the active generation.
- ChatGPT watchdog/controller: semantic auditor. It validates acceptance criteria, architecture/security/spec alignment, decides FAIL/PASS, and authorizes milestone transitions.

## Work transport rules

- Work must use the connected GitHub tools for repository, PR, commit, CI, workflow, and checkpoint access.
- Work must use the DCC Jules Command Bridge or another explicitly supported connector/API path for Jules control.
- Work must not depend on Cloud Browser for GitHub or Jules. Cloud Browser is fallback-only for tasks that truly require a website UI.
- A Cloud Browser connection failure must not pause, invalidate, or reset the DCC checkpoint.
- If Work itself pauses or resumes, it must re-read `control-state.json`, this protocol, the active PR head, and current Jules state before taking any action.

## Serialization and idempotency

All control workflows share one GitHub concurrency group and must use `cancel-in-progress: false`. This prevents simultaneous control mutations.

Every mutating `/dcc-jules` command must include:

- `generation`: the exact current `control-state.json` generation.
- `command_key`: a deterministic idempotency key.

Recommended command key format:

`g<generation>:<milestone>:pr<pr>:<head-or-base>:<action>:<reason>`

Examples:

`g1:M2.2:pr6:76704c27:send-message:semantic-fix-1`

`g2:M2.3:pr7:<sha>:approve-plan:approved-plan-1`

The command bridge must reject stale generations and suppress an earlier duplicate `command_key` on the same PR.

## Active milestone rules

1. Exactly one Jules session and one active PR are authoritative for a milestone.
2. If Jules is `IN_PROGRESS` and there is no confirmed blocker, do not send messages.
3. Every new PR head must be verified independently on that exact SHA.
4. A failed CI/audit correction goes to the same Jules session and existing PR.
5. A milestone is not PASS merely because Jules reports completion or CI is green. Semantic acceptance must also pass.
6. No next Jules session may be created while `next_session_allowed` is false.
7. On confirmed quota/rate limit, checkpoint as waiting and retry later; never create a duplicate session.

## Milestone transition protocol

A controller may transition only after independently verifying the exact active head and all acceptance criteria.

1. Re-read `control-state.json` and PR metadata.
2. Verify generation/session/PR/head have not changed underneath the audit.
3. Update the checkpoint with compare-and-swap, increment `generation`, and set `next_session_allowed=true`, `next_milestone`, and `next_starting_branch`.
4. Only after the new generation is visible may one `create-session` command be issued for the next milestone using a deterministic `command_key` for that generation.
5. Other agents observing the new generation abandon any pending action created from the previous generation.
6. After the next session/PR is established, update the checkpoint again with compare-and-swap and set `next_session_allowed=false`.

## Safety invariants

- Never use production or a production database for autonomous verification.
- Never reveal secrets in comments, logs, prompts, or repository files.
- Never force-push protected branches.
- Never weaken tests/security/spec requirements merely to make CI pass.
- Never perform destructive migrations or production deployment autonomously.
- Stop at `READY_FOR_PLAYTEST` after full regression/integration PASS.