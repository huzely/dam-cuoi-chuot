import fs from 'node:fs/promises';

const repo = process.env.GITHUB_REPOSITORY;
const ghToken = process.env.GITHUB_TOKEN;
const julesKey = process.env.JULES_API_KEY || '';
const statePath = process.env.DCC_STATE_PATH || '.dcc/control-state.json';

if (!repo || !ghToken) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');

const withTimeout = (ms = 20000) => AbortSignal.timeout(ms);
const HARD_STOP_STATUSES = new Set(['HARD_STOP_OWNER_REVIEW', 'OWNER_ACTION_REQUIRED']);
const PLAN_WAIT_STATUSES = new Set(['WAITING_PLAN', 'WAITING_PLAN_APPROVAL']);

const gh = async (path, options = {}) => {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...options,
    signal: options.signal || withTimeout(),
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${ghToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${options.method || 'GET'} ${path}: ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
};

const jules = async (path) => {
  if (!julesKey) return null;
  const res = await fetch(`https://jules.googleapis.com/v1alpha${path}`, {
    signal: withTimeout(),
    headers: { 'x-goog-api-key': julesKey },
  });
  if (!res.ok) throw new Error(`Jules GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
const generation = state.generation;
const milestone = state.milestone;
const sessionId = state.jules_session_id;
const prNumber = state.implementation_pr_number || state.pr_number;
const ready = state.status === 'READY_FOR_PLAYTEST';
const hardStop = HARD_STOP_STATUSES.has(state.status) || state.circuit_breaker?.tripped === true;
const planGate = PLAN_WAIT_STATUSES.has(state.status);
const failedAttempts = Number(state.circuit_breaker?.failed_attempts ?? state.failed_attempts ?? 0);
const maxAttempts = Number(state.circuit_breaker?.max_failed_attempts ?? state.rules?.max_failed_attempts_per_milestone ?? 5);
const retryBudgetExhausted = failedAttempts >= maxAttempts;
const sessionCreationAuthorized = state.next_session_allowed === true && !hardStop && !retryBudgetExhausted && !planGate;

let pr = null;
if (prNumber) pr = await gh(`/pulls/${prNumber}`);

let session = null;
if (sessionId && julesKey && !hardStop) session = await jules(`/sessions/${sessionId}`);

const runs = await gh('/actions/runs?per_page=50');
const mechanicalRuns = (runs.workflow_runs || []).filter((r) => r.name === 'DCC Mechanical Verification');
const bridgeRuns = (runs.workflow_runs || []).filter((r) => r.name === 'DCC Jules Command Bridge');

let ci = { state: 'NO_ACTIVE_PR', exactHead: false, runId: null, conclusion: null };
if (pr?.state === 'open') {
  const head = pr.head.sha;
  const prTarget = mechanicalRuns.find((r) => r.event === 'pull_request_target' && r.head_sha === head);
  const recentDispatch = mechanicalRuns.find((r) => r.event === 'workflow_dispatch' && new Date(r.created_at) >= new Date(pr.updated_at));
  const candidate = recentDispatch || prTarget;

  if (candidate) {
    ci.runId = candidate.id;
    ci.conclusion = candidate.conclusion;
    if (candidate.status !== 'completed') {
      ci.state = 'RUNNING';
    } else {
      const jobs = await gh(`/actions/runs/${candidate.id}/jobs?per_page=100`);
      const exact = (jobs.jobs || []).find((j) => j.name === 'exact-head-ci');
      ci.exactHead = exact?.conclusion === 'success';
      ci.state = ci.exactHead ? 'PASS' : (exact?.conclusion || 'SKIPPED').toUpperCase();
    }
  } else {
    ci.state = 'MISSING';
  }

  const inFlight = mechanicalRuns.some((r) => r.status !== 'completed' && new Date(r.created_at) >= new Date(pr.updated_at));
  // HARD STOP means read-only. Never dispatch work while owner review is required.
  if (!ready && !hardStop && !retryBudgetExhausted && !ci.exactHead && !inFlight) {
    await gh('/actions/workflows/dcc-milestone-control.yml/dispatches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    });
    ci.state = 'DISPATCHED';
  }
}

const candidateHead = state.candidate_audit?.head_sha || state.audit_baseline_head_sha || null;
const headDrift = Boolean(pr?.head?.sha && candidateHead && pr.head.sha !== candidateHead);
const julesState = session?.state || (sessionId ? (hardStop ? 'FROZEN_BY_HARD_STOP' : 'UNAVAILABLE') : 'NONE');

let attention = 'NONE';
if (hardStop || retryBudgetExhausted) {
  attention = 'OWNER_REVIEW_HARD_STOP';
} else if (!ready) {
  // Plan approval is a mandatory semantic gate. It must never imply recovery/session creation.
  if (planGate) attention = 'SEMANTIC_PLAN_AUDIT_REQUIRED';
  else if (julesState === 'COMPLETED' && state.candidate_audit?.accepted !== true) attention = 'SEMANTIC_CODE_AUDIT';
  else if (headDrift) attention = 'NEW_JULES_HEAD_AUDIT';
  else if (ci.state === 'FAILURE' || ci.state === 'CANCELLED') attention = 'CI_FAILURE_AUDIT';
}

const latestBridge = bridgeRuns[0] || null;
const summary = {
  generation,
  milestone,
  checkpoint_status: state.status,
  hard_stop: hardStop,
  retry_budget: { failed_attempts: failedAttempts, max_failed_attempts: maxAttempts, exhausted: retryBudgetExhausted },
  plan_approval_gate: planGate,
  session_creation_authorized: sessionCreationAuthorized,
  jules_session_id: sessionId,
  jules_state: julesState,
  pr_number: prNumber,
  pr_head: pr?.head?.sha || null,
  checkpoint_candidate_head: candidateHead,
  head_drift: headDrift,
  mechanical_ci: ci,
  latest_bridge: latestBridge ? { id: latestBridge.id, status: latestBridge.status, conclusion: latestBridge.conclusion } : null,
  attention,
  terminal: ready,
};

console.log(JSON.stringify(summary, null, 2));

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    '# DCC Continuous Supervisor', '',
    `- Generation: **${generation}**`,
    `- Milestone: **${milestone}**`,
    `- Checkpoint: **${state.status}**`,
    `- Hard stop: **${hardStop}**`,
    `- Retry budget: **${failedAttempts}/${maxAttempts}**${retryBudgetExhausted ? ' (EXHAUSTED)' : ''}`,
    `- Plan approval gate: **${planGate}**`,
    `- Session creation authorized: **${sessionCreationAuthorized}**`,
    `- Jules: **${julesState}** (${sessionId || 'none'})`,
    `- PR: **#${prNumber || 'none'}** @ \`${pr?.head?.sha || 'none'}\``,
    `- Checkpoint candidate: \`${candidateHead || 'none'}\``,
    `- Head drift: **${headDrift}**`,
    `- Exact-head CI: **${ci.state}**${ci.runId ? ` (run ${ci.runId})` : ''}`,
    `- Latest bridge: **${latestBridge?.status || 'none'} / ${latestBridge?.conclusion || 'none'}**`,
    `- Controller attention: **${attention}**`, '',
    hardStop
      ? 'CIRCUIT BREAKER ACTIVE: supervisor is strictly read-only until explicit owner review changes the checkpoint.'
      : planGate
        ? 'PLAN GATE ACTIVE: audit/approve/correct the current plan. Creating a recovery session is forbidden at this gate.'
        : 'Supervisor is read-only toward Jules/checkpoint state; its only automatic mutation is missing exact-head TEST CI when no hard stop is active.',
  ];
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}
