/**
 * 装配层：多轮落盘续接 + 会话索引（原 live-assembly [3] [4]）。
 *
 * 这一条是唯一真正验 `sessionStore` 落盘/续接的 —— 其余任务要么走
 * `initialHistory`（loop 层），要么只测单轮。
 */
import { AGENT_EVENTS, textOf } from '../harness.mjs';
import { PAGE_TEXT, TABS } from './assembly-chat.mjs';

const SECRET = '菠萝披萨';

export default {
  id: 'assembly/multiturn',
  title: '装配层：多轮落盘续接 + 会话索引',
  layer: 'assembly',
  async run({ configDoc, setupAssembly, check, skipIfRateLimited }) {
    const a = await setupAssembly({ doc: configDoc, tabs: TABS, pageText: PAGE_TEXT });
    const runtime = a.makeRuntime();

    const e1 = [];

    const r1 = await runtime.send({
      userText: `我在列购物清单，请把「${SECRET}」这个词记着，只回复"好的"。`,
      onEvent: (e) => e1.push(e),
    });

    if (skipIfRateLimited(check, r1)) return;

    const sid = runtime.getSessionId();

    if (!sid) {
      check.hard(false, '第一轮结束后没有 sessionId（没落盘）');

      return;
    }

    const e2 = [];
    const ret = await runtime.send({
      userText: '刚才我让你在购物清单里留意的那个词是什么？直接说出来。',
      onEvent: (e) => e2.push(e),
    });

    const text = textOf(e2).trim();
    // 额度限制：第二轮没验成，但落盘/索引仍照测（不 return）
    const limited = skipIfRateLimited(check, ret);

    if (!limited && ret.kind === AGENT_EVENTS.ERROR) {
      check.hard(false, `第二轮错误: ${ret.message}`);
    } else if (!limited) {
      check.hard(
        text.includes(SECRET),
        `第二轮没记住词。回答: ${text.slice(0, 200)}`
      );
    }

    // 落盘历史里到底存了什么
    const rec = await a.sessionStore.load(sid);
    const kinds = (rec && rec.events ? rec.events : []).map((e) => e.kind);

    console.log(`        落盘事件序列: ${kinds.join(' -> ')}`);
    check.hard(
      kinds.includes(AGENT_EVENTS.USER_MESSAGE),
      '落盘历史里没有 user-message，模型看不到用户问过什么'
    );

    const list = await a.sessionStore.listIndex();

    check.hard(list.length > 0, 'listIndex 为空');
    console.log(`        索引条目: ${list.length} 条`);
  },
};