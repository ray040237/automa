<template>
  <!--
    T-172：确认门从琥珀升到 **accent**。

    它和 notice（advisory 提醒）、未配置横幅（阻塞）、工具被拒（状态）原先
    共用同一个琥珀色，于是「有个写操作等你裁决」看起来和「一句善意提醒」
    一样重 —— 最坏的后果是用户把 test_js / 画布写入当普通提示随手放行。

    accent 在本仓就是 --color-accent: 24 24 27（浅色）/ 244 244 245（深色），
    也就是近黑与近白 —— 不加新色相，只是把「整个面板里唯一的那块深色边框」
    留给需要用户裁决的东西。配合已有的双按钮（拒绝 default / 允许 accent）
    和 riAlertLine，三重信号指向同一个意思：这里要你做决定。
  -->
  <div
    class="rounded border border-accent/40 bg-accent/5 p-3 dark:border-accent/40"
  >
    <div class="mb-1 flex items-center gap-2 text-sm font-medium">
      <v-remixicon name="riAlertLine" size="16" />
      <span>{{ title }}</span>
    </div>
    <p class="mb-2 text-xs text-gray-600 dark:text-gray-300">{{ hint }}</p>
    <pre
      v-if="body"
      class="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/5 p-2 text-xs dark:bg-black/30"
      >{{ body }}</pre
    >
    <ui-checkbox v-if="canRemember" v-model="remember" class="mt-2 text-xs">
      {{ t('workflow.agent.confirm.remember') }}
    </ui-checkbox>
    <div class="mt-2 flex justify-end gap-2">
      <ui-button variant="default" @click="answer(false)">
        {{ t('workflow.agent.confirm.deny') }}
      </ui-button>
      <ui-button variant="accent" @click="answer(true)">
        {{ t('workflow.agent.confirm.allow') }}
      </ui-button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 写类工具的确认卡。
 *
 * 载荷是结构化的（`src/agent/confirm.js`）：`{ kind, detail, lines, ... }`，
 * 不再是一个裸 `code` 字符串。早先宿主读 `req.code` 恒为 `''`，这张卡的
 * `<pre>` 一直是空的 —— 用户在盲批（docs/backlog.md T-27）。
 *
 * 这里只做「按 kind 取文案」，事实（代码全文、选择器、diff 摘要）来自 confirm.detail。
 * 答案统一发对象 `{ approved, remember }`，由宿主归一化后再 resolve 给 loop。
 */
const props = defineProps({
  confirm: { type: Object, default: null },
});

const emit = defineEmits(['answer']);
const { t } = useI18n();

/** 勾选状态只活在卡片里：卡一关（确认完/切会话）就没了，不留跨调用的痕迹。 */
const remember = ref(false);

const kind = computed(() => (props.confirm && props.confirm.kind) || 'generic');

const canRemember = computed(() =>
  Boolean(props.confirm && props.confirm.canRemember)
);

/** 没有目标页标题时给个占位，别让标题里出现空的「在  上执行」。 */
const target = computed(
  () =>
    (props.confirm && props.confirm.targetTitle) ||
    t('workflow.agent.confirm.unknownTarget')
);

const title = computed(() => {
  switch (kind.value) {
    case 'code':
      return t('workflow.agent.confirm.codeTitle', { target: target.value });
    case 'selector':
      return t('workflow.agent.confirm.selectorTitle', {
        target: target.value,
      });
    case 'url':
      return t('workflow.agent.confirm.urlTitle');
    case 'canvas':
      return props.confirm && props.confirm.action === 'update'
        ? t('workflow.agent.confirm.canvasUpdateTitle', {
            nodeId: props.confirm.nodeId,
          })
        : t('workflow.agent.confirm.canvasAddTitle');
    default:
      return t('workflow.agent.confirm.title');
  }
});

const hint = computed(() => {
  switch (kind.value) {
    case 'code':
      return t('workflow.agent.confirm.codeHint', {
        lines: t('workflow.agent.confirm.lineCount', {
          n: props.confirm ? props.confirm.lines : 0,
        }),
      });
    case 'selector':
      return t('workflow.agent.confirm.selectorHint');
    case 'url':
      return t('workflow.agent.confirm.urlHint');
    case 'canvas':
      return t('workflow.agent.confirm.canvasHint');
    default:
      return t('workflow.agent.confirm.hint');
  }
});

/** 给 `<pre>` 的原文：代码全文 / 选择器 / url / 画布 id + 变更字段。 */
const body = computed(() => (props.confirm ? props.confirm.detail : ''));

function answer(approved) {
  emit('answer', { approved, remember: approved && remember.value });
}
</script>
