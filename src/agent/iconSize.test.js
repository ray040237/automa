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
 *   ② 尺寸收敛到 12/14/16/18 —— 18 是 T-213 新增的一档，只给
 *      composer 底行那两个 32px 的图标按钮用（见下）。
 *
 * T-213 的改动：发送/停止键从 40px（ui-button icon 的 h-10 + p-2 → 24px 内容）
 * 收到 32px（`!h-8 !w-8 !p-0`）。内容区不再是 24px 而是整个 32px，图标随之
 * 从 24 收到 **18** —— 32px 盒子里塞 24px 图标会显得"几乎填满、没有呼吸"，
 * 18px 是视觉平衡点（与 40→24 同比例，约 0.5625 vs 0.6）。
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

// —— ② 尺寸收敛，24 这个值不该再出现 ——
test('T-175：图标尺寸收敛到 12/14/16/18，不再有 24', () => {
  const files = agentFiles();
  const histogram = {};

  for (const file of files) {
    for (const icon of scanIcons(readFileSync(join(AGENT, file), 'utf8'))) {
      if (!icon.size) continue;
      histogram[icon.size] = (histogram[icon.size] || 0) + 1;
    }
  }

  assert.deepEqual(
    Object.keys(histogram).filter(
      (size) => !['12', '14', '16', '18'].includes(size)
    ),
    [],
    `出现了约定外的图标尺寸：${JSON.stringify(histogram)}`
  );

  // T-213：24 这一档已随「40px 图标按钮」一起退场，现在不该有任何图标用它。
  // 若将来又要加，请先想清楚宿主盒子多大 —— 这条断言的目的就是逼出那个思考。
  assert.equal(
    histogram['24'] || 0,
    0,
    '不该再有 24px 图标（T-213 把发送/停止键从 40px 收到 32px，图标随之到 18）'
  );
});
