#!/usr/bin/env node
// Extracts the inline `script:` from ../.github/workflows/pr-review.yml and runs it against a
// mocked GitHub API and a stubbed `fetch`. No network, no credentials, no real comments.
//
//   node test/pr-review.test.mjs
//
// Fixtures are synthetic on purpose: this repo is public, the repos it reviews are not.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const YML = path.join(here, '..', '.github', 'workflows', 'pr-review.yml');

// ------------------------------------------------------------------ load the real script
const raw = fs.readFileSync(YML, 'utf8').split('\n');
const start = raw.findIndex((l) => l.trim() === 'script: |');
if (start < 0) throw new Error('script block not found in pr-review.yml');
const bodyLines = [];
for (let i = start + 1; i < raw.length; i++) {
  const l = raw[i];
  if (l.trim() !== '' && !l.startsWith(' '.repeat(12))) break;
  bodyLines.push(l.slice(12));
}
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const runScript = new AsyncFunction(
  'github', 'context', 'process', 'fetch', 'setTimeout', 'clearTimeout', 'console',
  bodyLines.join('\n'),
);

// ------------------------------------------------------------------ synthetic fixtures
const patch = (name, chars) => ({
  filename: name,
  status: 'added',
  additions: 10,
  deletions: 0,
  patch: `@@ -0,0 +1,10 @@\n${`+// ${name} line filler\n`.repeat(Math.ceil(chars / 30)).slice(0, chars)}`,
});
const FILES = [
  patch('engine/api/routes_tags.py', 4000),
  patch('src/api/experimentApi.ts', 6000),
  patch('src/components/workspace/ArtifactList.tsx', 7000),
  patch('src/components/workspace/ArtifactList.test.tsx', 5000),
  patch('tests/experiment_db/test_tag_routes.py', 6000),
];
const HUGE = [patch('src/generated/schema.ts', 30000)];

const pull = {
  number: 42, title: 'Add tags', user: { login: 'octocat' },
  base: { ref: 'main' }, head: { ref: 'feature/tags' }, body: 'Adds tags.',
};
const context = {
  payload: { pull_request: { number: 42, head: { sha: 'deadbeefcafe' } } },
  repo: { owner: 'Nebulalab228', repo: 'Example' },
  serverUrl: 'https://github.com', runId: 999,
};
const BASE_ENV = {
  OPENAI_API_KEY: 'test-key', OPENAI_API_BASE: 'https://example.test/v1/',
  PR_REVIEW_MODELS: 'glm-5.2,qwen3.7-plus',
  PR_REVIEW_MODEL_LABELS: '{"glm-5.2":"GLM-5.2","qwen3.7-plus":"Qwen3.7-Plus","kimi-k2.6":"Kimi-K2.6","minimax-m3":"MiniMax-M3"}',
  PR_REVIEW_FALLBACKS: '{"glm-5.2":["kimi-k2.6"],"qwen3.7-plus":["minimax-m3"]}',
  PR_REVIEW_DIFF_BUDGET: '100000',
};

const FAILOVER_503 = JSON.stringify({ error: { message: 'Error from provider (Console Go): Inference is temporarily unavailable', code: 'failover_exhausted' } });
const FIREWORKS_400 = JSON.stringify({ error: { message: "Error from provider: Extra inputs are not permitted, field: 'temperature', value: 0.2" } });
const okBody = (model, content, extra = {}) => JSON.stringify({
  model: `upstream/${model}`,
  choices: [{ finish_reason: extra.finish || 'stop', message: { content, reasoning_content: extra.reasoning ?? 'thinking...' } }],
  usage: { prompt_tokens: 100 },
});
const reply = (status, text) => ({ ok: status < 400, status, text: async () => text });

