#!/usr/bin/env node
/**
 * build-manifest.mjs —— 扫描 wallpapers/ 目录生成 data/wallpapers.json
 * 由 GitHub Actions 自动执行；本地也可手动运行：node scripts/build-manifest.mjs
 */
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const WALLPAPER_DIR = process.cwd() + '/wallpapers';
const DATA_DIR = process.cwd() + '/data';
const THUMB_DIR = process.cwd() + '/thumbs';

/* 迷你预览表：make-thumbs.py 生成，内联进清单让首屏秒显模糊图 */
let LQIPS = {};
try { LQIPS = JSON.parse(readFileSync(DATA_DIR + '/lqip.json', 'utf8')) || {}; }
catch (e) {}

const isVideo = (n) => /\.(mp4|mov|webm|m4v)$/i.test(n);
const isGif = (n) => /\.gif$/i.test(n);
const isImage = (n) => /\.(jpe?g|png|webp|avif)$/i.test(n);
const isAudio = (n) => /\.(mp3|m4a|aac|flac|wav|ogg|opus)$/i.test(n);

/* 音乐加速：data/audio/au_xxx.ext 是英文文件名，jsdelivr CDN 可用。
 * 这里先建 sha→路径 映射，音乐条目据此写 playUrl，前端播放器点播秒响。 */
const AUDIO_DIR = process.cwd() + '/data/audio';
const shaToAudio = new Map();
try {
  for (const f of readdirSync(AUDIO_DIR)) {
    if (!/^au_[0-9a-f]{16}\.(mp3|m4a)$/i.test(f)) continue;
    const id = gitBlobId(join(AUDIO_DIR, f));
    if (id) shaToAudio.set(id, 'data/audio/' + f);
  }
} catch (e) { /* 没有 data/audio 目录就跳过，音乐退回同源播放 */ }

function gitTime(path) {
  try {
    return parseInt(execFileSync('git', ['log', '-1', '--format=%at', '--', path]).toString().trim(), 10) || 0;
  } catch (e) { return 0; }
}
function gitBlobId(path) {
  try {
    return execFileSync('git', ['hash-object', path]).toString().trim().slice(0, 10);
  } catch (e) { return null; }
}

function scan(dir) {
  const items = [];
  const coverSuffix = /^(.+)\.cover\.(jpe?g|png|webp|gif)$/i;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { return items; }
  const filesInDir = [];
  for (const d of entries) {
    if (d.name.startsWith('.')) continue;
    const full = join(dir, d.name);
    if (d.isDirectory()) { items.push(...scan(full)); continue; }
    filesInDir.push({ name: d.name, full });
  }
  const covers = new Map();
  for (const f of filesInDir) {
    const m = coverSuffix.exec(f.name);
    if (m) covers.set(m[1].toLowerCase(), f.full);
  }
  for (const f of filesInDir) {
    if (coverSuffix.test(f.name)) continue;
    if (!isVideo(f.name) && !isGif(f.name) && !isImage(f.name) && !isAudio(f.name)) continue;

    const rel = relative(WALLPAPER_DIR, f.full).split(sep).join('/');
    const dot = f.name.lastIndexOf('.');
    const baseKey = (dot > 0 ? f.name.slice(0, dot) : f.name).toLowerCase();
    const coverFull = covers.get(baseKey);
    let id = gitBlobId(f.full) || createHash('sha1').update(readFileSync(f.full)).digest('hex').slice(0, 10);
    const ts = gitTime(f.full) || Math.floor((statSync(f.full).mtimeMs || Date.now()) / 1000);
/* 品类自动归类：标题关键词 → 分类（首个命中即定） */
const CAT_RULES = [
  ['二次元', /二次元|动漫|漫画|插画|番剧|角色|女友|女主|女神|美图|可爱|小可爱/i],
  ['汽车', /汽车|跑车|机车|超跑|摩托|赛车|Model|奔驰|宝马|奥迪/i],
  ['风景', /风景|山水|雪|海|日落|星空|自然|湖泊|森林|城市|天空|旅行|山间|瀑布|枫|樱/i],
  ['萌宠', /猫|狗|柴犬|柯基|宠物|滚滚/i],
  ['游戏', /游戏|原神|王者|崩坏|明日方舟|塞尔达/i],
  ['文字', /文字|语录|签名|哲理|句/i],
];
function catOf(title) {
  const t = String(title || '');
  for (const [cat, re] of CAT_RULES) { if (re.test(t)) return cat; }
  return '综合';
}

const title = f.name.replace(/\.[^.]+$/, '').replace(/\.\d+$/, '').replace(/[_\-]+/g, ' ').trim() || f.name;
const audio = isAudio(f.name);

    const item = {
      id: 'w' + id,
      name: f.name,
      title,
      cat: audio ? '音乐' : catOf(title),
      kind: audio ? 'audio' : (isVideo(f.name) ? 'video' : 'image'),
      gif: audio ? false : isGif(f.name),
      url: 'wallpapers/' + rel,
      size: statSync(f.full).size,
      date: new Date(ts * 1000).toISOString(),
      src: 'file',
    };
    /* 音乐条目附 CDN 可用的英文播放路径（sha 匹配 data/audio 同字节文件） */
    if (audio && shaToAudio.has(id)) item.playUrl = shaToAudio.get(id);
    if (coverFull) {
      item.cover = 'wallpapers/' + relative(WALLPAPER_DIR, coverFull).split(sep).join('/');
      const cdot = coverFull.name.lastIndexOf('.');
      const cThumb = (cdot > 0 ? coverFull.name.slice(0, cdot) : coverFull.name) + '.webp';
      if (existsSync(join(THUMB_DIR, cThumb))) item.coverThumb = 'thumbs/' + cThumb;
    }
    const tbBase = (dot > 0 ? f.name.slice(0, dot) : f.name) + '.webp';
    if (existsSync(join(THUMB_DIR, tbBase))) item.thumb = 'thumbs/' + tbBase;
    items.push(item);
  }
  return items;
}

