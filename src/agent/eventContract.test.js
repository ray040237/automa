import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { AGENT_EVENTS, ERROR_KIND, TOOL_STATUS, errorEvent } from './events';

/**
 * AGENT_EVENTS 事件契约守卫（T-40 / T-41）。
 *
 * AGENT_EVENTS 是 loop 与 UI 之间唯一的 seam（CONTEXT.md 明文「两边互不认识」）。
 * 这份契约没有 owner 时踩过两个真坑：
 *  ① 同一个 agent:error 两种形状（{error} vs {message}），UI 只读 message，
 *     promptFacts 降级的详情被静默吞掉 —— T-40；
 *  ② CONFIRM / PROPOSAL 两个全仓零产出零消费的残留常量，读者误以为是活 seam —— T-41。
 *
 * 规则：
 *  - 每个 AGENT_EVENTS 的 key 必须在真实代码（非测试、非 events.js 定义处）里
 *    至少被引用一次，否则它是僵尸常量；
 *  - 错误事件只允许从 errorEvent() 出，禁止再手写 { kind: 'agent:error', ... } 字面量。
 */

const SRC_ROOT = new URL('..', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1'
);

function collectSources(dir, out = []) {
  readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectSources(p, out);
    else if (
      /\.(js|vue)$/.test(entry.name) &&
      !/\.test\.js$/.test(entry.name) &&
      !p.includes('node_modules')
    )
      out.push(p);
  });
  return out;
}

const allSources = collectSources(SRC_ROOT);
assert.ok(allSources.length > 10, '应至少扫到十来个源码文件');

test('AGENT_EVENTS 的每个 key 至少有一个真实代码引用点（无僵尸常量）', () => {
  const offenders = [];
  for (const [key, value] of Object.entries(AGENT_EVENTS)) {
    const hit = allSources.some((f) => {
      if (f.replace(/\\/g, '/').endsWith('src/agent/events.js')) return false;
      const src = readFileSync(f, 'utf8');
      return (
        src.includes(`AGENT_EVENTS.${key}`) ||
        src.includes(`'${value}'`) ||
        src.includes(`"${value}"`)
      );
    });
    if (!hit) offenders.push(key);
  }
  assert.deepEqual(
    offenders,
    [],
    '这些事件常量没有任何产出/消费点，是残留，应删除: ' + offenders.join(', ')
  );
});

test('错误事件只从 errorEvent() 出（T-40）', () => {
  const offenders = [];
  for (const f of allSources) {
    if (f.replace(/\\/g, '/').endsWith('src/agent/events.js')) continue;
    const src = readFileSync(f, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      // 去掉行注释，避免注释里的说明文字误报
      const code = line.replace(/\/\/.*$/, '');
      if (
        code.includes('kind: AGENT_EVENTS.ERROR') ||
        code.includes("kind: 'agent:error'") ||
        code.includes('kind: "agent:error"')
      ) {
        offenders.push(f + ':' + (idx + 1));
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    '错误事件绕过 errorEvent() 手写字面量，字段形状会再次分叉: ' +
      offenders.join(', ')
  );
});

test('errorEvent 产出的形状固定：kind/status/message，其余可选', () => {
  const ev = errorEvent({ message: '炸了', errorKind: ERROR_KIND.INTERNAL });
  assert.equal(ev.kind, AGENT_EVENTS.ERROR);
  assert.equal(ev.status, TOOL_STATUS.ERROR);
  assert.equal(ev.message, '炸了');
  assert.equal(ev.errorKind, 'internal');
  assert.ok(!('httpStatus' in ev), '没有 httpStatus 时不应带这个键');

  const minimal = errorEvent();
  assert.equal(minimal.message, '未知错误');
  assert.deepEqual(Object.keys(minimal).sort(), ['kind', 'message', 'status']);

  const withHttp = errorEvent({ message: '429', httpStatus: 429 });
  assert.equal(withHttp.httpStatus, 429);

  const coerced = errorEvent({ message: 404 });
  assert.equal(coerced.message, '404');
});
