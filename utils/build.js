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

webpack(config, function (err) {
  if (err) throw err;
});
