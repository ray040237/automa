/**
 * 图标尺寸守卫（T-175）。
 *
 * 背景：`v-remixicon` 的 `size` 默认是 **24**（见 node_modules/v-remixicon 的
 * props 定义），渲染成 `<svg width="24" height="24">`。24px 放在 320px 侧栏的
 * 对话流里是**很大的** —— 一条 text-xs(12px) 的折叠行、一个 11px 的状态徽标，
 * 塞进 24px 图标后行高被图标整个顶起来。用户反馈的「工具调用显示很大」，
 * 主因其实在这里，而不是字号。
 *
 * 2026-10 实测：agent 面板 25 个图标里 **24 个**没给 size（唯一给了的是
 * 「回到底部」那个 `size="14"`）。也就是说这个默认值一直在替所有图标做决定，
 * 而没有任何一处是"有意选的 24"。
 *
 * 本守卫钉两件事：
 *   ① 每个 `<v-remixicon>` 都必须**显式**声明 size（不许再吃默认值）；
 *   ② 尺寸收敛到 12/14/16 —— 唯一的例外是 ui-button 的 icon 变体内部
 *      （h-10 + p-2，内容区正好 24px，图标填满才算「图标按钮」），
 *      只有 composer 的发送/停止两处，且名字写死在这里，多的就会被拦下。
 *
 * 为什么值得单开一个文件：图标默认值这种"看不见的全局决定"最容易在新增
 * 界面里悄悄复发，而单测、lint、构建、i18n 全都看不见它 —— 只有量像素的
 * 守卫能发现（与 cssSpecificity 同型的"肉眼与工具都过的坑"）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT = join(ROOT, 'src/components/newtab/workflow/agent');

const ICON = /<v-remixicon\b[\s\S]*?\/>/g;

/** 把一个 .vue 里的图标标签拆成 { tag, size, name }；size/name 缺失时为 null。 */
export function scanIcons(src) {
  return (src.match(ICON) || []).map((tag) => {
    const size = tag.match(/\bsize="([^"]*)"/);
    const name = tag.match(/\bname="([^"]*)"/);
    return { tag, size: size ? size[1] : null, name: name ? name[1] : null };
  });
}

const agentFiles = () =>
  readdirSync(AGENT).filter((file) => file.endsWith('.vue'));

// —— 自检：扫描器抓不住"缺 size"的话，下面两条断言全是假绿 ——
test('T-175 自检：扫描器必须能识别缺失的 size', () => {
  const found = scanIcons('<v-remixicon name="riAddLine" class="shrink-0" />');
  assert.equal(found.length, 1, '扫描器没匹配到图标标签');
  assert.equal(
    found[0].size,
    null,
    '扫描器把缺 size 的图标读成了有 size —— 守卫本身失效'
  );
  assert.equal(found[0].name, 'riAddLine');
});

// —— ① 不许再吃默认 24px ——
test('T-175：agent 面板每个 v-remixicon 都必须显式给 size', () => {
  const files = agentFiles();
  assert.ok(files.length >= 8, 'agent 组件目录扫描异常，守卫本身失效');

  const offenders = [];
  let total = 0;
  for (const file of files) {
    for (const icon of scanIcons(readFileSync(join(AGENT, file), 'utf8'))) {
      total += 1;
      if (!icon.size) {
        offenders.push(
          `${file}: ${icon.tag.replace(/\s+/g, ' ').slice(0, 90)}`
        );
      }
    }
  }

  assert.ok(
    total >= 20,
    `只扫到 ${total} 个图标，守卫本身可能失效（预期 25 个左右）`
  );
  assert.deepEqual(
    offenders,
    [],
    [
      '这些 v-remixicon 没给 size —— 会落到默认 24px，把 12/14px 的行顶高：',
      ...offenders,
    ].join('\n')
  );
});

// —— ② 尺寸收敛，ui-button 里的 24 是唯二例外 ——
test('T-175：图标尺寸收敛到 12/14/16，24 只留给 ui-button 内的两个按钮图标', () => {
  const files = agentFiles();
  const histogram = {};
  const bigNames = [];

  for (const file of files) {
    for (const icon of scanIcons(readFileSync(join(AGENT, file), 'utf8'))) {
      if (!icon.size) continue;
      histogram[icon.size] = (histogram[icon.size] || 0) + 1;
      if (icon.size === '24') bigNames.push(icon.name || '(动态名)');
    }
  }

  assert.deepEqual(
    Object.keys(histogram).filter(
      (size) => !['12', '14', '16', '24'].includes(size)
    ),
    [],
    `出现了约定外的图标尺寸：${JSON.stringify(histogram)}`
  );

  // 这两处是 composer 的发送/停止：ui-button 的 icon 变体固定 h-10，
  // 内边距 p-2，内容区正好 24px。其余图标都没有固定高度的宿主，
  // 24px 只会把行撑高 —— 所以「多一个 24」是需要被看见的决定，不是顺手。
  assert.deepEqual(
    bigNames.sort(),
    ['riArrowRightLine', 'riStopLine'],
    [
      '只有 composer 的发送(riArrowRightLine)/停止(riStopLine)该用 24px',
      `实际用到 24px 的是：${JSON.stringify(bigNames)}`,
    ].join('\n')
  );
});