let links = [];
const linksPath = join(DATA_DIR, 'links.json');
if (existsSync(linksPath)) {
  try {
    const arr = JSON.parse(readFileSync(linksPath, 'utf8'));
    if (Array.isArray(arr)) {
      links = arr.filter(x => x && /^https?:\/\//i.test(x.url || '')).map(x => ({
        id: x.id || ('lk' + createHash('sha1').update(x.url).digest('hex').slice(0, 10)),
        title: x.title || '直链壁纸',
        cat: x.cat || (x.kind === 'audio' ? '音乐' : undefined),
        kind: x.kind === 'audio' ? 'audio' : (x.kind === 'video' ? 'video' : 'image'),
        gif: !!x.gif,
        url: x.url,
        size: null,
        date: x.date || new Date().toISOString(),
        src: 'link',
      }));
    }
  } catch (e) {
    console.error('links.json 解析失败，忽略:', e.message);
  }
}

const files = scan(WALLPAPER_DIR);

/* ===== 音乐条目：直接从 data/audio/ + data/covers/ + 解析缓存生成 =====
 * 音频真实字节存在 data/audio/au_xxx.ext。旧版只扫 wallpapers/，Actions 一重建
 * 清单音乐就全消失。这里扫描 data/audio 并重放解析缓存元数据，保证音乐条目
 * 每次重建都稳定存在，且带 playUrl（CDN 英文路径）和 cover（真实专辑封面）。
 * 同一首歌可能同时存在 .m4a 和 .mp3（同 sha），按 sha 去重，只保留一条。 */
function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return null; }
}
const parseCache = readJSON(join(DATA_DIR, 'parse-cache.json'));
const cacheEntries = (parseCache && parseCache.entries) || (parseCache && typeof parseCache === 'object' ? parseCache : {});
/* 元数据按 sha（au_<sha>.* 的 16 位哈希）映射：同一首歌可能存成 .m4a/.mp3，
 * sha 相同而文件名不同，按 sha 映射才能保证去重后仍命中 title/artist/cover。 */
const shaMeta = new Map();
for (const [key, v] of Object.entries(cacheEntries)) {
  if (!v || v.kind !== 'music' || !v.localAudio) continue;
  const m = /au_([0-9a-f]{16})\./i.exec(String(v.localAudio));
  if (!m) continue;
  const sha = m[1];
  const prev = shaMeta.get(sha);
  const curTs = v.ts ? new Date(v.ts).getTime() : 0;
  const prevTs = prev && prev.v && prev.v.ts ? new Date(prev.v.ts).getTime() : -1;
  if (!prev || curTs >= prevTs) shaMeta.set(sha, { key, v });
}

