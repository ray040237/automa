<template>
  <!-- v-html 的内容全部来自 @/agent/markdown：marked 只做词法，HTML 由我们自己
       逐 token 产出，白名单以外的 token（含源码里手写的标签）一律转义成文本，
       链接只放行 http/https/mailto —— 所以不需要 DOMPurify 之类的二次清洗 -->
  <!-- eslint-disable vue/no-v-html -->
  <!-- ref 放在 class 之前是 vue/attributes-order 的要求；复制整条时从根节点取
       innerHTML，定位这棵树的守卫认的是 class 串，不依赖属性顺序。 -->
  <div ref="rootEl" class="group relative text-sm leading-relaxed">
    <!-- T-16：整条回答的复制入口（原来只有代码块有复制按钮）。
         放右上角、hover / focus 才显形；给不透明底色是为了盖住下面的字 ——
         侧栏只有 320px 宽，按钮压在首行上要是半透明，两边都读不清。
         键盘可达：opacity-0 不影响 tab 顺序，focus 时会显形。
         复制的是 props.raw（原始 markdown 全文），不是把 blocks 拼回去 ——
         后者会丢掉原文的换行与标记。
         T-206：按钮加 `peer`，下面的正文加 `peer-hover`/`peer-focus` 底色 ——
         hover 到按钮时**整条消息**淡淡高亮，用户一眼看出「要复制的是这一段」。
         长对话里多条消息各带一个同款按钮，只亮按钮本身分不清范围。 -->
    <button
      type="button"
      class="peer absolute right-0 top-0 z-10 rounded-chip bg-field/95 px-1.5 py-0.5 text-xs text-fg-2 opacity-0 backdrop-blur focus:opacity-100 group-hover:opacity-100"
      @click="copy(props.raw)"
    >
      {{
        copied === props.raw
          ? t('workflow.agent.copied')
          : t('workflow.agent.copyAll')
      }}
    </button>

    <!-- T-206：被复制的范围。`peer-hover` / `peer-focus` 认的是上面的复制按钮 ——
         hover 或键盘聚焦按钮时整块正文得到一层淡底，明确「复制的是这一段」。
         用 rounded-control + 负边距把底色铺到文字两侧，但只在真正 hover 时才画，
         平时完全不可见（不给静态消息加视觉重量）。 -->
    <div
      class="-mx-1 rounded-control px-1 transition-colors duration-fast ease-panel peer-hover:bg-accent/5 peer-focus:bg-accent/5"
      data-test="copy-scope"
    >
      <template v-for="(block, i) in blocks" :key="i">
        <div
          v-if="block.type === 'heading'"
          role="heading"
          :aria-level="block.level"
          :class="headingClass(block.level)"
          v-html="block.html"
        />

        <!-- T-157：这一段是**唯一没有自我约束的叶子** —— 代码块（line 41）与表格
             （line 73）都已有 overflow-x-auto，而这个 <p> 只有 whitespace-pre-wrap。
             正文里出现长 URL / 无空格长串时它不会断行，横向一路顶到 transcript
             （overflow-y-auto 会把 overflow-x 一并算成 auto），整个面板出现左右滚动条。
             break-words 让长串从中间断开；不加 overflow-x-auto 是刻意的 —— 文本该
             换行而不是让人横向拖，断行后也就不存在需要滚动的残留。 -->
        <p
          v-else-if="block.type === 'p'"
          class="mb-2 whitespace-pre-wrap break-words"
          v-html="block.html"
        />

        <pre
          v-else-if="block.type === 'code'"
          class="group relative my-2 overflow-x-auto rounded-control bg-field p-2 pb-6 text-xs"
        ><button
            type="button"
            class="absolute right-2 top-2 rounded-chip px-1.5 py-0.5 text-xs opacity-0 group-hover:opacity-100 focus:opacity-100"
            @click="copy(block.code)"
          >{{ copied === block.code ? t('workflow.agent.copied') : t('workflow.agent.copy') }}</button><code>{{ block.code }}</code></pre>

        <blockquote
          v-else-if="block.type === 'quote'"
          class="my-2 border-l-2 border-gray-300 pl-3 text-fg-2 dark:border-gray-600"
          v-html="block.html"
        />

        <hr v-else-if="block.type === 'hr'" class="my-3 border-line" />

        <!-- T-176：列表由 marked 解析成「带 depth 的扁平项」，模板只负责画。
             每项自带 marker，所以有序/无序可以混在同一个列表里（换库前
             `1. step` 换行 `- bullet` 会把子项并进父项、**吞掉内容**）；
             缩进直接由 depth 决定（换库前被 Math.min(1,…) 拍成一层）。
             任务列表的勾选态来自 item.checked。 -->
        <ul v-else-if="block.type === 'list'" class="my-2 list-none pl-0">
          <li
            v-for="(item, j) in block.items"
            :key="j"
            class="mb-0.5 flex items-start gap-1.5"
            :style="{ paddingLeft: `${item.depth * 14}px` }"
          >
            <input
              v-if="item.task"
              type="checkbox"
              :checked="item.checked"
              disabled
              class="mt-[3px] h-3.5 w-3.5 shrink-0"
            />
            <span
              v-else
              class="shrink-0 select-none text-fg-3"
              style="min-width: 1.15em"
              aria-hidden="true"
              v-text="item.marker"
            />
            <span
              class="min-w-0 flex-1 break-words [overflow-wrap:anywhere]"
              v-html="item.html"
            />
          </li>
        </ul>

        <!-- T-156：表格溢出提示（渐变遮罩 + 「可横滑」角标）收进 AgentTable，
             这样多表格互不干扰、逻辑也好钉守卫 -->
        <AgentTable v-else-if="block.type === 'table'" :block="block" />
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { createMarkdownStream, markdownToBlocks } from '@/agent/markdown';
import AgentTable from './AgentTable.vue';

