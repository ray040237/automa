/**
 * eval 集合的汇总 runner。
 *
 * 用法：
 *   npm run test:eval                     # 跑全部任务
 *   npm run test:eval -- --only=agent/chat
 *   npm run test:eval -- --only=agent/chat,agent/tool-loop
 *   npm run test:eval -- --model=Qwen/Qwen2.5-72B-Instruct   # 换模型对比
 *   npm run test:eval -- --list           # 只列任务，不跑（不需要 .env）
 *
 * 这些任务打真实 API，故不塞进 `npm test`（与 `test:dom` 同理单列命令），
 * 也不进 CI —— 需要 `.env`、且免费额度下 429 是常态。
 *
 * 退出码：有任何 hard 断言失败 → 1；否则 0。soft 失败只记 WARN，不影响退出码
 * （见 harness 的 `makeCheck`）。
 */

import { ROOT, agentConfig, configDoc, loadEnv, parseArgs } from './env.mjs';
import {
  AGENT_EVENTS,
  TOOL_STATUS,
  createPiProvider,
  defaultFacts,
  makeAgent,
  makeCheck,
  setupAssembly,
  skipIfRateLimited,
  textOf,
  toPiContext,
  toolCallNames,
  toolResultsOf,
} from './harness.mjs';
import tasks from './tasks/index.mjs';

const opts = parseArgs();
const only = opts.only
  ? String(opts.only)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : null;

if (opts.list) {
  for (const t of tasks) console.log(`  ${t.id}  [${t.layer}]  ${t.title}`);

  process.exit(0);
}

if (tasks.length === 0) {
  console.error('任务清单为空 —— eval/tasks/index.mjs 里没登记任何任务');

  process.exit(2);
}

const selected = only ? tasks.filter((t) => only.includes(t.id)) : tasks;

if (selected.length === 0) {
  console.error(`--only 没匹配到任何任务。可用 id：\n  ${tasks.map((t) => t.id).join('\n  ')}`);

  process.exit(2);
}

// 只覆盖显式传了的字段，避免 --model 顺手把 key 清空
const over = {};
const pick = [
  ['model', opts.model],
  ['baseUrl', opts.baseUrl],
  ['apiKey', opts.apiKey],
  ['temperature', opts.temperature && Number(opts.temperature)],
];

for (const [k, v] of pick) if (v !== undefined) over[k] = v;

let env;

try {
  env = loadEnv();
} catch (err) {
  console.error(`\n${err.message}`);

  if (err.code === 'ENV_MISSING') {
    console.error(
      `eval 任务打真实 API，需要 ${ROOT}\\.env 里的 modelscope_url / modelscope_api_key / modelscope_model。`
    );
  }

  process.exit(2);
}

const cfg = agentConfig(env, over);
const doc = configDoc(env, over);

console.log(`[env] model=${cfg.model} baseUrl=${cfg.baseUrl} key=********${String(cfg.apiKey || '').slice(-4)}`);
console.log(`[run] ${selected.length}/${tasks.length} 条任务\n`);

/** 从判据集合归并出该任务的结论。 */
function verdictOf(results) {
  if (results.some((r) => r.level === 'hard' && !r.ok)) return 'fail';
  if (results.some((r) => r.level === 'skip')) return 'skip';
  if (results.some((r) => r.level === 'soft' && !r.ok)) return 'warn';

  return 'pass';
}

const ICON = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP', error: 'ERR ' };
const tally = { pass: 0, fail: 0, warn: 0, skip: 0, error: 0 };
const failed = [];

for (const task of selected) {
  const check = makeCheck();
  const startedAt = Date.now();
  let thrown = null;

  // 两层同一份**运行时**扁平配置；装配层另需 v2 文档写盘（configDoc）
  const ctx = {
    config: cfg,
    configDoc: doc,
    env,
    opts,
    check,
    makeAgent,
    createPiProvider,
    toPiContext,
    setupAssembly,
    defaultFacts,
    skipIfRateLimited,
    textOf,
    toolResultsOf,
    toolCallNames,
    AGENT_EVENTS,
    TOOL_STATUS,
  };

  try {
    await task.run(ctx);
  } catch (err) {
    thrown = err;
  }

  const ms = Date.now() - startedAt;
  const key = thrown ? 'error' : verdictOf(check.results);

  tally[key] += 1;

  const head = `  ${ICON[key]}  ${task.id}  (${ms}ms)`;

  console.log(head);

  if (thrown) {
    console.log(`        send 抛异常: ${thrown && thrown.stack ? thrown.stack : thrown}`);
    failed.push({ id: task.id, why: String(thrown && thrown.message) });
  }

  // 失败的判据才展开，通过的不刷屏（skip 也打，因为它意味着「本轮没验」）
  for (const r of check.results) {
    const noisy = r.level === 'skip' || r.ok === false;

    if (noisy) console.log(`        [${r.level}] ${r.msg}`);
  }

  if (key === 'fail') {
    const why = check.results
      .filter((r) => r.level === 'hard' && !r.ok)
      .map((r) => r.msg)
      .join(' | ');

    failed.push({ id: task.id, why });
  }
}

const total = selected.length;
const bad = tally.fail + tally.error;

console.log(
  `\n汇总：${total} 条 —— pass ${tally.pass} / warn ${tally.warn} / skip ${tally.skip} / fail ${tally.fail} / error ${tally.error}`
);

if (failed.length) {
  console.log('\n失败明细：');
  for (const f of failed) console.log(`  - ${f.id}: ${f.why}`);
}

console.log(bad === 0 ? '\n无硬性失败 ✓' : `\n${bad} 条硬性失败 ✗`);
process.exit(bad === 0 ? 0 : 1);