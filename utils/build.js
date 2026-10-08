// Do this as the first thing so that any code reading it knows the right env.
process.env.BABEL_ENV = 'production';
process.env.NODE_ENV = 'production';
process.env.ASSET_PATH = '/';

const webpack = require('webpack');
const config = require('../webpack.config');

delete config.chromeExtensionBoilerplate;

config.mode = 'production';

// OFFLINE_MODE=1 bakes IS_OFFLINE=true into the bundle, so cloud features are
// dropped at compile time rather than branched on at runtime.
const buildTarget =
  process.env.OFFLINE_MODE === '1'
    ? 'offline (cloud features stripped)'
    : 'full (cloud features included)';
console.log(`[build] target: ${buildTarget}\n`);

webpack(config, function (err, stats) {
  if (err) throw err;

  // T-170：模块级错误（loader 崩、语法错）**不会**变成上面的 err —— webpack
  // 把它们收进 stats，配上 NoEmitOnErrorsPlugin 就是「什么都不 emit，进程退出 0」。
  // 2026-10-09 真踩过：一条以 @ 开头的文案让 @intlify/vue-i18n-loader 抛
  // 「Cannot read properties of undefined (reading 'message')」，构建 exit 0、
  // 进度条打到 100%，而 build/ 是空的 —— 打进 zip 的是上一次的旧产物。
  // 「构建成功」这句话必须由脚本自己担保，不能靠人去看 build/ 有没有东西。
  if (stats && stats.hasErrors()) {
    console.error(
      stats.toString({
        colors: true,
        all: false,
        errors: true,
        errorDetails: true,
        moduleTrace: true,
      })
    );
    console.error('\n[build] 有模块级错误，产物未写出 —— 见上面的 ERROR');
    process.exit(1);
  }
});
