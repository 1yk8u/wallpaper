'use strict';
/* 兼容入口：旧的 `node scripts/parse-queue.mjs` 现在统一走自研引擎。
 * 逻辑全部在 ../parser/relay.mjs（读 env.PARSE_URLS，写 data/parsed + 总缓存）。 */
import '../parser/relay.mjs';
