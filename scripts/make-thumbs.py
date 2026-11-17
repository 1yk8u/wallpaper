#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 wallpapers/ 下的静态图与 GIF 生成 WebP 缩略图到 thumbs/。

由 GitHub Actions 在清单重建时调用；已存在且体积正常的缩略图直接跳过，
所以 800 多张图只有第一次需要全量生成，之后新入库的几张才会真正处理。
"""
import os
import sys
import base64
import io
import json
from PIL import Image, ImageOps

ROOT = os.getcwd()
WALL_DIR = os.path.join(ROOT, 'wallpapers')
THUMB_DIR = os.path.join(ROOT, 'thumbs')
LQIP_PATH = os.path.join(ROOT, 'data', 'lqip.json')

# 国内访问 GitHub Pages 只有 ~3KB/s：原 440px/q74 一张 45KB 要传 18 秒。
# 网格最大 200px，用 300px/q55 视觉几乎无差，体积降到 ~10KB，传输快 4 倍。
MAX_W = 300
MAX_H = 560
QUALITY = 55
EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'}

# 迷你预览图（LQIP）：40px 宽塞进清单，清单一下完首屏立刻显示模糊图，
# 真实缩略图后台加载好再淡入替换，用户不用对着空白等十几秒。
LQIP_W = 40
LQIP_Q = 30
# 全部生成（ Actions 里 40px 小图几乎不耗时），清单端只内联最新的 40 张，
# 保证首屏一定有模糊占位，又不把清单撑大。
LQIP_MAX = 100000


def out_path(name):
    base = os.path.splitext(name)[0]
    return os.path.join(THUMB_DIR, base + '.webp')


def load_image(path):
    with Image.open(path) as raw:
        raw.seek(0)  # GIF 只取第一帧；动态效果留给点开后的原图
        im = ImageOps.exif_transpose(raw)
        if im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info):
            im = im.convert('RGBA')
            bg = Image.new('RGB', im.size, (232, 226, 207))
            bg.paste(im, mask=im.split()[-1])
            return bg
        if im.mode != 'RGB':
            im = im.convert('RGB')
        return im.copy()


def convert(src, dst):
    im = load_image(src)
    im.thumbnail((MAX_W, MAX_H), Image.LANCZOS)
    im.save(dst, 'WEBP', quality=QUALITY, method=4)
    return os.path.getsize(dst)


def make_lqip(src):
    """返回 40px WebP 的 data URI（约 300~600B），内联进清单当首屏占位图"""
    im = load_image(src)
    im.thumbnail((LQIP_W, LQIP_W), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=LQIP_Q, method=4)
    return 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


def too_big(dst):
    """旧缩略图 440px 需要重压：尺寸超标就重新生成（只做一次）"""
    try:
        with Image.open(dst) as im:
            return im.width > MAX_W
    except Exception:
        return True


def main():
    if not os.path.isdir(WALL_DIR):
        print('wallpapers/ 不存在，跳过缩略图生成')
        return 0
    os.makedirs(THUMB_DIR, exist_ok=True)

    # 读已有的迷你预览表，重复运行不重算
    old_lqips = {}
    if os.path.isfile(LQIP_PATH):
        try:
            with open(LQIP_PATH, encoding='utf-8') as f:
                old_lqips = json.load(f) or {}
        except Exception:
            old_lqips = {}

    made = skipped = failed = 0
    saved = 0
    names = {}
    lqips = {}   # 文件名 → data URI，最后写进 data/lqip.json
    for dirpath, _dirs, files in os.walk(WALL_DIR):
        for name in sorted(files):
            if name.startswith('.'):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in EXTS:
                continue
            src = os.path.join(dirpath, name)
            dst = out_path(name)

            # 同名文件来自不同子目录会互相覆盖，记下来提醒（清单同样按 basename 找缩略图）
            key = os.path.splitext(name)[0].lower()
            names[key] = names.get(key, 0) + 1

            try:
                original = os.path.getsize(src)
                if os.path.isfile(dst) and os.path.getsize(dst) > 1000 and not too_big(dst):
                    saved += max(0, original - os.path.getsize(dst))
                    skipped += 1
                else:
                    new_size = convert(src, dst)
                    saved += max(0, original - new_size)
                    made += 1
                # 前 N 张生成迷你预览（只处理一次，读已存在的 lqip.json 复用）
                if len(lqips) < LQIP_MAX and ext in EXTS:
                    key = os.path.splitext(name)[0] + '.webp'
                    if key not in old_lqips:
                        lqips[key] = make_lqip(src)
                    else:
                        lqips[key] = old_lqips[key]
            except Exception as e:
                failed += 1
                print('FAIL', os.path.relpath(src, ROOT), str(e)[:120])

    # 与旧表合并：已生成的预览保留，避免每次重建都重算
    old_lqips.update(lqips)
    try:
        os.makedirs(os.path.dirname(LQIP_PATH), exist_ok=True)
        with open(LQIP_PATH, 'w', encoding='utf-8') as f:
            json.dump(old_lqips, f, ensure_ascii=False, separators=(',', ':'))
    except Exception as e:
        print('LQIP 写入失败', str(e)[:120])

    dup = [k for k, v in names.items() if v > 1]
    print('thumbs: 新建/重压 %d, 跳过 %d, 失败 %d, 预计省下 %.1f MB' %
          (made, skipped, failed, saved / 1048576))
    print('lqip: %d 张迷你预览内联清单' % len(old_lqips))
    if dup:
        print('警告：%d 个同名文件（不同子目录）共用缩略图: %s' %
              (len(dup), ', '.join(dup[:5])))
    return 1 if failed and not made else 0


if __name__ == '__main__':
    sys.exit(main())
