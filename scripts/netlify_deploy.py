# -*- coding: utf-8 -*-
"""一次性部署：静态文件 + Serverless Functions（Netlify Deploy API digest 模式）"""
import hashlib, io, json, os, sys, time, zipfile, urllib.request, urllib.error

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '_repo'))
SITE_ID = 'ea68dda9-f4de-4580-a985-3166c6c2c59e'
TOKEN = 'nfp_rGRvfu3LXik5TW1QHb1nrWtR5xDyD6Amfb62'
BASE = 'https://api.netlify.com/api/v1'

FILES = [
    'index.html', 'app.js', 'core.js', 'extractor.js', 'music.js', 'payment.js',
    'style.css', 'icon.svg', 'manifest.webmanifest', 'netlify.toml',
    'assets/qrcode.js', 'assets/pay-qr.png', 'assets/contact-qr.png',
    'netlify/functions/api.mjs', 'netlify/functions/pay.mjs', 'netlify/functions/music.mjs',
    'parser/engine.mjs',
    'dy2.html', 'dy_pc.html', 'ks.html', 'ks_m.html', 'xhs.html', 'ownparse.js',
]


def rd(p):
    with open(os.path.join(ROOT, p), 'rb') as f:
        return f.read()


def req(method, path, data=None, headers=None, raw=False):
    url = BASE + path
    h = {'Authorization': 'Bearer ' + TOKEN}
    if headers:
        h.update(headers)
    r = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            b = resp.read()
            return resp.status, (b if raw else json.loads(b or b'{}'))
    except urllib.error.HTTPError as e:
        b = e.read()
        try:
            return e.code, json.loads(b or b'{}')
        except Exception:
            return e.code, b[:500].decode('utf-8', 'ignore')
    except Exception as e:
        return -1, str(e)


def mkzip(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return buf.getvalue()


def sha1(b): return hashlib.sha1(b).hexdigest()
def sha256(b): return hashlib.sha256(b).hexdigest()


def main():
    # 0) 校验站点
    st, sites = req('GET', '/sites?name=wallpaper')
    print('sites:', st, [s.get('id') for s in sites] if isinstance(sites, list) else sites)
    if isinstance(sites, list) and sites:
        global SITE_ID
        SITE_ID = sites[0]['id']
    print('using site:', SITE_ID)

    contents = {}
    files = {}
    for p in FILES:
        full = os.path.join(ROOT, p)
        if not os.path.exists(full):
            print('  skip missing:', p)
            continue
        contents['/' + p] = rd(p)
        files['/' + p] = sha1(contents['/' + p])
    print('static files:', len(files))

    api_src = rd('netlify/functions/api.mjs')
    api_src = api_src.replace(b"from '../../parser/engine.mjs'", b"from './engine.mjs'")
    zips = {
        'pay':   mkzip({'pay.mjs': rd('netlify/functions/pay.mjs')}),
        'music': mkzip({'music.mjs': rd('netlify/functions/music.mjs')}),
        'api':   mkzip({'api.mjs': api_src, 'engine.mjs': rd('parser/engine.mjs')}),
    }
    functions = {k: sha256(v) for k, v in zips.items()}
    print('functions:', {k: (len(v), d[:12]) for k, (v, d) in ((k, (zips[k], functions[k])) for k in zips)})

    payload = {'files': files, 'functions': functions, 'async': True}
    st, dep = req('POST', '/sites/' + SITE_ID + '/deploys',
                  data=json.dumps(payload).encode(),
                  headers={'Content-Type': 'application/json'})
    print('create deploy:', st, json.dumps(dep, ensure_ascii=False)[:1200])
    if st not in (200, 201) or not isinstance(dep, dict) or not dep.get('id'):
        print('FAILED at create'); return 1
    did = dep['id']

    required = dep.get('required') or []
    rf = dep.get('required_functions') or []
    print('required files:', len(required) if isinstance(required, list) else required)
    print('required_functions:', json.dumps(rf, ensure_ascii=False)[:600])

    # 1) 上传需要的文件
    if isinstance(required, list):
        for p in required:
            key = p if p.startswith('/') else '/' + p
            if key not in contents:
                print('  !! no content for', key); continue
            path = '/deploys/' + did + '/files/' + key.lstrip('/')
            s, r = req('PUT', path, data=contents[key],
                       headers={'Content-Type': 'application/octet-stream'}, raw=True)
            print('  file', key, s)

    # 2) 上传函数 zip
    names = []
    if isinstance(rf, list):
        for x in rf:
            names.append(x if isinstance(x, str) else (x.get('name') or x.get('function')))
    elif isinstance(rf, dict):
        names = list(rf.keys())
    if not names:
        names = list(zips.keys())
    for n in names:
        if not n or n not in zips:
            print('  !! unknown function', n); continue
        s, r = req('PUT', '/deploys/' + did + '/functions/' + n + '?runtime=js',
                   data=zips[n], headers={'Content-Type': 'application/zip'}, raw=True)
        print('  function', n, s, str(r)[:200])

    # 3) 等状态
    for _ in range(24):
        s, d = req('GET', '/deploys/' + did)
        if isinstance(d, dict):
            print('  deploy state:', d.get('state'), d.get('error_message') or '')
            if d.get('state') in ('ready', 'error', 'rejected'):
                print('  available_functions:', json.dumps(d.get('available_functions', []), ensure_ascii=False)[:400])
                print('FINAL:', d.get('state'), d.get('deploy_ssl_url') or d.get('ssl_url') or '')
                return 0 if d.get('state') == 'ready' else 1
        time.sleep(5)
    print('timeout waiting state'); return 1


if __name__ == '__main__':
    sys.exit(main())
