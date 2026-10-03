<template>
  <!-- v-html 的内容全部来自 @/agent/markdown：先转义再做行内替换，
       链接只放行 http/https/mailto，所以这里不需要 DOMPurify 之类的二次清洗 -->
  <!-- eslint-disable vue/no-v-html -->
  <div class="text-sm leading-relaxed">
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
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { markdownToBlocks } from '@/agent/markdown';

const props = defineProps({
  raw: { type: String, default: '' },
});

const { t } = useI18n();
const copied = ref('');

const blocks = computed(() => markdownToBlocks(props.raw));

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
