<template>
  <component
    :is="tag"
    role="button"
    class="ui-button relative h-10 transition"
    :class="[
      color ? color : variants[btnType][variant],
      icon ? 'p-2' : 'py-2 px-4',
      circle ? 'rounded-full' : 'rounded-lg',
      {
        'opacity-70': disabled,
        'pointer-events-none': loading || disabled,
      },
    ]"
    v-bind="{ disabled: loading || disabled, ...$attrs }"
  >
    <span
      class="flex h-full items-center justify-center"
      :class="{ 'opacity-25': loading }"
    >
      <slot></slot>
    </span>
    <div v-if="loading" class="button-loading">
      <ui-spinner
        :color="
          variant === 'default'
            ? 'text-primary'
            : 'text-white dark:text-gray-900'
        "
      ></ui-spinner>
    </div>
  </component>
</template>
<script>
import UiSpinner from './UiSpinner.vue';

export default {
  components: { UiSpinner },
  props: {
    icon: Boolean,
    disabled: Boolean,
    loading: Boolean,
    circle: Boolean,
    color: {
      type: String,
      default: '',
    },
    tag: {
      type: String,
      default: 'button',
    },
    btnType: {
      type: String,
      default: 'fill',
    },
    variant: {
      type: String,
      default: 'default',
    },
  },
  setup(props) {
    const variants = {
      transparent: {
        default: 'hoverable',
      },
      fill: {
        default: 'bg-input',
        accent:
          'bg-accent hover:bg-gray-700 dark:bg-gray-100 dark:hover:bg-gray-200 dark:text-black text-white',
        primary:
          'bg-primary text-white dark:bg-secondary dark:hover:bg-primary hover:bg-secondary',
        danger:
          'bg-red-400 text-white dark:bg-red-500 dark:hover:bg-red-500 hover:bg-red-400',
      },
    };

    /**
     * 未知 variant 要吵，别悄悄渲染成一个没样式的按钮。
     *
     * 助手面板三处传过 `variant="text"`，而 variants 表里从来没有这个名字，
     * 取到 undefined 后 Vue 不输出任何 class —— 按钮既没底色也没 hover 反馈，
     * 用户看到的是「删除按钮不可见」。lint 与测试都抓不到（variant 是自由字符串），
     * 所以在这里补一道会响的检查（T-130）。
     *
     * 只有在颜色真的来自 variants 时才检查：传了 color 就绕过了这张表。
     */
    const known = variants[props.btnType];

    if (!props.color && (!known || !(props.variant in known))) {
      /* eslint-disable no-console */
      console.warn(
        `[UiButton] unknown variant "${props.variant}" for btn-type "${
          props.btnType
        }" — rendering without styles. Valid: ${
          known ? Object.keys(known).join(', ') : '(no such btn-type)'
        }`
      );
      /* eslint-enable no-console */
    }

    return {
      variants,
    };
  },
};
</script>
<style>
.button-loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}
</style>
