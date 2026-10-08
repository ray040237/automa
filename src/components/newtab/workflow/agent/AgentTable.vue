<template>
  <!-- v-html 的内容全部来自 @/agent/markdown：先转义再做行内替换，
       链接只放行 http/https/mailto，所以这里不需要 DOMPurify 之类的二次清洗 -->
  <!-- eslint-disable vue/no-v-html -->
  <div class="relative my-2">
    <!-- 横向滚动容器：窄侧栏（320px）里表格常溢出，用户需要能拖。 -->
    <div ref="scroller" class="overflow-x-auto" @scroll.passive="onScroll">
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

    <!-- T-156：表格横向溢出时，右缘放一条渐变遮罩 + 「可横滑」角标，
         告诉用户右边还有内容、可以拖。仅在 scrollWidth>clientWidth（确实藏住
         了东西）时出现；滚到最右后遮罩渐隐，免得压着最后一列。
         两个元素都 pointer-events-none，不挡滚动与拖拽。 -->
    <div
      v-if="overflowing"
      class="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-gray-200/80 to-transparent transition-opacity dark:from-gray-700/80"
      :class="{ 'opacity-0': atEnd }"
    />
    <span
      v-if="overflowing && !atEnd"
      class="pointer-events-none absolute right-1 top-1 rounded bg-gray-700/80 px-1 py-0.5 text-[10px] leading-none text-gray-100"
      >{{ t('workflow.agent.tableScrollHint') }}</span
    >
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps({
  block: { type: Object, required: true },
});

const { t } = useI18n();
const scroller = ref(null);
const overflowing = ref(false);
const atEnd = ref(false);

function measure() {
  const el = scroller.value;
  if (!el) return;
  const over = el.scrollWidth - el.clientWidth > 1;
  overflowing.value = over;
  atEnd.value = over
    ? el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
    : false;
}

function onScroll() {
  const el = scroller.value;
  if (!el) return;
  atEnd.value = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
}

onMounted(() => {
  measure();
  window.addEventListener('resize', measure);
});
onBeforeUnmount(() => window.removeEventListener('resize', measure));

// 流式回答里表格尺寸会随 delta 变化，重测。
watch(
  () => props.block,
  () => nextTick(measure),
  { deep: true }
);
</script>
