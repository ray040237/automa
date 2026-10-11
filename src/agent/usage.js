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
 * 水位分档阈值（T-163）。
 *
 * 放在这里而不是 `.vue` 里，是因为**两处要用同一个数**：环自己要按它决定
 * 渲不渲染、父组件要按它决定要不要套那个 dropdown。常量留在组件里就只能
 * 在两处各写一遍 80，改一处忘一处。
 *
 * 80 起提示、95 起告急。比早期的 70/90 更晚 —— 实测反馈是「平时零干扰」比
 * 「早预警」更值钱，水面下那 10 个点不足以打断输入。
 */
export const CONTEXT_WARN_AT = 80;
export const CONTEXT_CRITICAL_AT = 95;

/**
 * 上下文水位百分比（T-09③；T-222 起分子改为实测上下文占用）。
 *
 * 分子是 `contextTokens` —— loop 在 DONE 事件上带出的实测值
 * （compaction.measuredContextTokens：最后一次请求的 input+cacheRead+
 * cacheWrite + 尾部估算）。曾经直接读 usage.input，但那是跨轮累加的
 * **计费**输入总量：多轮会话水位单调虚高（10 轮能显示 300%+），缓存命中
 * 时又偏低——「花了多少」与「占了多少」是两个量纲，完整论述见 compaction.js。
 * 取不到实测（端点没回 usage / 全是重放历史）时上游传 null。
 *
 * 分母是 `config.contextWindow` —— `config.js:38-42` 明说它是**建议值**（BYOK 场景
 * 协议不暴露真实窗口，只能按保守值取）。所以这个百分比是估算，UI 上要写明。
 *
 * 分子或分母拿不到就返回 null，含义是「**整行不渲染**」而不是 0%：0% 会让用户
 * 以为「完全没占」，比不知道更糟。超过 100 **不在这里夹** —— 夹了用户就看不出
 * 已经超了，夹在宽度上由 CSS 的 max-width 处理。
 *
 * @param {number|null} usedTokens 实测上下文占用，null = 无实测
 * @param {number} contextWindow config.contextWindow
 * @returns {number|null} 0 起头的整数百分比，或 null（无法计算）
 */
export function contextPercent(usedTokens, contextWindow) {
  const win = Number(contextWindow);
  if (!Number.isFinite(win) || win <= 0) return null;
  // 先判空再 Number：Number(null) === 0，会把「没有实测」显示成 0% ——
  // 正好是这个函数要避免的那件事（单测 contextPercent(null, cw) === null 抓到的）。
  if (usedTokens === null || usedTokens === undefined) return null;
  const used = Number(usedTokens);
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
