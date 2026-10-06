/**
 * 用户自定义内容库：自定义指令（instructions）与 `/` 模板（command）。
 *
 * 与 config.js 同一分工：纯校验/归一在本文件，storage IO 从外部注入，
 * node --test 直接可测。两个功能各占一个 storage key —— 指令是「一段常驻
 * system prompt 的文本」，模板是「一组可触发的消息片段」，形状与生命周期
 * 都不同，合并存储只会让「删哪个」变得含糊。
 *
 * 术语见 CONTEXT.md，三个词不许混用：
 *   - 指令（instructions）：用户配置的持久偏好，进 system prompt；
 *   - 插话（instruction）：busy 期间用户补充的消息，入队走 drainInstructions；
 *   - 模板（command）：`/` 触发的消息片段，选中后填进输入框，用户可改再发。
 * 技能（skill）是 T-81b 的概念，本文件不承载。
 *
 * 体积策略：**不硬截断**（静默截断违反「不静默降级」），只有软限供 UI 警告。
 */

export const INSTRUCTIONS_KEY = 'automaAgentInstructions';
export const COMMANDS_KEY = 'automaAgentCommands';

/** 超过这个字符数 UI 出黄色警告；落盘与注入照常，由用户自己权衡。 */
export const INSTRUCTIONS_SOFT_LIMIT = 8192;

/**
 * 生成模板 id。同 config.js 的 newProviderId：本地生成、不承担安全职责，
 * 兜底也用不着讲究。直接用全局 crypto（node --test 与浏览器都有），
 * 不写 `globalThis.crypto`（eslint env 只声明 browser，那种写法过不了 no-undef）。
 */
export function newCommandId() {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return 'c_' + crypto.randomUUID();
  }

  return (
    'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  );
}

/**
 * 存储里的原始值 → 规范的指令文档。**纯函数**。
 *
 * enabled 缺省为 true：用户写了指令又没碰开关，意图显然是「要生效」。
 *
 * @param {Object|string} raw
 * @returns {{text: string, enabled: boolean}}
 */
export function normalizeInstructions(raw) {
  const src =
    raw && typeof raw === 'object'
      ? raw
      : { text: typeof raw === 'string' ? raw : '' };

  return {
    text: String(src.text || ''),
    enabled: src.enabled === undefined ? true : Boolean(src.enabled),
  };
}

/**
 * 该进 system prompt 的指令文本。**纯函数**。
 *
 * 关闭 = 用户显式关掉的，返回空串（而不是删掉文本）—— 开关是暂时的，
 * 文本是用户的财产。
 *
 * @param {{text: string, enabled: boolean}} doc normalizeInstructions 的产物
 * @returns {string}
 */
export function getActiveInstructions(doc) {
  const d = normalizeInstructions(doc);

  return d.enabled ? d.text : '';
}

/** 读指令文档。 */
export async function loadInstructions(io) {
  return normalizeInstructions(await io.get(INSTRUCTIONS_KEY));
}

/** 写指令文档。 */
export async function saveInstructions(io, doc) {
  await io.set(INSTRUCTIONS_KEY, normalizeInstructions(doc));
}

/**
 * 读取「该进 system prompt 的指令」一步到位。运行时（agentHost）每轮 send 调
 * 一次 —— 存储读取便宜，用户改完指令下一轮立即生效，与 enabledGroups
 * 函数化的既有决策一致。
 *
 * @param {{get: Function}} io
 * @returns {Promise<string>} 关闭或未配置时为空串
 */
export async function getActiveInstructionsFrom(io) {
  return getActiveInstructions(await io.get(INSTRUCTIONS_KEY));
}

/**
 * 存储里的原始值 → 规范的模板记录。**纯函数**，坏字段归一而不是抛 ——
 * 与 config.js 的 normalizeDoc 同一立场：手改存储不该让整份列表加载不出来。
 * 真正的「填没填对」由 validateCommands 按条报错，不在这里静默吞。
 *
 * @param {Object} raw
 * @returns {Object} {id, name, description, body, enabled}
 */
export function normalizeCommand(raw) {
  const src = raw || {};

  return {
    id: String(src.id || '') || newCommandId(),
    name: String(src.name || '').trim(),
    description: String(src.description || '').trim(),
    body: String(src.body || ''),
    enabled: src.enabled === undefined ? true : Boolean(src.enabled),
  };
}

/**
 * 校验并归一整份模板列表。**纯函数**。
 *
 * 名字是 `/` 触发时的匹配键，重名会让「选的是哪个」没法回答 —— 与
 * config.js 对连接重名的处理同一立场：直接报错，不自动改名。
 *
 * @param {Object[]} input
 * @returns {{ok: boolean, errors: string[], commands: Object[]}}
 */
export function validateCommands(input) {
  const errors = [];
  const commands = [];
  const seenNames = new Map();

  (Array.isArray(input) ? input : []).forEach((raw, i) => {
    const c = normalizeCommand(raw);
    const tag = c.name || `第 ${i + 1} 条`;

    if (!c.name) errors.push(`第 ${i + 1} 条模板：缺少名称`);
    if (!c.body.trim()) errors.push(`模板「${tag}」：正文不能为空`);

    if (c.name) {
      const key = c.name.toLowerCase();
      if (seenNames.has(key)) {
        errors.push(
          `模板名「${c.name}」重复了（另一条在第 ${seenNames.get(key) + 1} 位）`
        );
      } else {
        seenNames.set(key, i);
      }
    }

    commands.push(c);
  });

  return { ok: errors.length === 0, errors, commands };
}

/** 读模板列表（归一，不校验 —— 列表展示用；保存走 saveCommands）。 */
export async function loadCommands(io) {
  const raw = await io.get(COMMANDS_KEY);

  return (Array.isArray(raw) ? raw : []).map(normalizeCommand);
}

/**
 * 校验并保存模板列表。校验不过不写盘。
 *
 * @param {{set: Function}} io
 * @param {Object[]} input
 * @returns {Promise<{ok: boolean, errors: string[]}>}
 */
export async function saveCommands(io, input) {
  const { ok, errors, commands } = validateCommands(input);
  if (!ok) return { ok: false, errors };

  await io.set(COMMANDS_KEY, commands);

  return { ok: true, errors: [] };
}

/**
 * 从输入框草稿解析 `/` 触发。**纯函数**，面板的菜单开合与过滤都吃它的结论。
 *
 * 触发条件：trimStart 后以 `/` 开头，且首段空白之前只有这一段 ——
 * `/{query}` 整体是一个无空白 token。带空格/换行说明用户在写以斜杠开头的
 * 普通消息（「/r/n 是什么」），不是在找模板。
 *
 * @param {string} draft
 * @returns {string|null} 匹配串（`/` 之后的部分）；未触发为 null
 */
export function parseSlashDraft(draft) {
  const m = /^\/([^\s]*)$/.exec(String(draft || '').trimStart());

  return m ? m[1] : null;
}

/**
 * 按匹配串过滤可触发的模板。**纯函数**。
 *
 * 只回 enabled 的：菜单是「我现在要发什么」的选择器，停用项混在里面
 * 等于让用户每次都跳过它们。大小写不敏感的子串匹配，同时打名称与描述。
 *
 * @param {Object[]} commands 已归一的模板列表
 * @param {string} query parseSlashDraft 的产物；空串 = 全部
 * @returns {Object[]}
 */
export function filterCommands(commands, query) {
  const q = String(query || '').toLowerCase();

  return (commands || [])
    .filter((c) => c.enabled && c.body.trim())
    .filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
    );
}
