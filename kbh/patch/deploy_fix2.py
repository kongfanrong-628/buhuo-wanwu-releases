#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""服务器拉取两个修复：server.py + sticker_templates.json，然后重启 kbh。"""
import os, urllib.request, ssl, subprocess, sys

ROOT = "/www/wwwroot/kbh/kbh-web"
SHA = "9a13f7315a9cb78e6bfb8486dc0362d5fcc138c5"
BASE = "https://cdn.jsdelivr.net/gh/kongfanrong-628/buhuo-wanwu-releases@%s/kbh/patch" % SHA
FILES = [
    ("server.py", "server.py"),
    ("static/data/sticker_templates.json", "static/data/sticker_templates.json"),
]

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

for remote, local in FILES:
    dest = os.path.join(ROOT, local)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    url = BASE + "/" + remote
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Cache-Control": "no-cache"})
    data = urllib.request.urlopen(req, timeout=180, context=ctx).read()
    with open(dest, "wb") as fh:
        fh.write(data)
    print("PULLED", local, len(data))

# 断言
s = open(os.path.join(ROOT, "server.py"), encoding="utf-8").read()
print("FEED_IMG_ROUTE", s.count('"/api/feed/img"'))
print("STICKER_TPL_ROUTE", s.count('"/api/sticker/templates"'))

# 重启
subprocess.run(["systemctl", "restart", "kbh"], check=False)
import time
time.sleep(4)
r = subprocess.run(["systemctl", "is-active", "kbh"], capture_output=True, text=True)
print("SVC", r.stdout.strip())
print("FIX2_DONE")
