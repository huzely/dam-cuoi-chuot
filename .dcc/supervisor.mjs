import fs from 'node:fs/promises';

const repo = process.env.GITHUB_REPOSITORY;
const ghToken = process.env.GITHUB_TOKEN;
const julesKey = process.env.JULES_API_KEY || '';
const statePath = process.env.DCC_STATE_PATH || '.dcc/control-state.json';

if (!repo || !ghToken) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');

const withTimeout = (ms = 20000) => AbortSignal.timeout(ms);

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
const terminal = state.status === 'READY_FOR_PLAYTEST';

let pr = null;
if (prNumber) pr = await gh(`/pulls/${prNumber}`);

let session = null;
if (sessionId && julesKey) session = await jules(`/sessions/${sessionId}`);

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
  if (!terminal && !ci.exactHead && !inFlight) {
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
const julesState = session?.state || (sessionId ? 'UNAVAILABLE' : 'NONE');

let attention = 'NONE';
if (!terminal) {
  if (state.status === 'WAITING_PLAN' || state.status === 'WAITING_PLAN_APPROVAL') attention = 'SEMANTIC_PLAN_AUDIT';
  if (julesState === 'COMPLETED' && state.candidate_audit?.accepted !== true) attention = 'SEMANTIC_CODE_AUDIT';
  if (headDrift) attention = 'NEW_JULES_HEAD_AUDIT';
  if (ci.state === 'FAILURE' || ci.state === 'CANCELLED') attention = 'CI_FAILURE_AUDIT';
}

const latestBridge = bridgeRuns[0] || null;
const summary = {
  generation,
  milestone,
  checkpoint_status: state.status,
  jules_session_id: sessionId,
  jules_state: julesState,
  pr_number: prNumber,
  pr_head: pr?.head?.sha || null,
  checkpoint_candidate_head: candidateHead,
  head_drift: headDrift,
  mechanical_ci: ci,
  latest_bridge: latestBridge ? { id: latestBridge.id, status: latestBridge.status, conclusion: latestBridge.conclusion } : null,
  attention,
  terminal,
};

console.log(JSON.stringify(summary, null, 2));

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    '# DCC Continuous Supervisor',
    '',
    `- Generation: **${generation}**`,
    `- Milestone: **${milestone}**`,
    `- Checkpoint: **${state.status}**`,
    `- Jules: **${julesState}** (${sessionId || 'none'})`,
    `- PR: **#${prNumber || 'none'}** @ \`${pr?.head?.sha || 'none'}\``,
    `- Checkpoint candidate: \`${candidateHead || 'none'}\``,
    `- Head drift: **${headDrift}**`,
    `- Exact-head CI: **${ci.state}**${ci.runId ? ` (run ${ci.runId})` : ''}`,
    `- Latest bridge: **${latestBridge?.status || 'none'} / ${latestBridge?.conclusion || 'none'}**`,
    `- Controller attention: **${attention}**`,
    '',
    'The supervisor is intentionally read-only toward Jules and checkpoint state. Its only automatic mutation is dispatching missing exact-head TEST CI. Semantic plan/code decisions remain with ChatGPT.',
  ];
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}
