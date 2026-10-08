/**
 * 控件的「可解释性」守卫（T-173 / T-160）。
 *
 * 这一族问题的共同形态：控件**看起来能用**，但说不清自己是什么状态、
 * 或者为什么点不动。用户看到的不是报错，是一个没有出口的死胡同。
 *
 * 具体两条：
 *   T-173 —— 目标页 chip 的「自动」徽标（用户读不懂，以为是个开关）；
 *   T-160 —— disabled 的发送按钮不说为什么点不动（按钮上挂 title 没用，
 *            因为 disabled 元素带 pointer-events-none）。
 *
 * 守卫写成「断言正确的做法还在」，而不是「断言错误的东西不存在」——
 * 后者容易漏（换个写法就绕过了）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT = 'src/components/newtab/workflow/agent';
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// 同 T-171 的教训：注释里会写着 class/键名字面量，先剥掉再断言。
const strip = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

const localeOf = (lang) =>
  JSON.parse(read(`src/locales/${lang}/newtab.json`)).workflow.agent;

// —— T-173：chip 的两态含义必须写在动态 title 里 ——
test('T-173：目标页 chip 的 title 要随 pinned 变化，不能是恒定文案', () => {
  const src = strip(read(`${AGENT}/AgentTabPicker.vue`));

  assert.ok(
    src.includes('pickTab.pinnedHint') && src.includes('pickTab.autoHint'),
    'chip 的 title 必须按 pinned 分两种 —— 一个恒定的「选择目标页」说不出' +
      '「现在是自动跟随还是已固定」，而这正是 T-150 的抱怨'
  );
  assert.ok(
    !src.includes('pickTab.title'),
    'pickTab.title（「选择目标页」）已被 pinnedHint / autoHint 取代，' +
      '不该还有引用 —— 留着就是一条死键'
  );
});

test('T-173：auto 态不贴徽标，pinned 态才贴且用 accent', () => {
  const src = strip(read(`${AGENT}/AgentTabPicker.vue`));

  assert.ok(
    /v-else-if="pinned"/.test(src),
    '徽标那块应该是 v-else-if="pinned" —— auto 态这一格留空（默认跟随是常态，' +
      '常态不需要标注；原先两态都贴徽标，auto 那个「自动」用户读不懂）'
  );
  // 注意用 (?!Hint)：朴素的 includes('pickTab.auto') 会被 pickTab.autoHint
  // 这个子串命中 —— 守卫的假阳性（第一版就是这么红的）。
  assert.ok(
    !/pickTab\.auto(?!Hint)/.test(src),
    'pickTab.auto 不该再被引用 —— 「自动」这个词已经不用了'
  );

  // pinned 徽标要能与其它徽标一眼分开（原先两态同灰 bg-gray-500/15）
  const badge = src.slice(src.indexOf('v-else-if="pinned"'));
  const cls = (badge.match(/class="([^"]*)"/) || ['', ''])[1];
  assert.ok(
    /bg-accent/.test(cls) && /text-accent/.test(cls),
    `pinned 徽标要用 accent 高亮，当前是 ${JSON.stringify(cls)} —— ` +
      '两态同灰时用户看不出「我固定过」'
  );
});

// —— T-160：disabled 按钮说不清原因 ——
test('T-160：发送按钮的 title 必须挂在非 disabled 的包裹层上', () => {
  const src = strip(read(`${AGENT}/AgentPanel.vue`));

  assert.ok(
    src.includes('data-test="send-wrap"'),
    '发送按钮外面要有包裹层（data-test="send-wrap"）'
  );
  // 包裹层带 title
  const wrapIdx = src.indexOf('data-test="send-wrap"');
  const wrap = src.slice(Math.max(0, wrapIdx - 300), wrapIdx + 100);
  assert.ok(
    /:title="sendTitle"/.test(wrap),
    '包裹层上要挂 :title="sendTitle" —— 挂在 ui-button 自身没用：' +
      'UiButton 在 disabled 时带 pointer-events-none，鼠标事件根本不落到它身上'
  );

  // ui-button 自身不得再有 title（否则又是那条老路）
  const btn = src.slice(src.indexOf('data-test="send-wrap"'));
  const btnSeg = btn.slice(0, btn.indexOf('</span>'));
  assert.ok(
    !/:title="/.test(btnSeg),
    'ui-button 自己不该再挂 title —— disabled 时它不派发鼠标事件，title 弹不出来'
  );

  // 三种情形都要有话说
  for (const key of ['sendBlockedNoKey', 'sendBlockedEmpty', 'agent.send']) {
    assert.ok(
      src.includes(key),
      `sendTitle 缺少 ${key} 这一支 —— 能发送、没配 Key、空草稿三种情形` +
        '都该给出对应说法'
    );
  }
});

test('T-160：canSend 把「没配 Key」和「空草稿」都算进去（禁用条件不能漂移）', () => {
  const src = strip(read(`${AGENT}/AgentPanel.vue`));
  assert.ok(
    /const canSend = computed\(\s*\(\) => Boolean\(draft\.value\.trim\(\)\) && configured\.value\s*\)/.test(
      src
    ),
    'canSend 应该是「有草稿 且 配好了」—— 写成别的形式（比如只看 draft）' +
      '会让没配 Key 时按钮可点，点了没反应'
  );
});

// —— 文案键两语齐备 ——
test('T-173 / T-160：新增文案键在 zh 与 en 里都在，且已删除的键确已删除', () => {
  const zh = localeOf('zh').pickTab;
  const en = localeOf('en').pickTab;

  for (const [lang, p] of [
    ['zh', zh],
    ['en', en],
  ]) {
    assert.equal(typeof p.autoHint, 'string', `${lang} 缺 pickTab.autoHint`);
    assert.equal(
      typeof p.pinnedHint,
      'string',
      `${lang} 缺 pickTab.pinnedHint`
    );
    assert.equal(typeof p.pinned, 'string', `${lang} 缺 pickTab.pinned`);
    assert.equal(p.title, undefined, `${lang} 的 pickTab.title 应已删除`);
    assert.equal(p.auto, undefined, `${lang} 的 pickTab.auto 应已删除`);
  }

  for (const lang of ['zh', 'en']) {
    const a = localeOf(lang);
    assert.equal(
      typeof a.sendBlockedNoKey,
      'string',
      `${lang} 缺 sendBlockedNoKey`
    );
    assert.equal(
      typeof a.sendBlockedEmpty,
      'string',
      `${lang} 缺 sendBlockedEmpty`
    );
  }
});
