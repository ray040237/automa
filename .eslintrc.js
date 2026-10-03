// https://eslint.org/docs/user-guide/configuring
// File taken from https://github.com/vuejs-templates/webpack/blob/1.3.1/template/.eslintrc.js, thanks.

module.exports = {
  root: true,
  parserOptions: {
    parser: '@babel/eslint-parser',
  },
  env: {
    browser: true,
    webextensions: true,
  },
  ignorePatterns: ['src/lib/google-*'],
  // https://github.com/vuejs/eslint-plugin-vue#priority-a-essential-error-prevention
  // consider switching to `plugin:vue/strongly-recommended` or `plugin:vue/recommended` for stricter rules.
  extends: [
    'plugin:vue/vue3-recommended',
    'airbnb-base',
    'plugin:prettier/recommended',
  ],
  // required to lint *.vue files
  plugins: ['vue'],
  // check if imports actually resolve
  settings: {
    'import/resolver': {
      webpack: {
        config: './webpack.config.js',
      },
    },
  },
  // add your custom rules here
  globals: {
    BROWSER_TYPE: true,
    IS_OFFLINE: true,
  },
  rules: {
    camelcase: 'off',
    'no-await-in-loop': 'off',
    'no-alert': 'off',
    'import/no-import-module-exports': 'off',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-underscore-dangle': 'off',
    'func-names': 'off',
    'vue/v-on-event-hyphenation': 'off',
    'import/no-named-default': 'off',
    'no-restricted-syntax': 'off',
    'vue/multi-word-component-names': 'off',
    'prettier/prettier': [
      'error',
      {
        endOfLine: 'auto',
      },
    ],
    'import/extensions': [
      'error',
      'always',
      {
        js: 'never',
      },
    ],
    // disallow reassignment of function parameters
    // disallow parameter object manipulation except for specific exclusions
    'no-param-reassign': 'off',
    'import/no-extraneous-dependencies': 'off',
    // disallow default export over named export
    'import/prefer-default-export': 'off',
    // allow debugger during development
    'no-debugger': process.env.NODE_ENV === 'production' ? 'error' : 'off',
  },
  overrides: [
    {
      // 编辑器内嵌 agent 模块。三处刻意偏离 airbnb 默认规则，理由集中写在这里便于评审：
      //
      //  prefer-template —— 这些模块拼装的字符串大多是「要喂给模型的文本」，里面含有
      //    双大括号、反引号，以及字面的美元-大括号 插值序列。用模板字符串会让
      //    「文本内容」与「真实插值」在源码里长得一样，极难 review；而且本项目
      //    写这些文件时本身就是用模板字符串生成的，两层嵌套会让内层插值在
      //    写入时就被提前求值掉（已踩过一次，见 prompt.js 的 TICK 定义）。
      //
      //  no-continue —— 出现处全是卫语句（跳过不可见元素、无名 class 的节点、
      //    已达上限的字段等）。改写成 if/else 嵌套会让三层循环的可读性明显变差。
      //
      //  no-use-before-define (functions) —— 同文件内辅助函数互相调用，
      //    函数声明会提升，按「主流程在前、辅助在后」排更好读。
      // 测试跑在 Node 里，要用到 globalThis 与 node: 内置模块。
      files: ['src/agent/**/*.test.js', 'src/agent/__stubs__/*.js'],
      env: { node: true, es2022: true },
    },
    {
      files: ['src/agent/**/*.js', 'src/content/blocksHandler/handlerAgent*.js'],
      rules: {
        'prefer-template': 'off',
        'no-continue': 'off',
        'no-use-before-define': ['error', { functions: false }],
      },
    },
  ],
};
