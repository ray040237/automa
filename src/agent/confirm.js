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
 * 文案由卡片按 kind 取。「危险面」的事实（kind/detail）由工具自带的
 * confirmDetail 提供（T-134），本模块负责载荷形状、归属与兜底。
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
 * 导出给各写类工具的 confirmDetail 复用（T-134）——格式化助手只此一份。
 *
 * @param {*} value
 * @returns {string}
 */
export function safeJson(value) {
  try {
    const out = JSON.stringify(value, null, 2);
    return typeof out === 'string' ? out : String(value);
  } catch (err) {
    return String(value);
  }
}

/** 过滤假值后按行拼装 detail。导出理由同 safeJson（T-134）。 */
export function joinLines(...parts) {
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
 * 「用户到底在放行什么」的事实由**工具自带**（T-134）：写类工具定义里的
 * `confirmDetail(args)` 返回工具特有部分（kind / action / lines / blockId /
 * nodeId / detail），本模块只补基础形状并钉死归属 —— name、targetTitle、
 * canRemember 永远以这里为准，工具的 confirmDetail 不得覆盖。工具没带
 * confirmDetail（未知工具 / 调用方没传 tool）时不猜：参数原样 JSON 摊开，
 * 用户至少看得到自己在放行什么。
 *
 * 返回的 `detail` 是给 `<pre>` 的原文（代码全文 / 选择器 / url / 画布 diff 摘要），
 * `kind` 是卡片切标题与提示文案的依据。两者都不含翻译 —— 事实与文案分开。
 *
 * @param {Object} req requestConfirmation 收到的载荷：`{ name, args, tool }`
 * @param {Object} [req.tool] 被闸到的工具定义（loop 的 beforeToolCall 已查到）
 * @param {Object} [options]
 * @param {string} [options.targetTitle] 目标页标题，仅 code / selector 的标题用
 * @returns {Object} { name, kind, action, targetTitle, canRemember, lines, blockId, nodeId, detail }
 */
export function buildConfirmation(req, options = {}) {
  const name = str(req && req.name);
  const args = asObject(req && req.args);
  const targetTitle = str(options.targetTitle);
  const tool =
    req && req.tool && typeof req.tool === 'object' ? req.tool : null;

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

  if (tool && typeof tool.confirmDetail === 'function') {
    const mine = asObject(tool.confirmDetail(args));

    return {
      ...base,
      ...mine,
      // 归属钉死：这三样是闸与宿主的知识，工具的 confirmDetail 不得覆盖 ——
      // canRemember 尤其是 ADR 0002 / B5 的闸（只有 test_js 能给会话授权）。
      name: base.name,
      targetTitle: base.targetTitle,
      canRemember: base.canRemember,
    };
  }

  // 防御兜底：validateTools 已强制 write 工具带 confirmDetail，走到这里
  // 说明是未知工具或调用方没传 tool —— 不猜，原样摊开。
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

/**
 * 会话级授权 + 挂起确认的完整状态机（T-90）。
 *
 * useAgentHost 原先把这些散在闭包里：sessionAuth 标志、挂起的确认载荷、
 * 切换守卫的「先拒挂起、再失效授权」顺序约束 —— composable 没有测试基建，
 * 这些分支一条都测不到。抽成纯状态机后 npm test 可钉住：
 * 授权只能经 record 置真、三个失效点（abort / 切会话 / 面板卸载）语义一致、
 * planSwitch 的动作顺序。
 *
 * agentHost 只留副作用执行：把 pending 挂到 reactive 上、resolve promise、
 * 调 runtime。
 *
 * @param {Object} deps
 * @param {(req: Object) => Object} [deps.buildPayload] 把 `{name,args,tool}`
 *   组装成确认卡展示载荷（agentHost 传 buildConfirmation 包 targetTitle）；
 *   缺省原样透传。
 * @returns {Object} 状态机
 */
export function createSessionAuth(deps = {}) {
  const buildPayload = deps.buildPayload || ((req) => req);
  let authorized = false;
  let pending = null;

  return {
    get pending() {
      return pending;
    },
    get authorized() {
      return authorized;
    },

    /**
     * 发起一次确认。已授权的 test_js 直接放行（B5：只有它能记住会话授权），
     * 其余挂起并返回 `{ skip: false }`，载荷从 pending 取。
     *
     * @param {{name: string, args: Object}} req
     * @returns {{skip: boolean}}
     */
    ask(req) {
      if (shouldSkipConfirmation(req && req.name, authorized)) {
        return { skip: true };
      }
      pending = buildPayload(req);
      return { skip: false };
    },

    /**
     * 对挂起确认的应答：归一化（对象与布尔都收）、按 nextSessionAuth 记录
     * 授权、清掉挂起。没有挂起时是 no-op（宿主的重复放行路径会走到）。
     *
     * @param {Object|boolean} answer
     * @returns {{approved: boolean}|null}
     */
    answer(answer) {
      if (!pending) return null;
      const normalized = normalizeAnswer(answer);
      authorized = nextSessionAuth(authorized, pending.name, normalized);
      pending = null;
      return { approved: normalized.approved };
    },

    /** 失效会话授权 —— abort / 切会话 / 面板卸载三个失效点共用。 */
    invalidate() {
      authorized = false;
    },

    /**
     * 切会话 / 新建会话守卫的纯决策。
     *
     * 动作顺序由调用方按返回值执行：先 `rejectPending`（内部 answer(false)
     * 会经 nextSessionAuth 记录一次）再 `invalidate` —— nextSessionAuth 对
     * 非授权工具的答案「只增不减」，顺序反了同样收敛到 false，但按此顺序
     * 两步的语义各自成立，不依赖「碰巧相等」。
     *
     * @param {{busy?: boolean}} state
     * @returns {{allow: boolean, rejectPending: boolean, invalidate: boolean}}
     */
    planSwitch(state = {}) {
      if (state.busy) {
        return { allow: false, rejectPending: false, invalidate: false };
      }
      return {
        allow: true,
        rejectPending: pending != null,
        invalidate: true,
      };
    },
  };
}
