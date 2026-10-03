import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * 静态事实守卫。
 *
 * 背景：编辑器补全 codeEditorAutocomplete.automaFuncsSnippets 列了 6 个函数，
 * 其中 automaExecWorkflow 在 javascript-code 块的运行时根本没有注入，
 * 它只在 create-element 块的 execute 里被塞进 sandbox。
 *
 * 模型如果照补全列表写，就会产出必然报 undefined 的代码，而用户很难自查。
 * 所以 prompt.js 显式写了这条警告 —— 但写在提示词里的警告会随源码改动悄悄过期，
 * 这里直接读源码做交叉验证，让它和提示词一起被测试守住。
 */

const COMPLETION = 'src/utils/codeEditorAutocomplete.js';
const INJECTION_SITES = [
  'src/workflowEngine/blocksHandler/handlerJavascriptCode.js',
  'src/sandbox/utils/handleJavascriptBlock.js',
];

test('编辑器补全里能解析出 automa* 函数名', () => {
  const src = read(COMPLETION);
  const names = new Set();
  src.replace(/^ {2}([A-Za-z_$][A-Za-z0-9_$]*):\s*\{/gm, (m, n) => {
    names.add(n);
    return m;
  });
  assert.ok(names.has('automaNextBlock'), '补全里应有 automaNextBlock');
  assert.ok(names.has('automaResetTimeout'), '补全里应有 automaResetTimeout');
});

test('javascript-code 块注入的是补全里的真函数，不含 automaExecWorkflow', () => {
  const injected = new Set();
  INJECTION_SITES.forEach((rel) => {
    read(rel).replace(/function (automa[A-Za-z]+)\s*\(/g, (m, n) => {
      injected.add(n);
      return m;
    });
  });

  assert.ok(injected.size > 0, '应能解析出注入的函数');

  const expected = [
    'automaNextBlock',
    'automaSetVariable',
    'automaFetch',
    'automaRefData',
    'automaResetTimeout',
  ];
  expected.forEach((n) =>
    assert.equal(injected.has(n), true, n + ' 应当被注入到 javascript-code 块')
  );

  assert.equal(
    injected.has('automaExecWorkflow'),
    false,
    'javascript-code 块不注入 automaExecWorkflow —— 若上游改了这行，prompt.js 的警告也要一起改'
  );
});

test('prompt.js 必须同时提到 automaExecWorkflow 且说明它没被注入', () => {
  const prompt = read('src/agent/prompt.js');
  assert.ok(
    prompt.includes('automaExecWorkflow'),
    'prompt.js 应提到 automaExecWorkflow'
  );
  assert.ok(prompt.includes('没有注入它'), 'prompt.js 应明确说它没被注入');
});
