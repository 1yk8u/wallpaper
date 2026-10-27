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

const isVideo = (n) => /\.(mp4|mov|webm|m4v)$/i.test(n);
const isGif = (n) => /\.gif$/i.test(n);
const isImage = (n) => /\.(jpe?g|png|webp|avif)$/i.test(n);

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
    if (!isVideo(f.name) && !isGif(f.name) && !isImage(f.name)) continue;

    const rel = relative(WALLPAPER_DIR, f.full).split(sep).join('/');
    const dot = f.name.lastIndexOf('.');
    const baseKey = (dot > 0 ? f.name.slice(0, dot) : f.name).toLowerCase();
    const coverFull = covers.get(baseKey);
    let id = gitBlobId(f.full) || createHash('sha1').update(readFileSync(f.full)).digest('hex').slice(0, 10);
    const ts = gitTime(f.full) || Math.floor((statSync(f.full).mtimeMs || Date.now()) / 1000);
    const title = f.name.replace(/\.[^.]+$/, '').replace(/\.\d+$/, '').replace(/[_\-]+/g, ' ').trim() || f.name;

    const item = {
      id: 'w' + id,
      name: f.name,
      title,
      kind: isVideo(f.name) ? 'video' : 'image',
      gif: isGif(f.name),
      url: 'wallpapers/' + rel,
      size: statSync(f.full).size,
      date: new Date(ts * 1000).toISOString(),
      src: 'file',
    };
    if (coverFull) item.cover = 'wallpapers/' + relative(WALLPAPER_DIR, coverFull).split(sep).join('/');
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
        kind: x.kind === 'video' ? 'video' : 'image',
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
const all = files.concat(links)
  .sort((a, b) => new Date(b.date) - new Date(a.date));

const out = { updated: new Date().toISOString(), items: all };
writeFileSync(join(DATA_DIR, 'wallpapers.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(`manifest: ${files.length} 文件 + ${links.length} 直链 = ${all.length} 条`);
