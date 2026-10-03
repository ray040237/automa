/**
 * 注册测试解析钩子。用法：node --import ./utils/test-loader.mjs --test ...
 * 钩子本体见 test-resolver.mjs。
 */
import { register } from 'node:module';

register('./test-resolver.mjs', import.meta.url);
