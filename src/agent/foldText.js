/**
 * 用户气泡的折叠判定（T-205）。
 *
 * 为什么从 `.vue` 搬出来：本仓没有组件测试基建，`.vue` 里的分支一条都测不到
 * （`usage.js` / `confirm.js` / `fold.js` 当初都是为这个理由抽出来的）。
 * 折叠判定里有三个很容易写错、又不容易在界面上看出来的边界：
 *
 *   ① **没量到高度时不能折。** 组件首帧 `scrollHeight` 还是 0（尚未布局），
 *      若此时把「0 > 240 吗」当真，就会把每条消息判成「不需要折」——看起来
 *      只是「长消息偶尔不折」；反过来若把「量不到」当成「要折」，短消息会在
 *      首帧闪一下折叠态。两种都是静默的、靠肉眼盯不住的错。
 *   ② **阈值附近不能抖动。** 展开后高度必然变大，若展开/收起用同一个阈值，
 *      展开的瞬间「已超阈值 → 立刻又折回去」，用户看到按钮点了没反应。
 *      所以判定要认 `expanded`：一旦展开就不再看高度。
 *   ③ **空/非法输入要明确**，不能被 `Number` 的隐式转换糊过去。
 */

/**
 * 折叠阈值：超过就折。
 *
 * 240px 这个数取自参考实现（`pie-ai-agent` 的 `COLLAPSED_MAX_PX = 240`）。
 * 它大约是一屏（320px 侧栏正文区 ~500px）的一半 —— 再高就装不下助手的回答，
 * 再低会把「三五行正常的提问」也折起来，反而不如不折。
 */
export const USER_FOLD_MAX_PX = 240;

/**
 * 给定量到的高度与展开状态，决定这一条要不要折、当前是不是折着的。
 *
 * @param {object} opts
 * @param {number} opts.measuredPx 组件量到的内容高度（`scrollHeight`）。未测量时为 0。
 * @param {boolean} [opts.expanded] 用户是否已点过「展开」
 * @param {number} [opts.maxPx] 阈值，默认 {@link USER_FOLD_MAX_PX}
 * @returns {{ foldable: boolean, collapsed: boolean }}
 *   `foldable` = 这条是否**本来就该**给折叠能力（内容超过阈值）；
 *   `collapsed` = 此刻是否处于折叠态。两者不同：展开过的长消息
 *   `foldable: true` 但 `collapsed: false`，组件据此渲染「收起」而不是「展开」。
 */
export function foldDecision({
  measuredPx,
  expanded = false,
  maxPx = USER_FOLD_MAX_PX,
} = {}) {
  const h = Number(measuredPx);
  // 量不到（0 / NaN / 负数）→ 不折。见头注①：宁可这条不折，
  // 也不要在首帧把内容折起来闪一下。
  if (!Number.isFinite(h) || h <= 0) {
    return { foldable: false, collapsed: false };
  }
  const limit = Number(maxPx);
  const foldable = Number.isFinite(limit) && limit > 0 && h > limit;
  if (!foldable) return { foldable: false, collapsed: false };
  // 一旦展开就不再看高度（头注②）：展开态是用户的显式选择，不该被
  // 「现在高度又超了」覆盖回去。
  return { foldable: true, collapsed: !expanded };
}
