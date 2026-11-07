'use strict';
/* =====================================================================
 * parser/selftest.mjs —— 引擎自测（离线断言 + 可选联网 smoke）
 *   node parser/selftest.mjs            # 离线 + 联网
 *   node parser/selftest.mjs --offline  # 只跑离线
 * ===================================================================== */
import assert from 'node:assert/strict';
import {
  extractURL, detectPlatform, normalizeKey, resultKey, decodeHTMLEntities,
  extractStates, collectMedia, metaTags, parse, ENGINE_VERSION,
} from './engine.mjs';

let pass = 0, failN = 0;
const t = (name, fn) => {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + ' → ' + e.message); failN++; }
};

console.log('自研解析引擎 v' + ENGINE_VERSION + ' 自测\n--- 离线 ---');

t('从分享文案里抠出链接', () => {
  assert.equal(extractURL('8.88 复制打开抖音，看看 https://v.douyin.com/abc123/ 复制此链接'), 'https://v.douyin.com/abc123/');
  assert.equal(extractURL('没有链接'), '');
});

t('平台识别', () => {
  assert.equal(detectPlatform('https://v.douyin.com/abc').key, 'douyin');
  assert.equal(detectPlatform('https://b23.tv/BV1xx').key, 'bilibili');
  assert.equal(detectPlatform('https://www.kuaishou.com/short-video/3xx').key, 'kuaishou');
  assert.equal(detectPlatform('https://www.xiaohongshu.com/explore/abc').key, 'xiaohongshu');
  assert.equal(detectPlatform('https://example.com/a.mp4').key, 'generic');
});

t('cache key 归一化与旧缓存同构', () => {
  assert.equal(normalizeKey('https://v.kuaishou.com/jofuaju2'), 'v.kuaishou.com/jofuaju2');
  assert.equal(normalizeKey('HTTPS://WWW.Douyin.com/video/123/?a=1#x'), 'douyin.com/video/123');
  assert.equal(normalizeKey('https://v.kuaishou.com/jofuaju2/'), 'v.kuaishou.com/jofuaju2');
});

t('resultKey 稳定且为 16 位十六进制', () => {
  const a = resultKey('https://v.kuaishou.com/jofuaju2');
  assert.equal(a, resultKey('https://v.kuaishou.com/jofuaju2?from=share#x'));
  assert.match(a, /^[0-9a-f]{16}$/);
});

t('HTML 实体解码', () => {
  assert.equal(decodeHTMLEntities('a&amp;b&#x2F;c&quot;d'), 'a&b/c"d');
});

t('括号配平扫描能剥出深层嵌套 JSON（旧正则会截断）', () => {
  const payload = { a: { b: { c: [{ url: 'https://p.a.yximgs.com/u/1.jpg' }] } }, note: '带右括号 } 的字符串' };
  const html = `<html><script>window.__APOLLO_STATE__ = ${JSON.stringify(payload)};</script></html>`;
  const states = extractStates(html);
  assert.equal(states.length, 1);
  assert.equal(states[0].name, '__APOLLO_STATE__');
  assert.equal(states[0].data.note, '带右括号 } 的字符串');
  assert.equal(states[0].data.a.b.c[0].url, 'https://p.a.yximgs.com/u/1.jpg');
});

t('抖音 RENDER_DATA（URL 编码）能解开', () => {
  const data = { app: { videoInfo: { title: '测试' } } };
  const html = '<script id="RENDER_DATA" type="application/json">' + encodeURIComponent(JSON.stringify(data)) + '</script>';
  assert.equal(extractStates(html)[0].data.app.videoInfo.title, '测试');
});

t('多段状态 JSON 一次全收', () => {
  const html = '<script>window._ROUTER_DATA={"x":1};window.__INITIAL_STATE__={"y":2};</script>';
  assert.equal(extractStates(html).length, 2);
});

t('meta 标签（属性顺序颠倒也认）', () => {
  const html = '<meta content="标题" property="og:title"><meta property="og:image" content="https://x/a.jpg&amp;w=1">';
  const m = metaTags(html);
  assert.equal(m.title, '标题');
  assert.equal(m.image, 'https://x/a.jpg&w=1');
});

t('媒体深扫：去 logo、去重、还原转义斜杠', () => {
  const obj = {
    images: [{ url_list: ['https:\\/\\/p3.douyinpic.com\\/img\\/a.jpg'] }, { url_list: ['https://p6.douyinpic.com/img/a.jpg'] }],
    logo: 'https://p3.douyinpic.com/img/logo.png',
    play: 'https://v3.douyinvod.com/v/b.mp4',
  };
  const m = collectMedia(obj, { host: 'douyinpic|douyinvod' });
  assert.ok(m.images.length >= 1 && m.images.length <= 2, '图片数=' + m.images.length);
  assert.ok(!m.images.some(u => /logo/i.test(u)));
  assert.equal(m.videos.length, 1);
});

const offline = process.argv.includes('--offline');
if (!offline) {
  console.log('--- 联网 smoke（失败只警告，不算 fail） ---');
  try {
    const r = await parse('https://www.bilibili.com/video/BV1GJ411x7h7', { noResolve: true });
    assert.equal(r.kind, 'video');
    assert.match(r.play, /^https:\/\//);
    assert.ok(r.title.length > 0);
    console.log('  PASS  B 站官方接口解析 → ' + r.via + ' / ' + r.title.slice(0, 30));
    pass++;
  } catch (e) {
    console.log('  WARN  B 站联网 smoke 没跑通：' + (e.message || e));
  }
  try {
    const r = await parse('https://example.com/sample.jpg', { noResolve: true });
    assert.equal(r.kind, 'images');
    console.log('  PASS  图片直链解析');
    pass++;
  } catch (e) { console.log('  WARN  直链用例：' + e.message); }
}

console.log(`\n结果：${pass} 通过，${failN} 失败`);
if (failN) process.exitCode = 1;
