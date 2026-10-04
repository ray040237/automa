/**
 * 确认门的展示载荷：把 `{ name, args }` 整形成用户放行前能看懂的结构。
 *
 * 为什么单独一个模块：AgentConfirmCard 是 .vue，本仓没有组件测试基建（见 T-26），
 * 写进组件的分支一条都测不到 —— 而这些分支恰恰决定「用户批准的到底是什么」。
 * 放成纯函数，`npm test` 才钉得住。
 *
 * 载荷形状（T-27 的原始缺陷就在这）：loop 发上来的是
 * `{ step, name, toolCallId, args }`，**没有顶层 `code`**（loop.js 的
 * `call.args` 在 executeCall 之前才赋值，`requestConfirmation({ ...call })`
 * 展开的是整个 call）。早先宿主读 `req.code`，恒为 `''`，确认卡的代码框永远是
 * 空的 —— 用户在盲批。本模块只认 `args`，顶层字段一律忽略。
 *
 * 红线（docs/adr/0002 已知欠账 / B5）：会话级授权只允许出现在 `test_js` 上。
 * workflow 写操作（add_block / update_block）永远逐次确认，`canRemember`
 * 就是那个闸；`shouldSkipConfirmation` 是它在放行路径上的同一件事。
 *
 * 本文件是纯函数，不 import 浏览器 API，也不 import 任何 i18n ——
 * 文案由卡片按 kind 取，本模块只负责「事实是什么」。
 */

/** 只有这一类工具允许「本会话不再问」。workflow 写操作永远不在其列。 */
const REMEMBERABLE_TOOLS = ['test_js'];

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function str(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 代码预估行数。剥掉尾部空行，否则 `'a\n'` 会被数成 2 行。
 *
 * @param {string} code
 * @returns {number}
 */
export function countLines(code) {
  if (!code) return 0;

  const normalized = String(code).replace(/\r\n/g, '\n').replace(/\n+$/, '');

  return normalized ? normalized.split('\n').length : 0;
}

/**
 * 参数序列化。画布写工具的 data 可能带循环引用（块数据由用户在编辑器里配），
 * 抛出去会让整张确认卡渲染崩掉，所以兜底成 String()。
 *
 * @param {*} value
 * @returns {string}
 */
function safeJson(value) {
  try {
    const out = JSON.stringify(value, null, 2);
    return typeof out === 'string' ? out : String(value);
  } catch (err) {
    return String(value);
  }
}

function joinLines(...parts) {
  return parts.filter(Boolean).join('\n');
}

/**
 * 这个工具能不能给「本会话允许试跑代码」。
 *
 * @param {string} name
 * @returns {boolean}
 */
export function canRememberSession(name) {
  return REMEMBERABLE_TOOLS.indexOf(name) !== -1;
}

/**
 * 本次确认的展示载荷。
 *
 * 返回的 `detail` 是给 `<pre>` 的原文（代码全文 / 选择器 / url / 画布 diff 摘要），
 * `kind` 是卡片切标题与提示文案的依据。两者都不含翻译 —— 事实与文案分开。
 *
 * @param {Object} req requestConfirmation 收到的载荷：`{ name, args }`
 * @param {Object} [options]
 * @param {string} [options.targetTitle] 目标页标题，仅 code / selector 的标题用
 * @returns {Object} { name, kind, action, targetTitle, canRemember, lines, blockId, nodeId, detail }
 */
export function buildConfirmation(req, options = {}) {
  const name = str(req && req.name);
  const args = asObject(req && req.args);
  const targetTitle = str(options.targetTitle);

  const base = {
    name,
    kind: 'generic',
    action: '',
    targetTitle,
    canRemember: canRememberSession(name),
    lines: 0,
    blockId: '',
    nodeId: '',
    detail: '',
  };

  if (name === 'test_js') {
    const code = str(args.code);

    return { ...base, kind: 'code', lines: countLines(code), detail: code };
  }

  if (name === 'highlight_selector') {
    const selector = str(args.selector);

    return { ...base, kind: 'selector', detail: selector };
  }

  if (name === 'open_url') {
    return { ...base, kind: 'url', detail: str(args.url) };
  }

  if (name === 'add_block') {
    const blockId = str(args.blockId);
    const data = asObject(args.data);

    return {
      ...base,
      kind: 'canvas',
      action: 'add',
      blockId,
      detail: joinLines(
        blockId && `blockId: ${blockId}`,
        Object.keys(data).length > 0 && safeJson(data)
      ),
    };
  }

  if (name === 'update_block') {
    const nodeId = str(args.nodeId);
    const data = asObject(args.data);

    return {
      ...base,
      kind: 'canvas',
      action: 'update',
      nodeId,
      detail: joinLines(
        nodeId && `nodeId: ${nodeId}`,
        Object.keys(data).length > 0 && safeJson(data)
      ),
    };
  }

  // 未知写工具（validateTools 会在装配期拦，这里是防御）：
  // 不猜、不隐藏，把参数原样摊开，用户至少看得到自己在放行什么。
  return { ...base, detail: safeJson(args) };
}

/**
 * 卡片点完按钮之后的答案形状。
 *
 * 既收卡片发来的 `{ approved, remember }`，也收宿主在切会话/卸载时直接甩的
 * `false`（agentHost 的 guardAgentSwitch 与 onBeforeUnmount）。布尔分支必须留，
 * 否则卸载时的放行会变成 `approved: false` 之外的未定义行为。
 *
 * 判定收紧到 `=== true`：宿主侧自己归一化完才 resolve 给 loop，
 * 与 loop 那侧 `answer.approved === false` 的判定始终一致（我们只交给它布尔）。
 *
 * @param {*} answer
 * @returns {{approved: boolean, remember: boolean}}
 */
export function normalizeAnswer(answer) {
  if (answer && typeof answer === 'object') {
    return {
      approved: answer.approved === true,
      remember: answer.remember === true,
    };
  }

  return { approved: answer === true, remember: false };
}

/**
 * 这次调用要不要跳过确认卡。
 *
 * 只有 `test_js` 且本会话授权仍在时为 true。workflow 写操作无论授权状态如何
 * 都必须逐次问（docs/adr/0002：会话授权不扩大到 workflow 写操作）。
 *
 * @param {string} name
 * @param {boolean} sessionAuth 本会话授权是否有效
 * @returns {boolean}
 */
export function shouldSkipConfirmation(name, sessionAuth) {
  return Boolean(sessionAuth) && canRememberSession(name);
}

/**
 * 下一次的会话授权状态。
 *
 * 授权只增不减：`test_js` 勾选并批准即置真；别的工具的答案（批准或拒绝）
 * 不撤销它 —— 撤销的入口是 abort / 切会话 / 面板卸载，见 agentHost。
 *
 * @param {boolean} current
 * @param {string} name
 * @param {*} answer
 * @returns {boolean}
 */
export function nextSessionAuth(current, name, answer) {
  if (current) return true;
  if (!canRememberSession(name)) return false;

  const normalized = normalizeAnswer(answer);

  return normalized.approved && normalized.remember;
}
