<template>
  <!-- v-html 的内容全部来自 @/agent/markdown：先转义再做行内替换，
       链接只放行 http/https/mailto，所以这里不需要 DOMPurify 之类的二次清洗 -->
  <!-- eslint-disable vue/no-v-html -->
  <div class="group relative text-sm leading-relaxed">
    <!-- T-16：整条回答的复制入口（原来只有代码块有复制按钮）。
         放右上角、hover / focus 才显形；给不透明底色是为了盖住下面的字 ——
         侧栏只有 320px 宽，按钮压在首行上要是半透明，两边都读不清。
         键盘可达：opacity-0 不影响 tab 顺序，focus 时会显形。
         复制的是 props.raw（原始 markdown 全文），不是把 blocks 拼回去 ——
         后者会丢掉原文的换行与标记。 -->
    <button
      type="button"
      class="absolute right-0 top-0 z-10 rounded bg-gray-100/95 px-1.5 py-0.5 text-xs text-gray-600 opacity-0 backdrop-blur focus:opacity-100 group-hover:opacity-100 dark:bg-gray-800/95 dark:text-gray-300"
      @click="copy(props.raw)"
    >
      {{
        copied === props.raw
          ? t('workflow.agent.copied')
          : t('workflow.agent.copyAll')
      }}
    </button>

    <template v-for="(block, i) in blocks" :key="i">
      <div
        v-if="block.type === 'heading'"
        role="heading"
        :aria-level="block.level"
        :class="headingClass(block.level)"
        v-html="block.html"
      />

      <p
        v-else-if="block.type === 'p'"
        class="mb-2 whitespace-pre-wrap"
        v-html="block.html"
      />

      <pre
        v-else-if="block.type === 'code'"
        class="group relative my-2 overflow-x-auto rounded bg-gray-100 p-2 pb-6 text-xs dark:bg-gray-800"
      ><button
          type="button"
          class="absolute right-2 top-2 rounded px-1.5 py-0.5 text-xs opacity-0 group-hover:opacity-100 focus:opacity-100"
          @click="copy(block.code)"
        >{{ copied === block.code ? t('workflow.agent.copied') : t('workflow.agent.copy') }}</button><code>{{ block.code }}</code></pre>

      <blockquote
        v-else-if="block.type === 'quote'"
        class="my-2 border-l-2 border-gray-300 pl-3 text-gray-600 dark:border-gray-600 dark:text-gray-300"
        v-html="block.html"
      />

      <hr
        v-else-if="block.type === 'hr'"
        class="my-3 border-gray-200 dark:border-gray-700"
      />

      <component
        :is="block.ordered ? 'ol' : 'ul'"
        v-else-if="block.type === 'list'"
        :class="['my-2 pl-5', block.ordered ? 'list-decimal' : 'list-disc']"
      >
        <li
          v-for="(item, j) in block.items"
          :key="j"
          :class="{ 'ml-4': item.depth > 0 }"
          class="mb-0.5"
          v-html="item.html"
        />
      </component>

      <div v-else-if="block.type === 'table'" class="my-2 overflow-x-auto">
        <table class="w-full border-collapse text-left text-xs">
          <thead>
            <tr>
              <th
                v-for="(cell, j) in block.head"
                :key="j"
                class="border border-gray-200 bg-gray-50 px-2 py-1 font-medium dark:border-gray-700 dark:bg-gray-800"
                :style="{ textAlign: block.align[j] || 'left' }"
                v-html="cell"
              />
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, j) in block.rows" :key="j">
              <td
                v-for="(cell, k) in row"
                :key="k"
                class="border border-gray-200 px-2 py-1 dark:border-gray-700"
                :style="{ textAlign: block.align[k] || 'left' }"
                v-html="cell"
              />
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { createMarkdownStream, markdownToBlocks } from '@/agent/markdown';

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

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
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
