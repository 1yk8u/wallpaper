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
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { return items; }
  for (const d of entries) {
    if (d.name.startsWith('.')) continue;
    const full = join(dir, d.name);
    if (d.isDirectory()) { items.push(...scan(full)); continue; }
    if (!isVideo(d.name) && !isGif(d.name) && !isImage(d.name)) continue;

    const rel = relative(WALLPAPER_DIR, full).split(sep).join('/');
    let id = gitBlobId(full) || createHash('sha1').update(readFileSync(full)).digest('hex').slice(0, 10);
    const ts = gitTime(full) || Math.floor((statSync(full).mtimeMs || Date.now()) / 1000);
    const title = d.name.replace(/\.[^.]+$/, '').replace(/[_\-]+/g, ' ').trim() || d.name;

    items.push({
      id: 'w' + id,
      name: d.name,
      title,
      kind: isVideo(d.name) ? 'video' : 'image',
      gif: isGif(d.name),
      url: 'wallpapers/' + rel,
      size: statSync(full).size,
      date: new Date(ts * 1000).toISOString(),
      src: 'file',
    });
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
