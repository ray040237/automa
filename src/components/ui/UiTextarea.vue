<template>
  <textarea
    v-bind="{ placeholder, maxlength: max }"
    :id="textareaId"
    ref="textarea"
    :value="modelValue"
    class="ui-textarea ui-input bg-input w-full rounded-lg px-4 py-2 transition"
    @input="emitValue"
    @keyup="$emit('keyup', $event)"
    @keydown="$emit('keydown', $event)"
    @focus="$emit('focus', $event)"
    @blur="$emit('blur', $event)"
  ></textarea>
</template>
<script>
import { ref, onMounted, watch, nextTick } from 'vue';
import { useComponentId } from '@/composable/componentId';

export default {
  props: {
    modelValue: {
      type: String,
      default: '',
    },
    label: {
      type: String,
      default: '',
    },
    placeholder: {
      type: String,
      default: '',
    },
    autoresize: {
      type: Boolean,
      default: false,
    },
    max: {
      type: [Number, String],
      default: null,
    },
    block: Boolean,
  },
  emits: ['update:modelValue', 'change', 'focus', 'blur', 'keyup', 'keydown'],
  setup(props, { emit }) {
    const textareaId = useComponentId('textarea');
    const textarea = ref(null);

    function calcHeight() {
      if (!props.autoresize) return;

      textarea.value.style.height = 'auto';
      textarea.value.style.height = `${textarea.value.scrollHeight}px`;
    }
    function emitValue(event) {
      let { value } = event.target;
      const maxLength = Math.abs(props.max) || Infinity;

      if (value.length > maxLength) {
        value = value.slice(0, maxLength);
      }

      emit('update:modelValue', value);
      emit('change', value);
      // T-12：这一行一直被注释着，于是 autoresize 只在 onMounted 跑一次 ——
      // 用户打字时高度不动，长指令只能在固定高度的小窗里滚。
      nextTick(calcHeight);
    }

    onMounted(calcHeight);

    // 程序化改值（父组件清空草稿、/ 模板填入、切换会话……）也要跟着长高。
    // flush: 'post' 本身就是 DOM 更新**之后**触发，所以这里不必再套 nextTick
    // （vue/valid-next-tick 也会拦这条）。
    watch(() => props.modelValue, calcHeight, { flush: 'post' });

    return {
      textarea,
      emitValue,
      textareaId,
      calcHeight,
    };
  },
};
</script>
