import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installGlobals } from '../agent/__stubs__/globals';

// shared.js 顶层读构建期全局 IS_OFFLINE，必须在动态 import 之前注入
// （静态 import 来不及——assembly.test.js 同款模式，T-228 的教训）。
installGlobals();
const { categories } = await import('./shared');

/**
 * 块库分类标题的 i18n 守卫（T-184）。
 *
 * categories 的 name 曾经是唯一标题来源（硬编码英文，中文界面里
 * 「英文分组 + 中文条目」混排）；现在渲染走 workflow.blockCategories.<id>，
 * 这里的职责是钉住「每个分类 id 都有 en/zh 键」—— categories 加了新分类
 * 而忘了补 locale 时，这条先红，而不是让用户界面上再冒出一个英文分组。
 */

const DIR = dirname(fileURLToPath(import.meta.url));
const loadWorkflowSection = (lang) =>
  JSON.parse(readFileSync(join(DIR, `../locales/${lang}/newtab.json`), 'utf8'))
    .workflow;

test('T-184：shared.js 的每个分类 id 都有 workflow.blockCategories 键（en + zh）', () => {
  const ids = Object.keys(categories);
  assert.ok(
    ids.length > 0,
    '应至少扫到一个分类——categories 空了说明 shared.js 被改坏'
  );

  const en = loadWorkflowSection('en').blockCategories;
  const zh = loadWorkflowSection('zh').blockCategories;

  for (const id of ids) {
    assert.ok(
      typeof en?.[id] === 'string' && en[id].length > 0,
      `en 缺 workflow.blockCategories.${id}（shared.js categories 有这个分类）`
    );
    assert.ok(
      typeof zh?.[id] === 'string' && zh[id].length > 0,
      `zh 缺 workflow.blockCategories.${id}（shared.js categories 有这个分类）`
    );
  }
});

test('T-184：zh 的分类标题不是整段照抄 en（防「补键但没翻译」的懒做法）', () => {
  const en = loadWorkflowSection('en').blockCategories;
  const zh = loadWorkflowSection('zh').blockCategories;

  const sameCount = Object.keys(categories).filter(
    (id) => en[id] === zh[id]
  ).length;
  assert.ok(
    sameCount < Object.keys(categories).length,
    'zh 分类标题全部与 en 相同——多半是照抄没翻译（个别词中英同形可接受，全部同形不行）'
  );
});

test('T-184：渲染链路守卫——组件走 locale 键 + te 兜底，宿主传 category-id', () => {
  const listSrc = readFileSync(
    join(DIR, '../components/newtab/workflow/WorkflowBlockList.vue'),
    'utf8'
  );
  const cardSrc = readFileSync(
    join(DIR, '../components/newtab/workflow/WorkflowDetailsCard.vue'),
    'utf8'
  );

  assert.ok(
    listSrc.includes('workflow.blockCategories.'),
    '块库标题必须走 workflow.blockCategories 键——退回直渲染 category.name 就是 T-184 复发'
  );
  assert.ok(
    /te\(key\)\s*\?\s*t\(key\)\s*:\s*props\.category\.name/.test(listSrc),
    '必须有 te() 兜底到原文——缺键时显示键名比显示英文更糟'
  );
  assert.ok(
    /:category-id="catId"/.test(cardSrc),
    '分类 id 必须从 WorkflowDetailsCard 传下去——没有 id 就查不到键'
  );
});
