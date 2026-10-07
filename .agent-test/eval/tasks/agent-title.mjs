/**
 * 生产 loop：LLM 会话标题（原 live-p3 [3]）。
 *
 * 走的是与 `index.js` `generateTitleAsync` 同一条路径：独立小请求，不进
 * `createAgent`（没工具、没 transcript）。只要求非空 —— 标题本来就是自由文本，
 * 硬钉具体字眼会假红。
 */
import { buildTitleMessages, cleanTitle } from '../../../src/agent/title.js';

export default {
  id: 'agent/title',
  title: '生产 loop：LLM 会话标题非空',
  layer: 'loop',
  async run({ config, createPiProvider, toPiContext, check, skipIfRateLimited }) {
    // 标题请求用固定的低温度（与 index.js 一致）
    const titleConfig = { ...config, temperature: 0.3 };
    const { model, streamFn } = await createPiProvider(titleConfig);

    const stream = streamFn(
      model,
      toPiContext(
        buildTitleMessages(
          '帮我抓一下这个购物网站的 商品名称和价格，做成循环',
          '好的，方案是先 read_page 拿列表容器，然后用循环元素块…'
        )
      )
    );
    const result = await stream.result();

    if (skipIfRateLimited(check, result)) return;

    // errorMessage 优先于正文：出错时 content 通常是空的，直接取会得到
    // 「标题为空」这个假象，掩盖真实原因（与 index.js 同款处理）。
    const raw =
      result.stopReason === 'error'
        ? ''
        : (result.content || [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('');

    const title = cleanTitle(raw);

    check.hard(
      Boolean(title),
      `cleanTitle 返回空，原始输出: ${JSON.stringify(raw.slice(0, 60))}`
    );

    if (title) console.log(`        标题: 「${title}」`);
  },
};