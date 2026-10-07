/**
 * 助手空态的示例问法与工具组徽标（T-10）。
 *
 * 为什么放纯模块而不是面板模板里：本仓没有组件测试基建（`.vue` 一条都挂不进
 * `npm test`），写进 SFC 的分支一条都测不到 —— 这正是 `confirm.js` /
 * `sessions.js` 当初被抽出来的理由。分组与示例的选择全是纯数据决策，单测能钉住。
 *
 * 铁律（红线级）：**徽标与示例只能由宿主的 enabledGroups 推导**，绝不许各宿主
 * 自己写一份文案/清单。独立助手页不开放 canvas 组，徽标里就不能出现「画布」——
 * 让它从同一个 enabledGroups 出���，徽标就不可能说谎。
 */

// 徽标的展示顺序固定，与 enabledGroups 的书写顺序无关：
// 同一组能力在不同宿主里应当出现在同一个位置，否则用户会以为顺序有含义。
const GROUP_ORDER = ['page', 'context', 'tab', 'canvas'];

/**
 * 宿主开放的工具组徽标。未知组保留在末尾（不吞掉）：宿主将来加了新组，
 * 徽标少一个总比默默显示成空列表好排查。
 *
 * @param {Array<string>|(() => Array<string>)} enabledGroups 与 runtime 同一份（函数形式照样求值）
 * @returns {Array<{id: string}>}
 */
export function capabilityGroups(enabledGroups) {
  const raw =
    typeof enabledGroups === 'function' ? enabledGroups() : enabledGroups;
  const groups = Array.isArray(raw) ? raw.filter(Boolean) : [];

  const known = GROUP_ORDER.filter((g) => groups.includes(g));
  const unknown = groups.filter((g) => !GROUP_ORDER.includes(g));

  return [...known, ...unknown].map((id) => ({ id }));
}

// 每个示例标注 needs：只有宿主开放了全部 needs 里的组，这个示例才成立。
// 「加一个块」在无画布的助手页是做不到的，展示它等于骗用户。
const EXAMPLES = [
  {
    id: 'readPage',
    needs: ['page'],
    text: '这个页面在做什么？帮我总结一下重点',
  },
  { id: 'findText', needs: ['page'], text: '找一下页面里提到价格的文字' },
  {
    id: 'explainVar',
    needs: ['context'],
    text: '这个工作流里的变量都是干什么的？',
  },
  { id: 'addBlock', needs: ['canvas'], text: '在画布里加一个等待 5 秒的块' },
  { id: 'listTabs', needs: ['tab'], text: '我现在开着哪些标签页？' },
];

/**
 * 按宿主开放的工具组挑示例问法。
 *
 * 至少留一条：宿主只开放冷门组时（groups 与 EXAMPLES 的 needs 完全不交），
 * 空态会退回「一句提示」，那正是这条要解决的问题 —— 所以兜底给通用的一条。
 *
 * @param {Array<string>|(() => Array<string>)} enabledGroups
 * @param {number} [limit=4] 面板窄，最多给这么多
 * @returns {Array<{id: string, text: string}>}
 */
export function suggestExamples(enabledGroups, limit = 4) {
  const raw =
    typeof enabledGroups === 'function' ? enabledGroups() : enabledGroups;
  const groups = Array.isArray(raw) ? raw.filter(Boolean) : [];

  const usable = EXAMPLES.filter((e) =>
    e.needs.every((g) => groups.includes(g))
  );
  const picked = usable.slice(0, Math.max(0, limit));

  if (picked.length > 0) return picked;

  return [{ id: 'generic', text: '帮我看看这个页面能做什么' }].slice(0, limit);
}
