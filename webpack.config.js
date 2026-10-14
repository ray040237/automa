const webpack = require('webpack');
const path = require('path');
const fileSystem = require('fs-extra');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const { VueLoaderPlugin } = require('vue-loader');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

// T-214 构建修复（Windows 专属，2026-10-10 实证）：
//
// enhanced-resolve 在为 vue-loader 克隆规则重新解析 loader 路径时，会把盘符
// 归一成小写（d:\...），而上一行 require 插件拿到的是大写（D:\...）。Node 的
// require 缓存按字符串精确匹配，于是**同一个包被加载成两个实例** —— 两个
// 不同的 pluginSymbol。插件用大写实例在 loaderContext 上打标记，SFC 样式链上
// 挂的却是小写实例的 loader，pitch 读不到自己的 Symbol，报「You forgot to add
// 'mini-css-extract-plugin' plugin」—— 全部 66 个 SFC 样式块同时炸掉，而
// tailwind.css 等普通 css 走原始规则（大写路径）幸存，极具迷惑性。
// 修法：把已加载的 mini-css 模块缓存条目按两种盘符大小写各注册一份别名，
// 让后续任何大小写的 require 都命中同一实例（Symbol 随之统一）。
const Module = require('module');
// 先把 loader.js 也拉进缓存（它依赖的 index.js / utils.js 已随上一行加载）
require('mini-css-extract-plugin/dist/loader');

Object.keys(Module._cache).forEach((key) => {
  if (!/[/\\]mini-css-extract-plugin[/\\]/.test(key)) return;

  const twin = /^[a-z]/.test(key)
    ? key[0].toUpperCase() + key.slice(1)
    : key[0].toLowerCase() + key.slice(1);
  if (!Module._cache[twin]) Module._cache[twin] = Module._cache[key];
});

const TerserPlugin = require('terser-webpack-plugin');
const env = require('./utils/env');
const { applyOfflineCsp } = require('./utils/manifestCsp');
const packageJSON = require('./package.json');

const ASSET_PATH = process.env.ASSET_PATH || '/';

const alias = {
  '@': path.resolve(__dirname, 'src/'),
  secrets: path.join(__dirname, 'secrets.blank.js'),
  // 原指向顶层 `business/dev`（上游闭源商业代码的空壳，Automa Commercial
  // License）。本 fork 不携带商业代码，改指 `src/businessStubs`（AGPL 区，
  // 等价空实现），使仓库里不再有商业许可文件。见 `src/businessStubs/index.js`。
  '@business': path.resolve(__dirname, 'src/businessStubs'),
};

// load the secrets
const secretsPath = path.join(__dirname, `secrets.${env.NODE_ENV}.js`);

const fileExtensions = [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'eot',
  'otf',
  'svg',
  'ttf',
  'woff',
  'woff2',
];

if (fileSystem.existsSync(secretsPath)) {
  alias.secrets = secretsPath;
}