const props = defineProps({
  raw: { type: String, default: '' },
});

const { t } = useI18n();
const copied = ref('');

// T-14：raw 每来一个 delta 就变一次，整段重解析的**累计**成本随回答长度平方
// 增长（实测 20K 字按 40 字一个 delta 累计 313ms，按 10 字一个 delta 累计 1.1s；
// 单次只有 0.5ms/万字，所以不是掉帧，是白烧主线程）。改成「已完成块缓存、只重解析
// 最后一个未完成块」后同样输入约 4ms。
//
// 首屏与 SSR 仍走整段解析：SSR 不跑 watcher（见 utils/sfc-render.mjs 的头注），
// 所以初值必须是同步算出来的，不能只在 watcher 里填。
const stream = createMarkdownStream();
const blocks = ref(markdownToBlocks(props.raw));

watch(
  () => props.raw,
  (raw) => {
    blocks.value = stream.push(raw);
  },
  { flush: 'post' }
);

/** 标题字号按层级递减，但都不超过正文太多 —— 侧栏只有 360px 宽 */
const HEADING_CLASS = [
  'mb-1 mt-2 text-base font-semibold',
  'mb-1 mt-2 text-[15px] font-semibold',
  'mb-1 mt-2 font-semibold',
  'mb-1 mt-2 font-medium',
  'mb-1 mt-2 font-medium',
  'mb-1 mt-2 font-medium',
];
const headingClass = (level) =>
  HEADING_CLASS[Math.min(5, Math.max(1, level) - 1)];

const rootEl = ref(null);

/**
 * 待复制的富文本：渲染后的整条回答。
 *
 * 为什么要富文本：助手最常产出表格与列表，纯文本粘到 Word / Notion / 飞书里
 * 结构全散 —— 用户拿到手还得重新排版。两个通道一起写，粘贴方自己挑能处理的
 * 那个：text/html 供富文本编辑器，text/plain 仍给 **markdown 原文**
 * （粘回聊天框 / 编辑器时保留标记比保留渲染结果有用）。
 *
 * 克隆一份再摘按钮：复制按钮是浮在首行上的 absolute 元素，直接取 innerHTML
 * 会把「复制全文」那几个字一起复制走。
 *
 * SSR 下 rootEl 是 null —— 那正是我们想要的：只有真点击（浏览器里）才需要它。
 */
function renderedHtml() {
  const el = rootEl.value;
  if (!el) return null;

  const clone = el.cloneNode(true);
  clone.querySelectorAll('button').forEach((btn) => btn.remove());

  return clone.innerHTML || null;
}

async function copy(text) {
  try {
    // 只有「整条回答」这一个入口走富文本；代码块复制仍只给纯文本 ——
    // 代码粘出去要的是源码本身，不是带 <pre> 样式的 HTML。
    const html = text === props.raw ? renderedHtml() : null;

    if (html && typeof ClipboardItem === 'function') {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
    } else {
      // 没有 ClipboardItem（旧浏览器 / 非安全上下文）就退回纯文本，
      // 富文本是增强不是依赖。
      await navigator.clipboard.writeText(text);
    }

    copied.value = text;
    setTimeout(() => {
      copied.value = '';
    }, 1500);
  } catch (e) {
    // 剪贴板不可用时（非安全上下文）什么都不做，别把页面搞出红叉
    copied.value = '';
  }
}
</script>
