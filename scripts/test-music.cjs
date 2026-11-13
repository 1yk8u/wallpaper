/* 四平台音乐解析自测（Node 环境模拟最小 DOM） */
const fs = require('fs');
const path = require('path');

global.window = global;
global.document = {
  readyState: 'loading',
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', style: {} }),
  head: { appendChild() {} },
  addEventListener() {},
};

const file = path.join(__dirname, '..', '_repo', 'music.js');
const code = fs.readFileSync(file, 'utf8');
const Music = new Function(code + '\nreturn Music;')();

let pass = 0;
console.log('=== 示例链接（四平台）===');
for (const d of Music.DEMOS) {
  const input = d.url + ' ' + d.text;
  const s = Music.parse(input);
  const ok = s && s.platform === d.key && !!s.title && !!s.page;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${d.key.padEnd(8)} | 平台=${s.platform.padEnd(8)} | id=${(s.id || '-').slice(0, 18).padEnd(18)} | 标题=${s.title} | 歌手=${s.artist}`);
  console.log(`        页面=${s.page}`);
  console.log(`        直链=${s.audio || '(无，走官方跳转)'}`);
  if (ok) pass++;
}

console.log('\n=== 常见分享口令格式 ===');
const cases = [
  ['netease', '8.87 复制打开抖音，听听《晴天》- 周杰伦 https://163cn.tv/abc123 https://music.163.com/song?id=186016'],
  ['qq', '【QQ音乐】分享《起风了》给你 https://c6.y.qq.com/base/fcgi-bin/u?__=xxx songmid=003aAYU93Ih9iB'],
  ['kugou', '酷狗音乐，分享《海阔天空》 https://t1.kugou.com/abc?hash=EFEC0563692CAF94C184248B1D83227F'],
  ['qishui', '汽水音乐 分享《起风了》 https://qishui.douyin.com/song/7351234567890123456'],
];
for (const [want, text] of cases) {
  const s = Music.parse(text);
  const ok = s && s.platform === want && !!s.title;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${want.padEnd(8)} → ${s.platform.padEnd(8)} | ${s.title} | ${s.artist}`);
  if (ok) pass++;
}

console.log('\n=== 汇总 ===');
console.log(`${pass}/8 通过`);
process.exit(pass === 8 ? 0 : 1);