const musicItems = [];
const seenSha = new Set();   // 已生成过音乐条目的 sha，避免 m4a/mp3 重复
const extRank = { mp3: 0, m4a: 1, aac: 2, ogg: 3, opus: 4, wav: 5 };
try {
  const audioFiles = readdirSync(AUDIO_DIR)
    .filter(f => /^au_([0-9a-f]{16})\.(mp3|m4a|aac|wav|ogg|opus)$/i.test(f))
    .map(f => {
      const m = /^au_([0-9a-f]{16})\.(mp3|m4a|aac|wav|ogg|opus)$/i.exec(f);
      return { f, sha: m[1], ext: m[2].toLowerCase() };
    })
    /* 同 sha 优先 mp3（兼容性最好），其次按 extRank 排序 */
    .sort((a, b) => a.sha === b.sha
      ? (extRank[a.ext] ?? 9) - (extRank[b.ext] ?? 9)
      : a.sha.localeCompare(b.sha));
  for (const { f, sha } of audioFiles) {
    if (seenSha.has(sha)) continue;   // 同一首歌的其它格式跳过
    seenSha.add(sha);
    const full = join(AUDIO_DIR, f);
    const size = statSync(full).size;
    const meta = shaMeta.get(sha) || {};
    const v = meta.v || {};
    const title = String(v.title || ('音乐 ' + sha.slice(0, 8))).trim();
    const artist = String(v.artist || '').trim();
    const displayTitle = artist && !/官方|打开原曲/.test(artist) ? title + ' - ' + artist : title;
    /* 封面：优先仓库里的 data/covers/cv_<sha>.*（CDN 可用），其次缓存里的 cover */
    let cover = '';
    for (const ext of ['jpg', 'png', 'webp']) {
      if (existsSync(join(DATA_DIR, 'covers', 'cv_' + sha + '.' + ext))) {
        cover = 'data/covers/cv_' + sha + '.' + ext; break;
      }
    }
    if (!cover && v.cover) cover = String(v.cover);
    const ts = v.ts ? Math.floor(new Date(v.ts).getTime() / 1000) : (gitTime(full) || Math.floor(statSync(full).mtimeMs / 1000));
    const item = {
      id: 'mu' + sha.slice(0, 10),
      name: f,
      title: displayTitle,
      cat: '音乐',
      kind: 'audio',
      gif: false,
      url: 'data/audio/' + f,
      playUrl: 'data/audio/' + f,
      size,
      date: new Date(ts * 1000).toISOString(),
      src: 'file',
    };
    if (cover) item.cover = cover;
    if (v.album) item.album = String(v.album);
    musicItems.push(item);
  }
} catch (e) { console.error('生成音乐条目失败:', e.message); }

const all = files.concat(links, musicItems)
  .sort((a, b) => new Date(b.date) - new Date(a.date));

/* 只给最新的 40 张内联迷你预览：首屏滑几屏都有模糊占位，清单只增 ~15KB */
let lqipUsed = 0;
for (const item of all) {
  if (lqipUsed >= 40) break;
  if (item.lqip) { lqipUsed++; continue; }
  const base = (item.name || '').replace(/\.[^.]+$/, '') + '.webp';
  if (LQIPS[base]) { item.lqip = LQIPS[base]; lqipUsed++; }
}

/* 首屏 6 张把缩略图 base64 内联：清单一到就是清晰图，零图片请求。
 * 单张 WebP ~10-22KB，6 张约 120KB。两个清单都带 inline，
 * 否则完整清单后台替换首屏时会把内联图覆盖掉，首屏又变慢。 */
const hero = all.slice(0, 6);
for (const item of hero) {
  if (!item.thumb) continue;
  try {
    const buf = readFileSync(join(process.cwd(), item.thumb));
    item.inline = 'data:image/webp;base64,' + buf.toString('base64');
  } catch (e) {}
}

const out = { updated: new Date().toISOString(), items: all };
/* 不缩进：859 条清单从 ~588KB 降到 ~390KB，手机首开少下载三分之一 */
writeFileSync(join(DATA_DIR, 'wallpapers.json'), JSON.stringify(out), 'utf8');
/* 首屏小清单约 120KB：前端先拉它把首屏画出来，完整清单后台慢慢下再无缝替换。 */
writeFileSync(join(DATA_DIR, 'hero.json'),
  JSON.stringify({ updated: out.updated, items: hero }), 'utf8');
console.log(`hero: ${hero.length} 张首屏图（${hero.filter(x=>x.inline).length} 张内联清晰图）`);

console.log(`manifest: ${files.length} 文件 + ${links.length} 直链 = ${all.length} 条`);