const options = {
  mode: process.env.NODE_ENV || 'development',
  entry: {
    sandbox: path.join(__dirname, 'src', 'sandbox', 'index.js'),
    execute: path.join(__dirname, 'src', 'execute', 'index.js'),
    newtab: path.join(__dirname, 'src', 'newtab', 'index.js'),
    sidepanel: path.join(__dirname, 'src', 'sidepanel', 'index.js'),
    popup: path.join(__dirname, 'src', 'popup', 'index.js'),
    params: path.join(__dirname, 'src', 'params', 'index.js'),
    background: path.join(__dirname, 'src', 'background', 'index.js'),
    contentScript: path.join(__dirname, 'src', 'content', 'index.js'),
    offscreen: path.join(__dirname, 'src', 'offscreen', 'index.js'),
    recordWorkflow: path.join(
      __dirname,
      'src',
      'content',
      'services',
      'recordWorkflow',
      'index.js'
    ),
    webService: path.join(
      __dirname,
      'src',
      'content',
      'services',
      'webService.js'
    ),
    elementSelector: path.join(
      __dirname,
      'src',
      'content',
      'elementSelector',
      'index.js'
    ),
  },
  chromeExtensionBoilerplate: {
    notHotReload: [
      'background',
      'webService',
      'contentScript',
      'recordWorkflow',
      'elementSelector',
    ],
  },
  output: {
    path: path.resolve(__dirname, 'build'),
    filename: '[name].bundle.js',
    publicPath: ASSET_PATH,
  },
  module: {
    rules: [
      {
        test: /\.vue$/,
        loader: 'vue-loader',
        options: {
          reactivityTransform: true,
        },
      },
      {
        test: /\.css$/,
        use: [
          MiniCssExtractPlugin.loader,
          {
            loader: 'css-loader',
          },
          {
            loader: 'postcss-loader',
          },
        ],
      },
      {
        test: /\.(json5?|ya?ml)$/, // target json, json5, yaml and yml files
        type: 'javascript/auto',
        // Use `Rule.include` to specify the files of locale messages to be pre-compiled
        include: [path.resolve(__dirname, './src/locales')],
        loader: '@intlify/vue-i18n-loader',
      },
      {
        test: new RegExp(`.(${fileExtensions.join('|')})$`),
        type: 'asset/resource',
        dependency: { not: [/node_modules/] },
        generator: {
          filename: '[name][ext]',
        },
      },
      {
        test: /\.js$/,
        use: [
          {
            loader: 'source-map-loader',
          },
          {
            loader: 'babel-loader',
          },
        ],
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    alias,
    extensions: fileExtensions
      .map((extension) => `.${extension}`)
      .concat(['.js', '.vue', '.css']),
  },
  plugins: [
    new MiniCssExtractPlugin(),
    new VueLoaderPlugin(),
    new webpack.DefinePlugin({
      BROWSER_TYPE: JSON.stringify(env.BROWSER),
      // Build-time flag for offline/intranet deployments: set OFFLINE_MODE=1
      // (e.g. `npm run build:offline`) to strip cloud features at compile time.
      IS_OFFLINE: JSON.stringify(process.env.OFFLINE_MODE === '1'),
    }),
    new webpack.ProgressPlugin(),
    // clean the build folder
    new CleanWebpackPlugin({
      verbose: false,
    }),
    // expose and write the allowed env vars on the compiled bundle
    new webpack.EnvironmentPlugin(['NODE_ENV']),
    new CopyWebpackPlugin({
      patterns: [
        {
          from:
            env.NODE_ENV === 'development' && env.BROWSER === 'chrome'
              ? `src/manifest.${env.BROWSER}.dev.json`
              : `src/manifest.${env.BROWSER}.json`,
          to: path.join(__dirname, 'build', 'manifest.json'),
          force: true,
          toType: 'file',
          transform(content) {
            // 注意：require 只能在文件顶层做 —— CopyWebpackPlugin 的 transform
            // 内部走的是 webpack 自己的解析，require('../package.json') 会报
            // "Cannot find module"（实测踩过）。
            const manifestObj = {
              description: packageJSON.description,
              version: packageJSON.version,
              ...JSON.parse(content.toString()),
            };
            const isChrome = env.BROWSER === 'chrome';

            if (manifestObj.version.includes('-')) {
              const [version, preRelease] = manifestObj.version.split('-');

              if (isChrome) {
                manifestObj.version = version;
                manifestObj.version_name = `${version} ${preRelease}`;
              } else {
                manifestObj.version = `${version}${preRelease}`;
              }
            }

            // Offline builds must not permit remote scripts on extension pages.
            // 逻辑抽到 utils/manifestCsp.js 以便测试（T-194）。
            applyOfflineCsp(manifestObj, process.env.OFFLINE_MODE === '1');

            return Buffer.from(JSON.stringify(manifestObj));
          },
        },
        {
          from: 'src/assets/images/icon-128.png',
          to: path.join(__dirname, 'build'),
          force: true,
        },
        {
          from: 'src/assets/images/icon-16.png',
          to: path.join(__dirname, 'build'),
          force: true,
        },
        {
          from: 'src/assets/images/icon-32.png',
          to: path.join(__dirname, 'build'),
          force: true,
        },
        {
          from: 'src/assets/images/icon-48.png',
          to: path.join(__dirname, 'build'),
          force: true,
        },
        {
          from: 'src/assets/images/icon-192.png',
          to: path.join(__dirname, 'build'),
          force: true,
        },
        {
          from: 'src/assets/images/icon-dev-128.png',
          to: path.join(__dirname, 'build'),
          force: true,
        },
      ],
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'src', 'newtab', 'index.html'),
      filename: 'newtab.html',
      chunks: ['newtab'],
      cache: false,
    }),
    // T-199：浏览器侧边栏页面（chrome.sidePanel）。Chrome 侧栏由
    // manifest.side_panel.default_path 指到这个 html；Firefox 不用它
    // （Firefox 保留主面板标签页形态，见 docs/t199-sidepanel-plan.md §4）。
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'src', 'sidepanel', 'index.html'),
      filename: 'sidepanel.html',
      chunks: ['sidepanel'],
      cache: false,
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'src', 'sandbox', 'index.html'),
      filename: 'sandbox.html',
      chunks: ['sandbox'],
      cache: false,
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'src', 'execute', 'index.html'),
      filename: 'execute.html',
      chunks: ['execute'],
      cache: false,
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'src', 'popup', 'index.html'),
      filename: 'popup.html',
      chunks: ['popup'],
      cache: false,
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'src', 'params', 'index.html'),
      filename: 'params.html',
      chunks: ['params'],
      cache: false,
    }),
    new HtmlWebpackPlugin({
      template: path.join(__dirname, 'src', 'offscreen', 'index.html'),
      filename: 'offscreen.html',
      chunks: ['offscreen'],
      cache: false,
    }),
    new webpack.DefinePlugin({
      __VUE_OPTIONS_API__: true,
      __VUE_PROD_DEVTOOLS__: false,
    }),
    // Fix i18n warning
    new webpack.DefinePlugin({
      __VUE_I18N_FULL_INSTALL__: JSON.stringify(true),
      __INTLIFY_PROD_DEVTOOLS__: JSON.stringify(false),
      __VUE_I18N_LEGACY_API__: JSON.stringify(false),
    }),
  ],
  infrastructureLogging: {
    level: 'info',
  },
};

if (env.NODE_ENV === 'development') {
  options.devtool = 'cheap-module-source-map';
} else {
  options.optimization = {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        extractComments: false,
      }),
    ],
  };
}

module.exports = options;