// ------------------------------------------------------------------ harness
// `route(model, opts)` returns a stubbed Response. `clockPerFetch`, when set, replaces
// Date.now() with a fake clock that jumps forward that many ms on every fetch — this lets
// the wall-clock budget (MODEL_BUDGET_MS) be exercised deterministically without real waits.
// `hangUntilAbort` makes a request never resolve until its AbortController fires, so the
// per-attempt timeout / budget abort path can be tested with backoff sleeps collapsed to 0.
let captured = [];
async function scenario({ route, files = FILES, commentBehaviour = () => true, env = {}, clockPerFetch = 0 }) {
  captured = [];
  const posted = [];
  const logs = [];
  let attempts = 0; // count CALLS, not successes: a rejected post must still advance this
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pull }), listFiles: 'LF', listCommits: 'LC' },
      issues: {
        get: async () => { throw new Error('not found'); },
        createComment: async ({ body }) => {
          const r = commentBehaviour(body, attempts++);
          if (r instanceof Error) throw r;
          posted.push(body);
          return { data: { id: 1000 + posted.length } };
        },
      },
    },
    paginate: async (fn) => (fn === 'LF' ? files : [{ commit: { message: 'add tags' } }]),
  };
  const realNow = Date.now;
  let fakeNow = realNow();
  if (clockPerFetch) Date.now = () => fakeNow;
  const stubFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    captured.push(body);
    if (clockPerFetch) fakeNow += clockPerFetch;
    const res = route(body.model, opts);
    if (res === 'HANG') {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
      });
    }
    return res;
  };
  let threw = null;
  try {
    await runScript(
      github, context, { env: { ...BASE_ENV, ...env } }, stubFetch,
      (fn) => setTimeout(fn, 0), clearTimeout,            // collapse backoff sleeps
      { log: (...a) => logs.push(a.join(' ')) },
    );
  } catch (e) { threw = e; } finally { Date.now = realNow; }
  return { posted, logs, threw, captured: [...captured] };
}

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const packLog = (r) => r.logs.find((l) => l.startsWith('Diff packed:'));
const promptOf = (r) => r.captured[0].messages[1].content;

