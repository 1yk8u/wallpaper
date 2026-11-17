#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 wallpapers/ 下的静态图与 GIF 生成 WebP 缩略图到 thumbs/。

由 GitHub Actions 在清单重建时调用；已存在且体积正常的缩略图直接跳过，
所以 800 多张图只有第一次需要全量生成，之后新入库的几张才会真正处理。
"""
import os
import sys
from PIL import Image, ImageOps

ROOT = os.getcwd()
WALL_DIR = os.path.join(ROOT, 'wallpapers')
THUMB_DIR = os.path.join(ROOT, 'thumbs')

MAX_W = 440          # 网格最大 200px 宽，按 2x 屏留余量
MAX_H = 800
QUALITY = 74         # WebP 质量：肉眼看不出差别，体积通常只剩原图 1/5 ~ 1/10
EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'}


def out_path(name):
    base = os.path.splitext(name)[0]
    return os.path.join(THUMB_DIR, base + '.webp')


def convert(src, dst):
    with Image.open(src) as raw:
        raw.seek(0)  # GIF 只取第一帧；动态效果留给点开后的原图
        im = ImageOps.exif_transpose(raw)
        if im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info):
            im = im.convert('RGBA')
            bg = Image.new('RGB', im.size, (232, 226, 207))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        elif im.mode != 'RGB':
            im = im.convert('RGB')
        im.thumbnail((MAX_W, MAX_H), Image.LANCZOS)
        im.save(dst, 'WEBP', quality=QUALITY, method=4)
    return os.path.getsize(dst)


def main():
    if not os.path.isdir(WALL_DIR):
        print('wallpapers/ 不存在，跳过缩略图生成')
        return 0
    os.makedirs(THUMB_DIR, exist_ok=True)

    made = skipped = failed = 0
    saved = 0
    names = {}
    for dirpath, _dirs, files in os.walk(WALL_DIR):
        for name in files:
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
                if os.path.isfile(dst) and os.path.getsize(dst) > 1000:
                    saved += max(0, original - os.path.getsize(dst))
                    skipped += 1
                    continue
                new_size = convert(src, dst)
                saved += max(0, original - new_size)
                made += 1
            except Exception as e:
                failed += 1
                print('FAIL', os.path.relpath(src, ROOT), str(e)[:120])

    dup = [k for k, v in names.items() if v > 1]
    print('thumbs: 新建 %d, 跳过 %d, 失败 %d, 预计省下 %.1f MB' %
          (made, skipped, failed, saved / 1048576))
    if dup:
        print('警告：%d 个同名文件（不同子目录）共用缩略图: %s' %
              (len(dup), ', '.join(dup[:5])))
    return 1 if failed and not made else 0


if __name__ == '__main__':
    sys.exit(main())
