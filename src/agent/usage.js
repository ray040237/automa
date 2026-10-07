/**
 * 会话下拉那三样东西的纯格式化：token 缩写、上下文水位、轮次时刻（T-09）。
 *
 * 为什么从 `.vue` 搬出来：本仓没有组件测试基建（`.vue` 里写的分支一条都测不到 ——
 * `confirm.js` / `sessions.js` 当初也是为这个理由抽出来的）。水位判定尤其需要
 * 单测：分母缺失、已用为负、超过 100 这几种情形在 UI 上长得完全不一样，
 * 靠肉眼分辨不出「显示 0%」和「不显示」的区别。
 */

/** token 数缩写：1234 -> 1.2k */
export function fmtTokens(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

/**
 * 上下文水位百分比（T-09③）。
 *
 * 分母是 `config.contextWindow` —— `config.js:38-42` 明说它是**建议值**（BYOK 场景
 * 协议不暴露真实窗口，只能按保守值取）。所以这个百分比是估算，UI 上要写明。
 *
 * 分母拿不到就返回 null，含义是「**整行不渲染**」而不是 0%：0% 会让用户以为
 * 「完全没占」，比不知道更糟。超过 100 **不在这里夹** —— 夹了用户就看不出已经超了，
 * 夹在宽度上由 CSS 的 max-width 处理。
 *
 * @param {{input?: number}|null} usage 本轮/本会话的 usage
 * @param {number} contextWindow config.contextWindow
 * @returns {number|null} 0 起头的整数百分比，或 null（无法计算）
 */
export function contextPercent(usage, contextWindow) {
  const win = Number(contextWindow);
  if (!Number.isFinite(win) || win <= 0) return null;
  // 先判 usage 本身，再取 input：`Number(usage && usage.input)` 在 usage 为
  // null 时算出 Number(null) === 0，会把「没有用量」显示成 0% —— 正好是这个
  // 函数要避免的那件事（单测 contextPercent(null, cw) === null 抓到的）。
  if (!usage || typeof usage !== 'object') return null;
  const used = Number(usage.input);
  if (!Number.isFinite(used) || used < 0) return null;
  return Math.round((used / win) * 100);
}

/**
 * 轮次分隔线上的时刻（T-09①）。
 *
 * 只取时分：会话是连续的，看日期没意义；一整行日期戳在 320px 侧栏里会把分隔线
 * 撑得比正文还长。用 Intl 而不是手搓 padStart —— 手搓会绕过分隔符与本地化。
 *
 * @param {number} at 毫秒时间戳，由 loop 在发 START 时就带上
 * @returns {string} 取不到合法时间返回空串（UI 隐藏时刻，不是显示 0）
 */
export function clockAt(at) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}