// ------------------------------------------------------------------ 1. happy path
let r = await scenario({ route: (m) => reply(200, okBody(m, `# review by ${m}`)) });
check('happy: one comment per configured model', r.posted.length === 2);
check('happy: primaries used', r.captured.map((c) => c.model).sort().join(',') === 'glm-5.2,qwen3.7-plus');
check('happy: no degraded banner', !r.posted.some((b) => b.includes('备用模型')));
check('happy: actual upstream is logged', r.logs.some((l) => l.includes('upstream=upstream/glm-5.2')));
check('happy: footer is its own paragraph', /\n\n<sub>Model: /.test(r.posted[0]));
check('happy: header is its own paragraph', /## AI PR Review · GLM-5\.2\n\n# review/.test(r.posted[0]));

// ------------------------------------------------------------------ 2. request contract
check('payload: enable_thinking is never sent', r.captured.every((c) => !('enable_thinking' in c)));
check('payload: required fields present', r.captured.every((c) => c.model && c.messages?.length === 2 && c.stream === false));

// ------------------------------------------------------------------ 3. upstream outage -> fallback
r = await scenario({ route: (m) => (m === 'qwen3.7-plus' ? reply(503, FAILOVER_503) : reply(200, okBody(m, `# review by ${m}`))) });
check('outage: primary retried maxAttempts (3) times', r.captured.filter((c) => c.model === 'qwen3.7-plus').length === 3);
check('outage: fallback model invoked', r.captured.some((c) => c.model === 'minimax-m3'));
check('outage: review still posted', r.posted.length === 2);
const degradedBody = r.posted.find((b) => b.includes('ai-pr-review-bot:qwen3.7-plus'));
check('outage: degraded banner rendered', /\n\n> ℹ️ .*由备用模型 `MiniMax-M3` 生成。\n\n/.test(degradedBody));
check('outage: footer names both models', degradedBody.includes('Model: qwen3.7-plus unavailable -> served by minimax-m3'));
check('outage: healthy model unaffected', r.posted.some((b) => b.includes('# review by glm-5.2')));

// ------------------------------------------------------------------ 3b. hung upstream is bounded
// An upstream that accepts the connection and never replies must be aborted and fall back,
// not spin forever (the 26-minute job). Backoff sleeps are collapsed, so the abort path runs
// immediately here; in production each attempt is capped at requestTimeoutMs.
r = await scenario({ route: (m) => (m === 'glm-5.2' ? 'HANG' : reply(200, okBody(m, `# review by ${m}`))) });
check('hang: primary aborted after maxAttempts (3), not more', r.captured.filter((c) => c.model === 'glm-5.2').length === 3);
check('hang: falls back to a different upstream', r.captured.some((c) => c.model === 'kimi-k2.6'));
check('hang: review still posted for the hung model', r.posted.some((b) => b.includes('ai-pr-review-bot:glm-5.2') && b.includes('由备用模型')));
check('hang: healthy model unaffected', r.posted.some((b) => b.includes('# review by qwen3.7-plus')));

// ------------------------------------------------------------------ 3c. wall-clock budget cuts retries short
// A slow-but-not-instant upstream: each call burns 200s of the 360s budget, so the model is
// abandoned after 2 attempts (not the full 3) and control moves to the fallback. Single model
// so the shared fake clock is advanced only by this chain; the fake clock makes it deterministic.
const SOLO = { PR_REVIEW_MODELS: 'glm-5.2', PR_REVIEW_FALLBACKS: '{"glm-5.2":["kimi-k2.6"]}' };
r = await scenario({
  clockPerFetch: 200000,
  env: SOLO,
  route: (m) => (m === 'glm-5.2' ? reply(503, FAILOVER_503) : reply(200, okBody(m, `# review by ${m}`))),
});
check('budget: primary stopped before maxAttempts when time runs out', r.captured.filter((c) => c.model === 'glm-5.2').length === 2);
check('budget: still falls back and posts', r.captured.some((c) => c.model === 'kimi-k2.6') && r.posted.length === 1);

// 3d. the budget is shared across the field-repair loop: once it is spent, the next attempt is
// skipped rather than fired. glm 400s on 'temperature' (dropped), and by the retry the 400s-per-
// fetch clock has already blown the 360s budget, so the repaired attempt never leaves the ground.
r = await scenario({
  clockPerFetch: 400000,
  env: SOLO,
  route: (m) => (m === 'glm-5.2' ? reply(400, FIREWORKS_400) : reply(200, okBody(m, `# review by ${m}`))),
});
check('budget: repaired attempt skipped once budget is spent', r.captured.filter((c) => c.model === 'glm-5.2').length === 1);
check('budget: budget-exhausted skip is logged', r.logs.some((l) => l.includes('model budget exhausted')));
check('budget: field drop still logged before skip', r.logs.some((l) => l.includes("rejected optional field 'temperature'")));
check('budget: falls back after giving up', r.captured.some((c) => c.model === 'kimi-k2.6') && r.posted.length === 1);

// ------------------------------------------------------------------ 4. whole chain down
r = await scenario({ route: () => reply(503, FAILOVER_503) });
check('chain down: diagnostic comments still posted', r.posted.length === 2 && r.threw === null);
check('chain down: lists every model tried', r.posted[1].includes('qwen3.7-plus -> HTTP 503') && r.posted[1].includes('minimax-m3 -> HTTP 503'));
check('chain down: explains failover_exhausted', r.posted[0].includes('provider-side outage, not a problem with this repo'));

// ------------------------------------------------------------------ 5. optional-field repair
r = await scenario({
  route: (m) => {
    if (m !== 'glm-5.2') return reply(200, okBody(m, 'ok'));
    const call = captured.filter((c) => c.model === 'glm-5.2').at(-1);
    return 'temperature' in call ? reply(400, FIREWORKS_400) : reply(200, okBody(m, '# glm review after repair'));
  },
});
const glmCalls = r.captured.filter((c) => c.model === 'glm-5.2');
check('repair: retried without the rejected field', glmCalls.length === 2 && !('temperature' in glmCalls[1]));
check('repair: primary still serves (no fallback)', !r.captured.some((c) => c.model === 'kimi-k2.6'));
check('repair: drop is logged', r.logs.some((l) => l.includes("rejected optional field 'temperature'")));

r = await scenario({
  route: (m) => (m === 'glm-5.2'
    ? reply(400, '{"error":{"message":"Extra inputs are not permitted, field: \'messages\', value: x"}}')
    : reply(200, okBody(m, 'ok'))),
});
check('repair: required fields are never dropped', r.captured.filter((c) => c.model === 'glm-5.2').length === 1);
check('repair: unrepairable 400 falls back instead', r.captured.some((c) => c.model === 'kimi-k2.6'));

// ------------------------------------------------------------------ 6. non-retriable 4xx
r = await scenario({ route: (m) => (m === 'glm-5.2' ? reply(404, '{"error":"nope"}') : reply(200, okBody(m, 'ok'))) });
check('4xx: not retried 4x', r.captured.filter((c) => c.model === 'glm-5.2').length === 1);

// ------------------------------------------------------------------ 7. response sanitising
r = await scenario({ route: (m) => reply(200, okBody(m, '<think>\nchain of thought\n</think>\n\n# 真正的 review')) });
check('sanitise: inline <think> stripped', !r.posted[0].includes('chain of thought') && !/<\/?think>/i.test(r.posted[0]));
check('sanitise: review body preserved', r.posted[0].includes('# 真正的 review'));

r = await scenario({ route: (m) => reply(200, okBody(m, '# 截断的 review', { finish: 'length' })) });
check('sanitise: max_tokens truncation is flagged', r.posted[0].includes('达到 max_tokens 上限'));

r = await scenario({ route: (m) => reply(200, okBody(m, 'ok', { reasoning: m === 'glm-5.2' ? 'abc' : '' })) });
check('footer: reports real thinking length', r.posted[0].includes('Thinking: 3 chars'));
check('footer: says "not reported" when absent', r.posted[1].includes('Thinking: not reported'));

// ------------------------------------------------------------------ 8. comment posting
r = await scenario({ route: (m) => reply(200, okBody(m, 'ok')), commentBehaviour: (_b, n) => (n === 0 ? new Error('403') : true) });
check('posting: one failed comment does not swallow the other', r.posted.length === 1 && r.threw === null);

r = await scenario({ route: (m) => reply(200, okBody(m, 'ok')), commentBehaviour: () => new Error('403') });
check('posting: total failure fails the job loudly', /No AI PR Review comment could be posted/.test(r.threw?.message || ''));

// ------------------------------------------------------------------ 9. diff packing
r = await scenario({ route: (m) => reply(200, okBody(m, 'ok')) });
check('packing: every file fits under the default budget', packLog(r).includes('5/5 files'), packLog(r));
check('packing: no omission note when nothing dropped', !promptOf(r).includes('file(s) omitted'));
const iSrc = promptOf(r).indexOf('File: src/components/workspace/ArtifactList.tsx');
const iTsTest = promptOf(r).indexOf('File: src/components/workspace/ArtifactList.test.tsx');
const iPyTest = promptOf(r).indexOf('File: tests/experiment_db/test_tag_routes.py');
check('packing: source is ordered before its test', iSrc > 0 && iTsTest > iSrc);
check('packing: python tests recognised as tests', iPyTest > iSrc);

r = await scenario({ route: (m) => reply(200, okBody(m, 'ok')), env: { PR_REVIEW_DIFF_BUDGET: '11000' } });
check('packing: tests are dropped before source', !promptOf(r).includes('File: tests/experiment_db/test_tag_routes.py')
  && promptOf(r).includes('File: engine/api/routes_tags.py'));
check('packing: omitted files are listed', /\d+ file\(s\) omitted/.test(promptOf(r)));
const packed = Number(packLog(r).match(/(\d+)\/11000 patch chars/)[1]);
check('packing: patch budget is respected', packed <= 11000, `${packed} <= 11000`);

// a single file larger than the whole budget must be truncated in place, not dropped silently
r = await scenario({ route: (m) => reply(200, okBody(m, 'ok')), files: HUGE, env: { PR_REVIEW_DIFF_BUDGET: '5000' } });
check('packing: oversized single file is kept but marked', promptOf(r).includes('src/generated/schema.ts')
  && promptOf(r).includes('[... patch truncated to fit the diff budget ...]'));
const hugePacked = Number(packLog(r).match(/(\d+)\/5000 patch chars/)[1]);
check('packing: oversized file still respects the budget', hugePacked <= 5000, `${hugePacked} <= 5000`);

// ------------------------------------------------------------------ 10. bad config must not crash
r = await scenario({ route: (m) => reply(200, okBody(m, 'ok')), env: { PR_REVIEW_FALLBACKS: '{not json' } });
check('config: malformed fallbacks JSON is ignored, job survives', r.posted.length === 2 && r.threw === null);

r = await scenario({ route: (m) => reply(200, okBody(m, 'ok')), env: { PR_REVIEW_DIFF_BUDGET: 'abc' } });
check('config: non-numeric budget falls back to the default', packLog(r).includes('/100000 patch chars'));

// ------------------------------------------------------------------ summary
const failed = results.filter((x) => !x.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log(`FAILURES:\n${failed.map((f) => `  - ${f.name}`).join('\n')}`);
  process.exitCode = 1;
}
