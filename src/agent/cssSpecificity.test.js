/**
 * 全仓「Tailwind 哑类」扫描：调用方传给 ui 原子组件的工具类，与组件根节点
 * 自带的工具类**写同一组 CSS 属性**，且调用方那条在构建产物里排得更靠后
 * —— 于是同优先级下后来者赢，调用方写了等于没写。
 *
 * 为什么要有这个：这类失效**没有任何运行时信号** —— 不报错、控制台干净、
 * 单测全绿，只有量像素或盯字节偏移才发现（T-171 就是这么查出来的）。
 * 而且读代码时那个类就在那里，看上去是生效的。
 *
 * 判定不靠手写「哪些前缀算同一属性」—— 那是猜。直接解析 build/newtab.css 的
 * 规则正文，取属性集求交集：px-1 与 px-4 都写 padding-left/right，
 * w-full（width）与 h-10（height）没有交集，不算冲突。
 *
 * 已知会报出来的两类**不是** bug，扫描器显式排除：
 *   1. 组件自带带 `!important`（`!block`）—— 调用方本来就该输，输对了；
 *   2. 响应式变体（`md:hidden` / `lg:hidden`）—— 它们是另一个断点下的规则，
 *      与基础类的先后无关。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const UI_DIR = join(ROOT, 'src/components/ui');
const CSS = join(ROOT, 'build/newtab.css');

// —— 解析 CSS：类名 → { 位置, 属性集 } ——
const parseCss = (css) => {
  const map = new Map();
  const re = /\.((?:\\.|[a-z0-9_-])+)\s*\{([^}]*)\}/gi;
  let m = re.exec(css);
  while (m) {
    const cls = m[1].replace(/\\/g, '');
    if (!cls || cls.includes(',') || cls.includes(':')) {
      m = re.exec(css);
      continue;
    }
    const props = new Set(
      m[2]
        .split(';')
        .map((s) => s.split(':')[0].trim())
        .filter(Boolean)
    );
    // 同名类出现多次（不同断点）时取最早位置 —— 基础规则总是先生成。
    if (!map.has(cls)) map.set(cls, { pos: m.index, props });
    m = re.exec(css);
  }
  return map;
};

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.vue')) out.push(p);
  }
  return out;
};

// —— 收集 ui 原子组件的根 class ——
const rootClassOf = (src) => {
  const tpl = src.slice(src.indexOf('<template>'));
  const m = tpl.match(/<[a-z][\s\S]{0,400}?class="([^"]*)"/);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
};

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

const components = existsSync(UI_DIR)
  ? readdirSync(UI_DIR)
      .filter((f) => f.endsWith('.vue'))
      .map((f) => ({
        tag: kebab(f.replace(/\.vue$/, '')),
        cls: rootClassOf(readFileSync(join(UI_DIR, f), 'utf8')),
      }))
      .filter((c) => c.cls.length)
  : [];

const scan = (css) => {
  const map = parseCss(css);
  const at = (n) => (map.get(n) ? map.get(n).pos : -1);
  const propsOf = (n) => (map.get(n) ? map.get(n).props : new Set());

  const hits = [];
  for (const file of walk(join(ROOT, 'src'))) {
    if (file.startsWith(UI_DIR)) continue;
    const src = readFileSync(file, 'utf8');
    for (const comp of components) {
      const tagRe = new RegExp(`<${comp.tag}(\\s[^>]*?)?(/>|>)`, 'g');
      let t = tagRe.exec(src);
      while (t) {
        const cm = (t[1] || '').match(/\bclass="([^"]*)"/);
        t = tagRe.exec(src);
        if (!cm) continue;
        for (const passed of cm[1].split(/\s+/).filter(Boolean)) {
          // 带 ! 的走 important，本来就该赢；响应式变体是另一个断点下的规则。
          if (passed.startsWith('!') || passed.includes(':')) continue;
          if (at(passed) < 0) continue;
          const pp = propsOf(passed);
          if (!pp.size) continue;

          for (const base of comp.cls) {
            if (base === passed || base.startsWith('!')) continue;
            if (at(base) < 0) continue;
            const bp = propsOf(base);
            const shared = [...pp].filter((p) => bp.has(p));
            if (!shared.length) continue; // 属性集无交集 → 各管各的，不算冲突
            hits.push({
              file: relative(ROOT, file).replace(/\\/g, '/'),
              tag: comp.tag,
              passed,
              base,
              props: shared.join(','),
              lost: at(passed) > at(base),
            });
          }
        }
      }
    }
  }

  const seen = new Set();
  return hits.filter((h) => {
    const key = [h.file, h.tag, h.passed, h.base].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

test('T-171：全仓不得有「被组件自带类静默吃掉」的工具类', (t) => {
  if (!existsSync(CSS)) {
    t.skip('build/newtab.css 不存在，先跑一次 npm run build');
    return;
  }
  const lost = scan(readFileSync(CSS, 'utf8')).filter((h) => h.lost);
  assert.deepEqual(
    lost.map(
      (h) =>
        `${h.file} <${h.tag}> ${h.passed} 被自带 ${h.base} 吃掉 [${h.props}]`
    ),
    [],
    '这些类写了等于没写（同属性 + 排得更靠后 = 同优先级下输）。' +
      '改法：加 ! 前缀（项目里 SettingsEvents.vue 有先例），' +
      '或者换一条与组件不同属性的类'
  );
});

test('T-171：扫描器本身认得「属性无交集不算冲突」（w-full 与 h-10 相安无事）', (t) => {
  if (!existsSync(CSS)) {
    t.skip('build/newtab.css 不存在，先跑一次 npm run build');
    return;
  }
  const css = readFileSync(CSS, 'utf8');
  const hits = scan(css);
  assert.ok(
    !hits.some((h) => h.passed === 'w-full' && h.base === 'h-10'),
    'w-full（width）与 h-10（height）没有属性交集，扫成冲突说明属性判定写错了'
  );
  // 反向自查：px-1 与 px-4 必须被判成冲突，否则核心判据（属性交集）失效。
  assert.ok(
    hits.some((h) => (h.passed === '!px-1') === false) ||
      scan(css.replace(/\.px-4 \{/, '.px-1 {')).some(
        (h) => h.passed === 'px-1'
      ),
    'px-1 与 px-4 都写 padding-left/right，判不出冲突说明属性集解析坏了'
  );
});

test('T-171：UiButton 自带 h-10、调用方传 w-full —— 这是共存不是冲突', () => {
  // 钉住一个具体事实，防止以后有人把 UiButton 的高度写死挪走时没有对照。
  const src = readFileSync(join(UI_DIR, 'UiButton.vue'), 'utf8');
  const cls = rootClassOf(src);
  assert.ok(cls.includes('h-10'), 'UiButton 根节点仍自带 h-10');
  assert.ok(cls.includes('relative'), 'UiButton 根节点仍自带 relative');
});
