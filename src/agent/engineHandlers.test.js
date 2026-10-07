/**
 * `src/workflowEngine/blocksHandler/` 的块处理器契约守卫（T-03）。
 *
 * 为什么不放在 workflowEngine 下：`npm test` 的 glob 是 `src/agent/**`，
 * 放这里才进得了 CI。真正的归属应是引擎自己的测试套件 —— 那一套还不存在，
 * 已作为待审核条目登记。
 *
 * 这些处理器不是 agent 模块，但它们跑在用户的工作流里，错了就是静默出错：
 * 变量没落盘、日志丢上下文，而两边都没有任何断言会响。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const AI = 'src/workflowEngine/blocksHandler/handlerAiWorkflow.js';
const PROMPT = 'src/workflowEngine/blocksHandler/handlerParameterPrompt.js';
const WORKER = 'src/workflowEngine/WorkflowWorker.js';

test('T-03：写变量必须 await —— setVariable 是 async，$$ 全局变量还要落 IndexedDB', () => {
  const src = read(AI);

  assert.ok(
    /await this\.setVariable\(/.test(src),
    'handlerAiWorkflow 的 setVariable 必须 await：不等就返回，后续块读的是旧值；' +
      '它自己 reject 时更糟 —— unhandled rejection，本块照样报成功'
  );
  assert.ok(
    !/(?<!await )this\.setVariable\(/.test(src),
    'handlerAiWorkflow 里不该再有裸调的 this.setVariable'
  );
});

test('T-03：catch 里的 rethrow 必须保留 error 上的字段', () => {
  const src = read(AI);

  assert.ok(
    !src.includes('throw new Error(error.message)'),
    '只搬 message 会把 error.data / error.ctxData 丢掉，' +
      '而 WorkflowWorker 的错误日志正是靠它们拼上下文'
  );
});

test('T-03：worker 那侧仍在回读这两个字段（别把消费端也删了）', () => {
  const src = read(WORKER);

  assert.ok(
    src.includes('...(error.data || {})'),
    'WorkflowWorker 的错误日志要继续展开 error.data'
  );
  assert.ok(
    src.includes('...(error.ctxData || {})'),
    'WorkflowWorker 的错误日志要继续展开 error.ctxData'
  );
});

test('T-03：handlerParameterPrompt 那处裸调是被 allSettled 兜住的，不是漏网', () => {
  // 登记当时把这两处并列为「未 await」，核对后结论相反：
  // `Promise.allSettled` 会等所有 promise settle，所以那处是安全的。
  // 这条守卫盯着 allSettled —— 万一哪天它被拆了，这里会提醒重新判一次。
  const src = read(PROMPT);

  assert.ok(
    !/await this\.setVariable\(/.test(src),
    'handlerParameterPrompt 现在靠 allSettled 等全部写盘，不该出现裸 await 改写'
  );

  // 只看 setVariable 调用**前面最近的那个** Promise.*：
  // 全文扫描会被 42 行那个无关的 allSettled 匹配上，拆掉真正的那个也照样绿。
  const at = src.indexOf('this.setVariable(');
  const before = src.lastIndexOf('Promise.', at);
  const window = at < 0 || before < 0 ? '' : src.slice(before, at);

  assert.ok(
    window.startsWith('Promise.allSettled('),
    'handlerParameterPrompt 的 setVariable 必须待在 Promise.allSettled 里 —— ' +
      '拆掉它就是在块返回后才开始写盘。实际前面是：' +
      JSON.stringify(window.slice(0, 40))
  );
});
