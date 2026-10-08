/**
 * `@` 触发：从输入框草稿解析「要选哪个标签页」（T-165）。
 *
 * 与 customizations.js 的 `/` 同一分工：纯解析在本文件，UI 只消费结论。
 * 搬出来的理由和那里一样 —— `.vue` 里写的分支一条都测不到，而这套判定的边界
 * 恰恰是肉眼分不出对错的那种：「a@b 该不该触发」「@ 后面打了空格还算不算查询」
 * 「光标停在中间时该摘哪一段」。
 *
 * 术语（与 `/` 的区别，两条不许混）：
 *   - `/` 是**整框态**：整框以 / 开头，选中后把整框替换成模板正文；
 *   - `@` 是**词内态**：写在正文中间，选中后**只摘掉 @token 自己**，副作用是
 *     「把目标页改掉」，正文其余部分原样保留。
 */

/**
 * 解析草稿里光标处的 @ token。**纯函数**。
 *
 * 触发条件：光标前紧邻一个 `@`，且 `@` 前面是行首或空白 ——
 * 「a@b」是邮箱 / 社交句柄，不是在选目标页。
 *
 * token 里不含空白也不含 `@`：`@a@b` 的第二个 @ 是下一个 token 的开始，
 * 而 `@淘宝 然后` 里空格之后就不再是查询串了（用户已经写完这一句）。
 *
 * @param {string} draft 输入框内容
 * @param {number=} caret 光标位置；不传按草稿末尾算（面板在 keydown 里读
 *   selectionStart 传进来，SSR 的渲染桩拿不到，所以它是可省的）
 * @returns {{query: string, start: number, end: number}|null}
 *   start/end 是 token（含 @）在 draft 里的下标范围，选中后按它摘掉。
 */
export function parseAtDraft(draft, caret) {
  const text = String(draft || '');

  // 光标位置越界一律夹住：selectionStart 在某些输入法组合过程中会给出陈旧值
  const at =
    caret === undefined || caret === null
      ? text.length
      : Math.min(Math.max(Number(caret) || 0, 0), text.length);

  const before = text.slice(0, at);
  const m = /@([^\s@]*)$/.exec(before);
  if (!m) return null;

  const start = at - m[0].length;

  // @ 前面必须是行首或空白
  if (start > 0 && !/\s/.test(text[start - 1])) return null;

  return { query: m[1], start, end: at };
}

/**
 * 选中标签页之后把 @token 从草稿里摘掉。**纯函数**。
 *
 * 为什么是「摘掉」而不是像 `/` 那样整框替换：@ 的作用是改目标页，正文里那个
 * `@淘宝` 只是输入过程中用的把手，留着会被一起发给模型（模型看到一串
 * 「@淘宝」只会困惑）。
 *
 * @param {string} draft
 * @param {{start: number, end: number}|null} token parseAtDraft 的产物
 * @returns {string} 摘掉后的草稿；token 为空时原样返回
 */
export function stripAtToken(draft, token) {
  const text = String(draft || '');
  if (!token) return text;

  return text.slice(0, token.start) + text.slice(token.end);
}

/**
 * 把列表里的一个 tab 变成「选中目标页」的载荷。**纯函数**。
 *
 * 两处要用同一个形状：标签页列表（AgentTabList 点击）与 @ 菜单（选中）。分开
 * 各写一份的话，漏掉 favIconUrl 的那份会让 chip 上永远显示地球图标（T-08 踩过），
 * 而这两处长得几乎一样，靠肉眼看不出谁漏了字段。
 *
 * @param {Object} tab 列表项
 * @param {number=} windowId 所属窗口；tab 自己带了就以它为准
 * @returns {{id: number, url: string, title: string, windowId: number, favIconUrl: string|undefined}}
 */
export function tabPickPayload(tab, windowId) {
  const t = tab || {};

  return {
    id: t.id,
    url: t.url,
    title: t.title || t.url,
    windowId: t.windowId === undefined ? windowId : t.windowId,
    // 显式转 undefined 而不是留空串：chip 里 `v-if="faviconUrl"` 靠它决定画图标
    // 还是画地球，空串会走进「有图标」那条路然后加载失败。
    favIconUrl: t.favIconUrl || undefined,
  };
}

/**
 * 按查询串过滤标签页分组。**纯函数**。
 *
 * 只匹配标题与 URL、大小写不敏感 —— 用户打「taobao」想找的是 URL 里的域名，
 * 打「商品」想找的是标题，两边都得命中。
 *
 * 空查询原样返回（一个分组都不丢）：那时用户刚按下 @，要看到的是全部可选项。
 * 有查询时**过滤后丢掉空分组** —— 否则会剩下一串只有「窗口 2」标题、下面什么
 * 都没有的分组头。
 *
 * @param {Array<{windowId?: number, tabs?: Array}>} groups listTabs() 的产物
 * @param {string} query parseAtDraft 的 query；空串 = 全部
 * @returns {Array}
 */
export function filterTabs(groups, query) {
  const q = String(query || '').toLowerCase();
  if (!q) return groups || [];

  return (groups || [])
    .map((g) => ({
      ...g,
      tabs: (g.tabs || []).filter(
        (t) =>
          String(t.title || '')
            .toLowerCase()
            .includes(q) ||
          String(t.url || '')
            .toLowerCase()
            .includes(q)
      ),
    }))
    .filter((g) => g.tabs.length > 0);
}
