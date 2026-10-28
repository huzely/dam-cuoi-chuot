# DCC ChatGPT ↔ Jules ↔ GitHub Automation Protocol

This is the authoritative operating contract for autonomous development of `huzely/dam-cuoi-chuot`.

## 1. Authority and roles

### Frozen product authority
The two owner-approved DOCX files are the product/design authority:
- `Dam_Cuoi_Chuot_V2_Full_Game_Documentation.docx`
- `Dam_Cuoi_Chuot_V2_Full_Game_Design.docx`

ChatGPT must read the relevant milestone requirements from BOTH files before writing a Jules prompt, approving a plan, accepting code, or declaring PASS. GitHub CI or a Jules Final Report can never override the frozen DOCX requirements.

### ChatGPT — controller, architect, semantic auditor
ChatGPT is the only component allowed to make semantic decisions. ChatGPT:
1. Reads the DOCX plan/spec and current `.dcc/control-state.json`.
2. Writes the exact milestone prompt for Jules.
3. Reads Jules responses and activities.
4. If Jules returns a plan, audits it against BOTH DOCX files; approve only when correct, otherwise send a precise correction in the SAME session.
5. If Jules returns a Final Report, determine what actually happened. A report is not evidence that code exists.
6. Inspect GitHub branches/PRs/commits/diffs directly. If Jules created or updated a branch, ChatGPT must inspect that exact branch/head.
7. Identify code defects precisely: file/function/logic/requirement/test/architecture/security/migration issue, then send a precise fix prompt to the SAME Jules session and existing PR/branch.
8. After code audit passes, require exact-head CI and then perform final semantic/DoD audit against BOTH DOCX files.
9. Only ChatGPT may mark a milestone PASS and authorize/create the next Jules session.

### Jules — implementation worker
Jules plans and codes. Jules does not decide milestone PASS. One milestone uses one Jules session until PASS. Corrections stay in that same session and existing implementation branch/PR. A new Jules session is created only for the next milestone after ChatGPT accepts the previous milestone.

### GitHub — evidence and mechanical verification
GitHub is the evidence plane: branches, commits, PRs, diffs, reviews, and CI. GitHub Actions may run mechanical exact-head tests but MUST NOT approve Jules plans, send generic semantic corrections, declare PASS, or advance milestones.

### Watchdog
The scheduled ChatGPT watchdog is only a continuity/fallback trigger for the same ChatGPT controller loop. It is not a separate semantic authority.

## 2. Source of truth and fencing

- `.dcc/control-state.json` is the runtime checkpoint.
- `generation` is the fencing token. Re-read the checkpoint immediately before every mutating control action.
- Never act on a stale generation, stale Jules session, stale PR, or stale head SHA.
- The frozen DOCX files define WHAT must be built; the checkpoint defines WHERE the controller currently is.

## 3. Milestone loop

For milestone `Mx`:

1. **Read spec** — ChatGPT extracts Mx scope, invariants, exclusions, acceptance criteria and Definition of Done from BOTH DOCX files.
2. **Prompt Jules** — create exactly one Jules session from the exact accepted head of the previous milestone, with plan approval required.
3. **Plan gate** — when Jules returns a plan, ChatGPT audits it. If wrong/incomplete, send a precise correction to the SAME session. If correct, approve it.
4. **Final Report gate** — when Jules reports completion/final report, ChatGPT classifies it:
   - plan/report only, no implementation: tell the SAME session to implement;
   - implementation claimed: verify GitHub evidence;
   - blocker/question: answer/correct within scope;
   - quota/rate limit: checkpoint `WAITING_FOR_JULES_QUOTA`, do not duplicate.
5. **Branch/code audit** — discover the branch/PR Jules actually created. Verify session identity, base branch, exact base SHA and ancestry. Inspect changed files/diff and relevant full files. Do not trust the Final Report as evidence.
6. **Correction loop** — if code is wrong, identify exact defects and send a precise fix prompt to the SAME Jules session/branch/PR. Re-audit every new head. Repeat until code audit passes.
7. **Mechanical CI** — verify the exact accepted candidate SHA with unit/static tests, PostgreSQL TEST integration, repeatability/regression as applicable. Never use production.
8. **Final semantic gate** — ChatGPT rechecks code + tests + CI + BOTH DOCX + invariants + DoD. CI green alone is not PASS.
9. **PASS transition** — record accepted head and CI evidence, increment generation, then create exactly one new Jules session for Mx+1 from that exact accepted head. Do not wait for the owner between milestones.
10. After M22 + full regression/integration + semantic PASS, set `READY_FOR_PLAYTEST` and STOP. Production/M23 is owner-controlled.

## 4. Jules response rules

### Plan
Never mechanically approve. Audit against both DOCX files first.

### Final Report
Never equate Final Report with completion. Inspect GitHub to prove whether implementation exists and whether it is correct.

### IN_PROGRESS
If Jules is actively working and no blocker exists, do not interrupt.

### COMPLETED without implementation
Resume the SAME session with a deterministic correction telling Jules to implement and update the expected branch/PR.

### Failed implementation
Send precise findings, not `please fix`. A correction should name the affected file/function/behavior, the violated DOCX requirement/invariant, expected behavior, and required tests.

## 5. Branch and PR rules

- If Jules creates a new branch/PR, ChatGPT discovers and inspects it automatically.
- Accept it only when it belongs to the active Jules session and descends from the exact expected baseline.
- Duplicate/stale/wrong-base branches are not accepted as milestone evidence.
- Never force-push protected branches.
- Keep corrections on the same active implementation branch/PR unless recovery is technically unavoidable and independently preflighted.

## 6. PASS equation

A milestone may PASS only when all are true:

`DOCX scope + approved plan + correct implementation + branch/diff audit + required tests + exact-head CI + invariants + Definition of Done + semantic audit`

Jules Final Report alone = NOT PASS.
CI green alone = NOT PASS.
PR mergeable alone = NOT PASS.

## 7. Transport and automation

- `.github/workflows/dcc-jules-command-bridge.yml` is only a fenced transport for ChatGPT commands to Jules and explicit exact-head verification requests.
- `.github/workflows/dcc-milestone-control.yml` is mechanical PR/head CI only. It must not make semantic decisions or message Jules with generic fixes.
- The legacy unfenced `dcc-jules-bridge.yml` is forbidden/removed because it bypasses the checkpoint controller.
- Neutral stale/duplicate commands must not be treated as project failures.

## 8. Safety

- TEST database only for autonomous verification; never production.
- Never expose secrets in prompts/comments/logs/repo files.
- Never weaken tests/spec/security to obtain green CI.
- No destructive production migration/deploy autonomously.
- Owner involvement is required only for a genuine frozen-spec conflict, destructive/security/production decision, or after `READY_FOR_PLAYTEST`.
