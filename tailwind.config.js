/* eslint-disable */
const defaultTheme = require('tailwindcss/defaultTheme');
const colors = require('tailwindcss/colors');

function withOpacityValue(variable) {
  return ({ opacityValue }) => {
    if (opacityValue === undefined) {
      return `rgb(var(${variable}))`;
    }
    return `rgb(var(${variable}) / ${opacityValue})`;
  };
}
function rem2px(input, fontSize = 16) {
  if (input == null) {
    return input;
  }

  switch (typeof input) {
    case 'object':
      if (Array.isArray(input)) {
        return input.map((val) => rem2px(val, fontSize));
      }
      const ret = {};
      for (const key in input) {
        ret[key] = rem2px(input[key]);
      }
      return ret;

    case 'string':
      return input.replace(
        /(\d*\.?\d+)rem$/,
        (_, val) => `${parseFloat(val) * fontSize}px`
      );
    default:
      return input;
  }
}

module.exports = {
  content: [
    './src/**/*.{js,jsx,ts,tsx,vue}',
    './business/**/*.{js,jsx,ts,tsx,vue}',
  ],
  darkMode: 'class', // or 'media' or 'class'
  theme: {
    borderRadius: rem2px(defaultTheme.borderRadius),
    columns: rem2px(defaultTheme.columns),
    fontSize: rem2px(defaultTheme.fontSize),
    lineHeight: rem2px(defaultTheme.lineHeight),
    maxWidth: ({ theme, breakpoints }) => ({
      ...rem2px(defaultTheme.maxWidth({ theme, breakpoints })),
    }),
    spacing: rem2px(defaultTheme.spacing),
    extend: {
      colors: {
        primary: withOpacityValue('--color-primary'),
        secondary: withOpacityValue('--color-secondary'),
        accent: withOpacityValue('--color-accent'),
        // T-208：助手面板的三层底色 + 分隔线（借自参考实现 sidepanel）。
        //
        // 为什么另起 canvas/surface/field/line 而不是接着用 gray-*：
        // `gray` 在下面被别名成了 zinc，全项目都在用（上游就有几百处），
        // 改它会波及整个应用。这四档是**助手面板专用的层级色**，取新名字
        // 才能与原类并存、逐个替换、随时回退。
        //   canvas  = 面板最底（正文区所在的那层）
        //   surface = 浮起来的面（顶栏 / composer 卡 / 浮层）
        //   field   = 凹陷下去的面（输入区）
        //   line    = 分隔线（比原来的 border-gray-200 更淡，配合底色）
        canvas: withOpacityValue('--color-canvas'),
        surface: withOpacityValue('--color-surface'),
        field: withOpacityValue('--color-field'),
        line: withOpacityValue('--color-line'),
        // T-213：删掉 T-212 的 shell 色阶。
        //
        // 背景：T-212 为了让"面板根与 chrome 同色、消除白卡浮在深壳上"，在
        // canvas/surface/field 之外又加了第五个底色 shell。实际结果是家族被
        // 劈成两套，顶栏降到 shell 之后与 canvas 之间又多出一层，分层反而更糊。
        // 现在统一回三层家族（canvas → surface → field），面板根吃 canvas。
        // T-211：助手面板的三档语义文字色
        //
        // 为什么另起 fg-1/2/3 而不是继续 text-gray-400/500（+ dark: 双写）：
        //   ① 现在次要文字要写 `text-gray-500 dark:text-gray-400` 两份，弱文字
        //      写 `text-gray-400 dark:text-gray-500` —— 同一件事两处声明，漏一处
        //      就在某个主题下看不清；
        //   ② 这三档是**语义档位**（正文 / 次要 / 弱），不是「第 4 级灰」——
        //      取新名才能跨主题稳定，也才说得清「这里为什么要弱一档」。
        //   fg-1 = 正文（默认继承，通常不用显式写）
        //   fg-2 = 次要（时间戳、工具名摘要、说明句）
        //   fg-3 = 弱（占位符、禁用、极淡的元信息）
        fg: {
          1: withOpacityValue('--color-fg-1'),
          2: withOpacityValue('--color-fg-2'),
          3: withOpacityValue('--color-fg-3'),
        },
        // T-213：语义警示色。原先代码里靠 `text-red-500 dark:text-red-400`
        // 双声明表达「危险/警戒」，与 fg-* 要解决的痛点同一类。
        //   danger = 错误 / 失效 / 删除这类真危险
        //   warn   = 接近阈值但还没到（水位圆环 ≥60%）
        // 淡底不另立 token，直接写 `bg-danger/12`（透明度走 withOpacityValue）。
        danger: withOpacityValue('--color-danger'),
        warn: withOpacityValue('--color-warn'),
        gray: colors.zinc,
        orange: colors.orange,
      },
      // 圆角的三档语义名。
      //
      // 为什么另起 chip / control / card 这三个名字，而不是接着用
      // sm / md / lg：后者是 Tailwind 默认刻度，本仓到处在用（rounded-lg 在
      // 上游就有几十处），新语义如果复用同一批名字，改动会在既有用法上漂移 ——
      // 谁也说不清某个 rounded-lg 是「按刻度选的」还是「按语义选的」。
      // 取与默认刻度不重名的名字，两套可以并存、各自可判定：
      //   chip    = 图标按钮 / chip / 徽标这类贴着文字的小块
      //   control = 按钮 / 输入框 / 工具卡这类可点的小卡
      //   card    = composer 外框 / 确认卡 / 浮层面板这类整块容器
      borderRadius: {
        chip: '6px',
        control: '8px',
        card: '14px',
      },
      // 面板动效的统一语言：一条曲线 + 三档时长。
      // 先有这两个 token 才谈得上「加什么动画」—— 否则每处各自发明参数。
      // 值写在 tailwind.css 的 :root 里（带 fallback，未加载时也能用）。
      transitionTimingFunction: {
        panel: 'var(--ease-panel, cubic-bezier(0.32, 0.72, 0, 1))',
      },
      transitionDuration: {
        fast: 'var(--dur-fast, 140ms)',
        base: 'var(--dur-base, 200ms)',
        slow: 'var(--dur-slow, 260ms)',
      },
      fontFamily: {
        sans: ['Poppins', 'sans-serif'],
        mono: ['Source Code Pro', 'monospace'],
      },
      container: {
        center: true,
        padding: {
          DEFAULT: '1rem',
          sm: '2rem',
        },
      },
    },
  },
  variants: {
    extend: {},
  },
  plugins: [require('@tailwindcss/typography')],
};
