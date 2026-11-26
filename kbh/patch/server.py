# -*- coding: utf-8 -*-
"""
孔不惑会员站 —— 单端口同源服务

为什么不再单独开一个抓取后端：
  部署工具在同一账户下只能维护一个应用，没有"新建第二个应用"的入口，
  传别的目录也是覆盖同一个 appId。所以抓取只能和站点同源：
  静态页挂在 /，抓取挂在 /api/fetch，OCR 挂在 /api/ocr。

同源的好处（顺带把三个老问题一起解决了）：
  1. 线上是 https，跨域调 http 会被混合内容策略拦死 —— 同源不存在这个问题；
  2. 不需要 CORS 头，也不用担心预检；
  3. 前端不用再判断 localhost 还是线上，相对路径直接通。

风险控制：
  - 抓取和 OCR 全部 try/except 兜住，任何异常都只让 /api 返回错误，
    绝不允许把静态文件服务带崩（站点挂了比抓取失败严重得多）。
  - 静态目录做黑名单，fetcher/ 源码、.workbuddy/、.git/ 一律不对外。
"""
import os
import sys
import json
import time
import base64
import threading
import traceback
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT") or 8899)
# 部署版本指纹：写进 /api/health，用来确认线上跑的到底是哪一版代码。
# 2026-11-09 加：改了 Origin 却仍报 401，必须能分清「没部署成功」和「部署了但没修好」。
BUILD_ID = "2026-11-27-web-login"

# 抓取模块单独放一层：它 import 失败也不该拖累整站
sys.path.insert(0, os.path.join(ROOT, "fetcher"))
_fetch = {"ok": False, "mod": None, "err": ""}
try:
    import app as _fapp  # noqa: E402
    _fetch = {"ok": True, "mod": _fapp, "err": ""}
except Exception as e:
    _fetch["err"] = "%s: %s" % (type(e).__name__, e)

# 写作工坊网页端业务核心（#63）：纯规则放 wccore/ 子包，BYOK 代调复用 byok_vault。
# 独立加载，失败只让这几个端点不可用，绝不带崩站点。
_webcore = {"ok": False, "mod": None, "err": ""}
try:
    import webcore as _wc  # noqa: E402
    _webcore = {"ok": True, "mod": _wc, "err": ""}
except Exception as e:
    _webcore["err"] = "%s: %s" % (type(e).__name__, e)

# 排版导出核心（#63 切片3a）：复用 wctypeset/（typeset 纯逻辑副本）
_wts = {"ok": False, "mod": None, "err": ""}
try:
    import webtypeset as _wts_mod  # noqa: E402
    _wts = {"ok": True, "mod": _wts_mod, "err": ""}
except Exception as e:
    _wts["err"] = "%s: %s" % (type(e).__name__, e)

# 作品云端表（#63 切片3b）
_ww = {"ok": False, "mod": None, "err": ""}
try:
    import webworks as _ww_mod  # noqa: E402
    _ww = {"ok": True, "mod": _ww_mod, "err": ""}
except Exception as e:
    _ww["err"] = "%s: %s" % (type(e).__name__, e)

# 不对外暴露的路径前缀（真实文件名 / 目录名，一律小写比较）
DENY_DIRS = ("fetcher", ".workbuddy", ".git", ".svn", "node_modules", "__pycache__")
# 2026-11-27：补 .key —— 根目录 _redfox.key 存的是红狐接口密钥，原来不在黑名单里，
# 线上可以直接 GET /_redfox.key 下载。任何 .key/.pem 都是凭证，一律不外发。
DENY_EXT = (".py", ".bak", ".log", ".env", ".psd", ".sql", ".key", ".pem", ".p12")
# 精确挡掉这几个名字（.txt 本身要放行，站内有下载说明文本）
DENY_NAMES = ("requirements.txt", "procfile", "dockerfile",
              # 2026-11-01：这些是构建/自检产物，不是站内运行时数据，不该对外。
              "audit_mobile_report.json",
              "audit_remote_report.json", "convert_report.json",
              # 2026-11-08：内部迁移方案文档，正文是 5 分/张的旧价，站内也没有任何入口。
              # 本地已移出站点目录，但部署不删远端旧文件，所以这里再封一道。
              "小程序迁移方案.html")
# contents_rows.json 是灌库用的全量索引（557 条标题 + 内部知识库源路径），线上匿名
# 能直接下载＝泄露内容清单。但本地 #preview 模式靠它灌演示数据，所以只在
# Host 为 localhost/127.0.0.1 时放行，线上仍然 404。
DENY_NAMES_LOCAL_OK = ("contents_rows.json",)
# 注意别误伤：skill_packs.json / layer_map.js / resources-data.js 是页面运行时数据，必须放行。
# 会员专属资源目录：即使磁盘上还有旧副本，也一律不对外（开通后由站长单独发放）
# 2026-11-08：skills / free 纳入服务端门禁——静态直取一律拒绝，只能走 /api/dl 验票下载。
# 目的：以前 <a download> 是纯静态链接，拿到 URL 就能匿名白嫖，前端点按钮拦截形同虚设。
DENY_PREFIX = ("assets/downloads/member/", "assets/downloads/_member/",
               "assets/downloads/skills/", "assets/downloads/free/")

# /api/dl 允许吐出的目录（验票后才能读，不走 _safe_path 的 DENY_PREFIX）
DL_ALLOW_PREFIX = ("assets/downloads/skills/", "assets/downloads/free/",
                   "assets/downloads/life-guide/")
# 本站对外域名（反代会把 Host 改写成内部地址，wp-doc.html 的同源校验要用它兜底）
SITE_HOSTS = ("kongbuhuo-member.app.workbuddy.host",)

# ---------------------------------------------------------------- 反爬（2026-11-01）
# 目标只有一条：**挡住批量抓取**，不做严格会员门禁。目录、标题、课时一律公开，
# 正文 / PDF / zip / 白皮书片段才设防。所以策略是「直取挡死、正常点开无感」：
#   1) UA 黑名单   —— 挡 curl / wget / requests / scrapy 这类脚本直取
#   2) Referer 同源 —— 挡「拿到 URL 直接敲」（正文页正常路径是站内点开，必带本站 Referer）
#   3) 蜜罐链接    —— 正文里埋一个不可见 <a>，跟进去的必然是爬虫，封 1 小时
#   4) 限流        —— 兜住前三条漏掉的（只在拿得到真实 IP 时生效，避免反代后误伤全站）
# 不做什么：不拦空 UA（个别内嵌浏览器会空）、不拦搜索引擎（目录公开是我们想要的）。
SPIDER_UA = (
    "curl/", "wget/", "python-requests", "python-urllib", "python-httpx", "aiohttp",
    "httpclient", "httplib", "scrapy", "mechanize", "libwww-perl", "lwp-",
    "go-http-client", "java/", "okhttp", "apache-httpclient", "node-fetch",
    "axios/", "got (", "postman", "insomnia", "httpie", "ruby/", "php/",
    "headlesschrome", "phantomjs", "puppeteer", "playwright", "selenium",
    "sqlmap", "nikto", "nmap", "masscan", "zgrab", "nuclei",
)
# 需要设防的路径前缀（正文与下载物）。目录类 JSON 不在此列——目录本来就公开。
SENSITIVE_PREFIX = ("articles/", "kb/", "assets/pdf/")
SENSITIVE_EXT = (".zip",)
# 白皮书正文片段（历史上单列的，保留在这条通道里）
GUARDED_NAMES = ("wp-doc.html",)
# 蜜罐：这个路径不存在、正常页面也不会链它。谁访问谁就是爬虫。
HONEYPOT_PATHS = ("/articles/all-articles.html", "/kb/manual-all.html", "/sitemap-full.xml")
BAN_SECONDS = 3600
RATE_WINDOW = 60            # 秒
RATE_MAX_HITS = 120         # 单 IP 60 秒内允许的敏感请求数（真人一天也到不了）
RATE_MAX_BYTES = 200 << 20  # 单 IP 60 秒内允许的敏感内容字节数（200MB）
_bans = {}                  # ip -> 解封时间戳
_hits = {}                  # ip -> [时间戳...]
_bytes = {}                 # ip -> [[时间戳, 字节数]...]
_gate_lock = threading.Lock()


def _client_ip(handler):
    """取真实访客 IP。反代会把 client_address 变成 127.0.0.1，优先 XFF。

    返回 (ip, 是否可信)。不可信 = 反代没传真实 IP，此时绝不能按 IP 限流，
    否则全站访客共用一个计数器，一个爬虫就把所有真人一起挡死。
    """
    raw = handler.headers.get("X-Forwarded-For") or ""
    if raw.strip():
        ip = raw.split(",")[0].strip()
        if ip:
            return ip, True
    ip = handler.headers.get("X-Real-IP") or ""
    if ip.strip():
        return ip.strip(), True
    ip = (handler.client_address or ("",))[0] if handler.client_address else ""
    # 本机 / 内网地址 = 反代没传，不可信
    private = (ip in ("", "127.0.0.1", "::1")
               or ip.startswith("10.")
               or ip.startswith("192.168.")
               or any(ip.startswith("172.%d." % n) for n in range(16, 32)))
    return ip, not private


def _is_banned(ip, trusted=True):
    if not ip or not trusted:
        return False
    with _gate_lock:
        exp = _bans.get(ip)
        if exp is None:
            return False
        if exp < time.time():
            _bans.pop(ip, None)
            return False
        return True


def _ban(ip, trusted, why=""):
    """封 IP。**只对可信 IP 生效** —— 反代不传真实 IP 时所有请求都是 127.0.0.1，
    封它等于把整站封死。那种情况下退化成"只挡本次请求，不封后续"。"""
    if not ip:
        return
    if not trusted:
        sys.stderr.write("BAN-SKIP %s (%s) 无真实 IP，不封禁\n" % (ip, why))
        return
    with _gate_lock:
        _bans[ip] = time.time() + BAN_SECONDS
        if len(_bans) > 5000:            # 防止内存被刷爆
            now = time.time()
            for k in [k for k, v in _bans.items() if v < now]:
                _bans.pop(k, None)
    sys.stderr.write("BAN %s (%s)\n" % (ip, why))


def _rate_check(ip, trusted, nbytes=0):
    """滑动窗口限流。返回 True = 放行。只对可信 IP 生效。"""
    if not trusted or not ip:
        return True
    now = time.time()
    cut = now - RATE_WINDOW
    with _gate_lock:
        h = _hits.setdefault(ip, [])
        h[:] = [t for t in h if t > cut]
        h.append(now)
        n_hits = len(h)
        b = _bytes.setdefault(ip, [])
        b[:] = [x for x in b if x[0] > cut]
        if nbytes:
            b.append((now, nbytes))
        total = sum(x[1] for x in b)
        if len(_hits) > 20000:          # 内存保护
            for k in [k for k, v in _hits.items() if not v or v[-1] < cut]:
                _hits.pop(k, None)
                _bytes.pop(k, None)
    if n_hits > RATE_MAX_HITS:
        _ban(ip, True, "rate hits %d" % n_hits)
        return False
    if total > RATE_MAX_BYTES:
        _ban(ip, True, "rate bytes %d" % total)
        return False
    return True


def _ua_is_spider(ua):
    u = (ua or "").lower()
    if not u:
        return False
    return any(t in u for t in SPIDER_UA)


def _is_sensitive(full):
    rel = os.path.relpath(full, ROOT).replace("\\", "/").lower()
    if os.path.basename(rel) in GUARDED_NAMES:
        return True
    if rel.endswith(SENSITIVE_EXT):          # 根目录的 .zip 成品包
        return True
    # 正文 / 手册 / 白皮书 PDF：只挡文档本身。
    # 同一目录下的图片必须放行，否则正文里的图会全裂（articles/ 里有配图）。
    if rel.startswith(SENSITIVE_PREFIX) and rel.endswith(
            (".html", ".htm", ".pdf", ".zip", ".epub", ".mobi", ".docx")):
        return True
    return False


def _referer_same_site(handler):
    ref = handler.headers.get("Referer") or ""
    if not ref:
        return False
    host = handler.headers.get("Host") or ""
    fwd = handler.headers.get("X-Forwarded-Host") or ""
    return bool(
        (host and host in ref)
        or (fwd and fwd in ref)
        or any(h in ref for h in SITE_HOSTS)
    )


def _ua_is_browser(ua):
    """正常浏览器 UA。爬虫/脚本上面已经挡掉了，这里只用来区分 curl、requests 这类直取。"""
    u = (ua or "").lower()
    if "mozilla/" not in u:
        return False
    return any(t in u for t in ("chrome/", "safari/", "firefox/", "edg/", "micromessenger"))


# 无来源直开正文时给人的提示页（2026-11-01）
# 之前这种情况一律伪装 404 —— 学员把文章链接粘到微信、或者存成书签再打开，只会看到「找不到」，
# 根本分不清是没登录、链接错了、还是内容没了。现在正常浏览器给这一页，
# 爬虫（UA 上面已判）仍旧 404，正文一个字都不吐。
DENIED_PAGE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>请从会员站进入 · 孔不惑AIko</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
 background:#F5F4F0;color:#0B0B12;padding:24px;
 font:15px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.card{max-width:470px;width:100%;background:#fff;border-radius:18px;padding:34px 30px;
 box-shadow:0 18px 50px rgba(11,11,18,.08);text-align:center}
.badge{width:48px;height:48px;border-radius:14px;background:#FF4D00;color:#fff;
 display:flex;align-items:center;justify-content:center;font-size:22px;margin:0 auto 18px}
h1{font-size:19px;margin:0 0 10px}
p{margin:0 0 8px;color:#5F5E5A;font-size:14px}
a.btn{display:inline-block;margin-top:22px;background:#FF4D00;color:#fff;text-decoration:none;
 padding:12px 26px;border-radius:999px;font-weight:600;font-size:14px}
small{display:block;margin-top:18px;color:#8A8880;font-size:12px;line-height:1.7}
</style></head>
<body><div class="card">
<div class="badge"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v16H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 18.5V5.5"/></svg></div>
<h1>这篇正文要先进会员站</h1>
<p>你这次是直接打开链接的，没有从站点里点进来。</p>
<p>为了防止整站内容被批量抓走，正文只对站内打开放行。</p>
<a class="btn" href="/index.html#page=knowledge">进会员站阅读 →</a>
<small>登录后如果账号是生效中的会员，从知识库点开这一篇就能直接读。<br>已经是会员还打不开？到「会员服务」页看看账号状态。</small>
</div></body></html>"""

# 图片代理白名单（防 SSRF：绝不能让 /api/img?u= 去打内网地址）。
# 为什么需要图片代理：小红书 CDN（xhscdn.com）有 Referer 防盗链。
# 浏览器直接 <img src="https://sns-webpic-qc.xhscdn.com/..."> 时会自动带上
# 本站域名当 Referer，CDN 判定盗链 → 403，前端只能显示「图1 图2」占位符。
# 实测：无 Referer = 200，带小红书 Referer = 200，带本站 Referer = 403。
# 代理转发时由服务端带正确的 Referer，前端请求同源 /api/img 就不会被拦。
IMG_HOSTS = (
    "xhscdn.com",
    "xhscdn.cn",
    "xiaohongshu.com",
    "qpic.cn",
    "qlogo.cn",
    "mmbiz.qpic.cn",
    "mmbiz.qlogo.cn",
    # 2026-11-02 爆款情报上线：首期 4 平台（小红书/抖音/公众号/视频号）的图床。
    # 只加公网图片 CDN，不加任何可能解析到内网的域名；逐跳校验逻辑不变。
    "douyinpic.com",
    "douyinstatic.com",
    "byteimg.com",
    "snssdk.com",
    "wx.qlogo.cn",
    "findermp.video.qq.com",
    # 红狐自己的图片 CDN：榜单头像/封面大多走这个（sns-avatar-qc-ae.rednotecdn.com），
    # 不加的话「找对标 / 体检」的头像全裂 403。
    "rednotecdn.com",
    # 小红书新版封面域名是 .net（sns-img-hw.xhscdn.net），和 .com 不是同一个后缀
    "xhscdn.net",
)

# ---------------------------------------------------------------- 每日 AI 资讯（AI HOT）
# 为什么走服务端同源转发，而不是前端直连：
#   AI HOT 接口本身返回 Access-Control-Allow-Origin: *，curl 带任意 Origin 都能看到；
#   但真浏览器（本机代理 / 企业网关 / CDN 策略）实测拿不到这个头，fetch 一律被 CORS 拦，
#   只能退回静态快照。同源转发把这件事变成站内请求，浏览器侧零跨域风险，且仍然零成本：
#   不新增应用、不新增密钥、不消耗积分，复用现有 Python 服务。
# 🔴 URL 三个路径写死在服务端，前端不允许传任意地址 → 不构成开放代理 / SSRF。
AIHOT_API = "https://aihot.news/api/v1"
AIHOT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
AIHOT_PATHS = (
    ("sel",   "/items?mode=selected&window=7d&limit=24"),
    ("daily", "/dailies/latest"),
    ("arch",  "/dailies?limit=7"),
)
_aihot_cache = {"ts": 0.0, "data": None}   # 5 分钟内存缓存，减轻上游压力

# ---------------------------------------------------------------- 红狐网关
# 2026-11-02：爆款情报（/api/redfox）。
# 铁律：密钥只在服务端环境变量里，前端永远只调同源 /api/redfox。
# 动作白名单 = 唯一可信来源，前端传 action，绝不接受前端传任意 path（否则等于开放代理）。
REDFOX_API = "https://redfox.hk"
REDFOX_ENV = "REDFOX_API_KEY"


def _redfox_key():
    """取密钥：环境变量优先，其次同目录 _redfox.key 文件。

    部署通道不支持注入环境变量，所以线上靠文件兜底。这个文件下划线开头 —— 
    `_safe_path()` 本来就拒绝任何下划线开头的路径，所以 HTTP 侧拿不到它；
    同时 .gitignore 排除了它，不进版本库、不进前端。
    """
    k = (os.environ.get(REDFOX_ENV) or "").strip()
    if k:
        return k
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_redfox.key")
    try:
        with open(p, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""



# action -> (方法, 真实 path)。path 里带平台后缀的必须写全 ——
# 文档列表页显示的是截断版（/parseWork/videoDownload），照抄会全 404。
REDFOX_ACTIONS = {
    # 功能1 全网找热点
    "hot_all":       ("POST", "/story/api/hotKeyword/list"),
    # 单平台热榜：文档写的是 GET，之前误写成 POST，导致恒 500
    # platform 编号（实测）：1 快手 / 2 抖音 / 5 微博 / 6 小红书 / 7 百度 / 8 B站
    # 日期必须是 "yyyy-MM-dd HH:mm:ss"，只传日期会返回空数组（code 仍是 2000）
    "hot_platform":  ("GET", "/story/api/hotSpot/getListByPlatform"),
    # 全网关键词热搜：platforms 和 keywords 都是数组，不是单个字符串
    "hot_keyword":   ("POST", "/story/api/hotSpot/getListByPlatformWithKeyword"),
    "xhs_rank_daily": ("GET", "/story/api/cozeSkill/getXhsCozeSkillDataOne"),
    "xhs_rank_week": ("GET", "/story/api/cozeSkill/getXhsCozeSkillDataSeven"),
    # 黑马爆文是 POST（文档页 Method: POST），参数 category + rankDate，
    # 写成 GET 会返回 500「请求异常，请仔细检查填写的参数是否有误」——极具误导性
    "xhs_rank_dark": ("POST", "/story/api/cozeSkill/getLowPowderExplosiveArticle"),
    # 10W+ 是 POST，且参数名是 type（不是 category），type 取值见 RS_GZH_TYPE
    "gzh_rank_10w":  ("POST", "/story/api/cozeSkill/getTenWReadingRank"),
    # 原创爆款同理是 POST：type + startDate + endDate，返回体自带 content 全文
    "gzh_rank_original": ("POST", "/story/api/cozeSkill/getOriginalRank"),

    # 功能1.5 找爆款作品（关键词搜作品 + 平台作品榜）
    "xhs_search_work":  ("POST", "/story/api/xhs/search/search"),
    "douyin_search_work": ("POST", "/story/api/dyData/searchArticle"),
    "gzh_search_work":  ("POST", "/story/api/gzhData/searchArticle"),
    # 2026-11-06 AI 垂类：公众号 AI 相关作品（优质库，按关键词搜索，仅 AI 垂直内容）
    "gzh_search_ai":    ("POST", "/story/api/parseWork/queryAiMsgs"),
    # 2026-11-06 公众号平台榜单（账号榜）——两个必须注意 method：
    # 阅读增长榜是 GET(query 参数)，写成 POST 会返回 code 500 极具误导；头条增长榜是 POST(json body)。
    # 综合实力榜用已有 gzh_rank_index(GET getGzhCozeSkillDataIndex)，抓账号作品用已有 gzh_works(POST queryWorkList)。
    "gzh_rank_raise":    ("GET",  "/story/api/cozeSkill/getGzhCozeSkillDataRaise"),
    "gzh_rank_headline": ("POST", "/story/api/gzh/heima/rankList"),
    "sph_search_work":  ("POST", "/story/api/sphAllData/searchWork"),
    "douyin_rank_works":  ("POST", "/story/api/dy/search/likesRank"),
    "douyin_rank_rising": ("POST", "/story/api/dy/search/getDailyRank"),
    "douyin_rank_week":   ("POST", "/story/api/dy/search/getWeeklyRank"),
    # 功能2 全网找对标
    "xhs_hot_account": ("POST", "/story/api/xhsData/query"),
    "douyin_hot_account": ("POST", "/story/api/dyData/query"),
    "gzh_rank_index": ("GET", "/story/api/cozeSkill/getGzhCozeSkillDataIndex"),
    "xhs_search_user": ("POST", "/story/api/xhsUser/searchUser"),
    "douyin_search_user": ("POST", "/story/api/dyData/searchUser"),
    "gzh_search_user": ("POST", "/story/api/gzhData/searchUser"),
    "sph_search_user": ("POST", "/story/api/sphAllData/searchUser"),
    # 功能3 账号体检（3 次必调 + 1 次可选）
    "xhs_account":   ("POST", "/story/api/xhsUser/queryAccountDetail"),
    "xhs_works":     ("POST", "/story/api/xhsUser/queryWorkList"),
    "xhs_work":      ("POST", "/story/api/xhsUser/queryWorkDetail"),
    "douyin_account": ("POST", "/story/api/dyData/queryUser"),
    "douyin_works":  ("POST", "/story/api/dyData/queryWorkList"),
    "douyin_work":   ("POST", "/story/api/dyData/queryWork"),
    "gzh_account":   ("POST", "/story/api/gzhData/queryUser"),
    "gzh_works":     ("POST", "/story/api/gzhData/queryWorkList"),
    # 视频号作品列表：参数是 nickname/view/page（不是 accountId）。
    # 这一条让视频号从「只能简版体检」变成能算完整体检（作品自带 followerCount/likeCount/favCount）
    "sph_works":     ("POST", "/story/api/sphAllData/queryWorkList"),
    "sph_work":      ("POST", "/story/api/sphAllData/queryWorkDetail"),
    # 功能4 文案下载
    "gzh_article_url": ("POST", "/story/api/gzh/ability/temp/article/content"),
    "xhs_note":      ("POST", "/story/api/xhsUser/queryWorkDetail"),
    "douyin_note":   ("POST", "/story/api/dyData/queryWork"),
    "audio_submit":  ("POST", "/story/api/parseWork/audioTextExtract/submit/{suffix}"),
    "audio_result":  ("POST", "/story/api/parseWork/audioTextExtract/result/{suffix}"),
    "sph_submit":    ("POST", "/story/api/parseWork/sphSubtitle/submit"),
    "sph_result":    ("POST", "/story/api/parseWork/sphSubtitle/result"),
    # 功能5 视频下载
    "video_download": ("POST", "/story/api/parseWork/videoDownload/{suffix}"),
    "video_parse":   ("POST", "/story/api/parseWork/parse"),
    # 工具：违禁词（<3000 字）
    "banned_words":  ("POST", "/story/api/cozeSkill/sensitiveWordSearch"),
}

# 各平台在路径里的后缀（实测：xhs / douyin / sph / kuaishou / bilibili）
REDFOX_SUFFIX = {"xiaohongshu": "xhs", "douyin": "douyin",
                 "shipinhao": "sph", "kuaishou": "kuaishou", "bilibili": "bilibili"}

# 这些动作的 platform 是接口真参数，不能当路径提示删掉
REDFOX_KEEP_PLATFORM = {"hot_platform"}

# ---------------------------------------------------------------- 云端计费（2026-11-03）
# 铁律：publishableKey 是**公开**的（前端 config.js 里本来就明文），它只用来定位应用；
# 真正决定"能扣谁的分"的是用户自己的 access_token。**绝不使用 service_role / anon 提权**，
# 否则服务端一旦被打穿就能改任意人余额。
CLOUD_ENDPOINT = "https://kongbuhuo-member.app.workbuddy.host"
CLOUD_PUB_KEY = "wbpk_lwasoCDMaCIVvRZlKpG9HO_PE10H7OY2Bf7mH9x2wzNyU7LScYeXp88"
CLOUD_RPC = CLOUD_ENDPOINT + "/.cloud/database/rest/rpc/"
CLOUD_DB = CLOUD_ENDPOINT + "/.cloud/database/rest/"


def _pick_access_token(obj, depth=0):
    """从登录响应里挖 access_token（云端可能包在 data / session 里）。"""
    if depth > 4:
        return ""
    if isinstance(obj, dict):
        for k in ("access_token", "accessToken"):
            v = obj.get(k)
            if isinstance(v, str) and v:
                return v
        for v in obj.values():
            t = _pick_access_token(v, depth + 1)
            if t:
                return t
    elif isinstance(obj, list):
        for v in obj:
            t = _pick_access_token(v, depth + 1)
            if t:
                return t
    return ""


def _jwt_exp(tok):
    """取 JWT 的 exp（秒）。解不出来就返 0，交给前端按「未知」处理。"""
    try:
        seg = tok.split(".")[1]
        seg += "=" * (-len(seg) % 4)
        return int(json.loads(base64.urlsafe_b64decode(seg)).get("exp") or 0)
    except Exception:  # noqa: BLE001
        return 0

# ---------------------------------------------------------------- 热点同步（2026-11-26 / #61）
# 独立模块放 fetcher/，import 失败只让热点接口不可用，绝不带崩站点。
_hotspot = {"ok": False, "mod": None, "err": ""}
try:
    import hotspot_sync as _hs  # noqa: E402
    _hs.CFG = {
        "endpoint": CLOUD_ENDPOINT,
        "pub_key": CLOUD_PUB_KEY,
        "rpc": CLOUD_RPC,
        "db": CLOUD_DB,
        "cloud_headers": None,   # _cloud_headers 在下面定义，延迟绑定
        "jwt_uid": None,         # _jwt_uid 同上，延迟绑定
    }
    _hotspot = {"ok": True, "mod": _hs, "err": ""}
except Exception as e:  # noqa: BLE001
    _hotspot["err"] = "%s: %s" % (type(e).__name__, e)

# 动作 → 扣多少积分（🔴 服务端唯一真相源，绝不接受前端传价）
#
# 🔴 为什么多数是 5 分：红狐按 **request 次数** 计费，而「账号体检」这种动作
# 前端要连调 2–3 个接口（账号信息 → 作品列表 → 可能补详情）。如果每个接口
# 都按 10 分收，用户看到"体检 10 分"却实扣 20–30 分，必然投诉。
# 所以：**单次接口一律 5 分**，体检类由前端标注"约 10–15 分，按实际调用扣"。
# 10/15/20 三档留给后续「打包动作」（一次请求跑多步、一次扣费）。
# 0 分 / 不占额度的例外：
#  - audio_result / sph_result：异步任务的结果轮询（前端最多轮询 20 次），
#    既不该重复收费，也不该把当天额度耗光。
#  - 违禁词**不在此列**：会员站没有本机词库，走红狐就得花站长的钱，
#    所以照样 5 分、照样占额度。（写作工坊那边有本机词库，是另一套免费实现）
REDFOX_POINTS = {
    "audio_result": 0, "sph_result": 0,
    "banned_words": 5,   # 违禁词体检：引流 5 分（2026-11-03 对齐前端展示，实际与 default 同）
}
REDFOX_POINTS_DEFAULT = 5     # 其余所有接口：5 分/次（引流价，毛利 64%）

# 不占每日额度的动作（免费、且会被前端高频轮询）：
# 视频转文案是「提交 1 次 + 轮询结果最多 20 次」，若轮询也计入额度，
# 用户解析一条视频就把当天 20 次额度耗光 —— 必须排除。
REDFOX_NO_QUOTA = {"audio_result", "sph_result"}

# 每日额度（按 **登录用户** 计数，不再按 IP —— IP 会重启清零、NAT 共享、换代理即绕开）
REDFOX_QUOTA = {"free": 3, "member": 20, "vip": 100}
_redfox_used = {}      # "uid|YYYYMMDD" -> 次数
_redfox_lock = threading.Lock()

# 账号体检聚合计费：一次体检 = 一个 session，整次只扣一次（完整版 20 / 轻量版 10），
# 内部多次红狐调用不再逐笔扣。session 带 60s 过期防重放薅羊毛。
_checkup_sessions = {}
def _checkup_first(sid):
    now = time.time()
    with _redfox_lock:
        for k in [k for k, v in _checkup_sessions.items() if now - v > 60]:
            _checkup_sessions.pop(k, None)
        if sid not in _checkup_sessions:
            _checkup_sessions[sid] = now
            return True
        return False


def _redfox_quota_used(uid):
    key = "%s|%s" % (uid, time.strftime("%Y%m%d"))
    with _redfox_lock:
        return _redfox_used.get(key, 0)


def _redfox_quota_add(uid):
    key = "%s|%s" % (uid, time.strftime("%Y%m%d"))
    with _redfox_lock:
        _redfox_used[key] = _redfox_used.get(key, 0) + 1
        # 顺手清掉昨天的计数，避免进程长跑内存无限涨
        today = time.strftime("%Y%m%d")
        for k in [k for k in _redfox_used if not k.endswith("|" + today)]:
            _redfox_used.pop(k, None)


# ---------------------------------------------------------------- 云端调用小工具
def _cloud_headers(token):
    return {
        "x-wb-webapp-access-key": CLOUD_PUB_KEY,
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        # 🔴 2026-11-09 修 P0（写作工坊热点/榜单全线「登录凭证无法识别」）：
        #   云端对「没带 Origin 的客户端」判成 another client，kg_pay_ticket /
        #   kg_get_credits 一律 401 invalid_grant。会员站自己的浏览器请求天然带
        #   Origin，所以站内一切正常；只有服务端代调（redfox 网关扣分）漏了它。
        #   写作工坊侧早已补过（app/cloud_auth.py 同一处注释），这里补齐。
        "Origin": CLOUD_ENDPOINT,
        "Referer": CLOUD_ENDPOINT + "/",
    }


def _cloud_rpc(fn, payload, token, timeout=20):
    """调云端 RPC。返回 (data 或 None, err)。任何异常都不往外抛。

    🔴 2026-11-03 血泪：云端对无效/过期 token 返回的是
       HTTP 401 + {"error":"invalid_grant",...} —— **响应体里没有 ok 字段**。
    早期版本只判断 data["ok"] is False，结果 401 被当成"扣分成功"，
    伪造 JWT 就能白嫖。所以这里先把 4xx 显式翻译成 {ok:False}，再交给上层。
    """
    try:
        import requests
        r = requests.post(CLOUD_RPC + fn, json=payload,
                          headers=_cloud_headers(token), timeout=timeout)
        if r.status_code in (401, 403):
            return {"ok": False, "error": "not_signed_in",
                    "_http": r.status_code}, ""
        if r.status_code >= 400:
            return {"ok": False, "error": "rpc_error", "_http": r.status_code,
                    "message": (r.text or "")[:160]}, ""
        return r.json(), ""
    except Exception as e:  # noqa: BLE001
        return None, "%s: %s" % (type(e).__name__, str(e)[:120])


def _cloud_rpc_anon(fn, payload, timeout=15):
    """匿名调云端 RPC（票据本身就是凭证，不需要用户 token）。

    只用于 trial_consume_ticket 这类"验证一次性票据"的函数：
    票据是 48 位随机串，绑定 owner/cat/file，10 分钟过期且一次性。
    """
    try:
        import requests
        r = requests.post(CLOUD_RPC + fn, json=payload,
                          headers={"x-wb-webapp-access-key": CLOUD_PUB_KEY,
                                   "Content-Type": "application/json",
                                   # 同 _cloud_headers：无 Origin 会被云端判成另一个客户端
                                   "Origin": CLOUD_ENDPOINT,
                                   "Referer": CLOUD_ENDPOINT + "/"},
                          timeout=timeout)
        if r.status_code >= 400:
            return {"ok": False, "error": "rpc_error", "_http": r.status_code}
        return r.json()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "rpc_error", "message": str(e)[:120]}


def _jwt_uid(token):
    """从 JWT payload 取 sub（不验签）。

    不验签是**故意**的：这个 uid 只用于「每日额度计数」这种本地限流，
    真正的权限由云端 RPC 按同一个 token 判（伪造 token 会在 pay_ticket 被拒）。
    """
    try:
        p = token.split(".")[1]
        p += "=" * (-len(p) % 4)
        d = json.loads(base64.urlsafe_b64decode(p))
        return str(d.get("sub") or "").strip()
    except Exception:  # noqa: BLE001
        return ""


# ---------------------------------------------------------------- BYOK 保险箱（2026-11-26 / #62）
# 独立模块放 fetcher/，import 失败只让密钥接口不可用，绝不带崩站点。
# 会员站没有 KMS：主密钥由环境变量 WB_BYOK_MASTER_KEY 提供，本地 18999 用 dev 默认值。
_byok = {"ok": False, "mod": None, "err": ""}
try:
    import byok_vault as _bv  # noqa: E402
    _bv.CFG = {
        "db": CLOUD_DB,
        "cloud_headers": None,   # _cloud_headers 下面延迟绑定
    }
    _byok = {"ok": True, "mod": _bv, "err": ""}
except Exception as e:  # noqa: BLE001
    _byok["err"] = "%s: %s" % (type(e).__name__, e)


# 延迟绑定：两个函数都在上面定义完才补进配置
# （模块 import 发生在文件前部，那时 _cloud_headers / _jwt_uid 尚未定义）
if _hotspot["ok"]:
    _hotspot["mod"].CFG["jwt_uid"] = _jwt_uid
    _hotspot["mod"].CFG["cloud_headers"] = _cloud_headers
if _byok["ok"]:
    _byok["mod"].CFG["cloud_headers"] = _cloud_headers
if _webcore["ok"]:
    _webcore["mod"].CFG = {
        "byok": _byok["mod"] if _byok["ok"] else None,
        "cloud_headers": _cloud_headers,
    }
if _ww["ok"]:
    _ww["mod"].CFG = {"db": CLOUD_DB, "cloud_headers": _cloud_headers}


def _charge(token, action, points):
    """先扣分再调上游。返回 {ok, log_id, balance} 或 {ok:False, payload}。

    用 kg_pay_ticket 而不是 kg_consume_credit：前者**必定返回 log_id**，
    没这个 id 就没法在红狐失败时退分。签出来的票不用，浪费无害。
    """
    if points <= 0:
        return {"ok": True, "log_id": None, "balance": None, "free": True}
    data, err = _cloud_rpc("kg_pay_ticket", {
        "p_amount": int(points),
        "p_kind": "gen",                 # 🔴 不可自造 kind：票据签名含它
        "p_model": "redfox",
        "p_template": action,
        "p_prompt": ("redfox:" + action)[:200],
        "p_meta": {"src": "redfox_gateway", "action": action},
    }, token)
    if err:
        return {"ok": False, "payload": {
            "ok": False, "error": "billing_unavailable",
            "message": "计费服务暂时连不上（%s），这次不扣分、也没抓取" % err}}
    if not isinstance(data, dict):
        return {"ok": False, "payload": {
            "ok": False, "error": "billing_unavailable",
            "message": "计费服务返回异常，这次不扣分"}}
    # 🔴 只有明确拿到 ok=True 才算扣成功；缺字段 / 401 / 任何非 True 一律当失败
    if data.get("ok") is not True:
        e = data.get("error") or data.get("error_description") or ""
        if e == "not_signed_in" or str(e).startswith("invalid_grant"):
            return {"ok": False, "payload": {
                "ok": False, "error": "unauthorized",
                "message": "登录已失效，请重新登录（这次不扣分）"}}
        if e == "insufficient":
            return {"ok": False, "payload": {
                "ok": False, "error": "insufficient",
                "message": "积分不够：这次要 %s 分，你还有 %s 分（未扣分）"
                           % (data.get("need", points), data.get("balance", 0)),
                "balance": data.get("balance"), "need": data.get("need", points)}}
        return {"ok": False, "payload": {
            "ok": False, "error": "billing_error",
            "message": "扣分失败（%s），这次没扣分" % (e or "未知")}}
    return {"ok": True, "log_id": data.get("log_id"),
            "balance": data.get("balance")}


def _refund(token, log_id):
    """上游失败 → 全额退分，并回查真实余额。退不回去也不能影响主流程。"""
    if not log_id:
        return None
    _cloud_rpc("kg_refund_credit", {"p_log_id": log_id}, token)
    data, _err = _cloud_rpc("kg_get_credits", {}, token)
    if isinstance(data, dict) and isinstance(data.get("balance"), int):
        return data["balance"]
    return None
# 允许直接访问的顶层文件类型（防止源码、备份、临时文件被下载）
ALLOW_EXT = (".html", ".htm", ".css", ".js", ".json", ".png", ".jpg", ".jpeg",
             ".webp", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf",
             ".mp4", ".webm", ".txt", ".xml", ".pdf", ".zip")


def _is_local_host(handler):
    """请求是打到本机预览端口吗（Host 头判断）。"""
    h = (handler.headers.get("Host") or "").split(":")[0].strip().lower()
    return h in ("127.0.0.1", "localhost", "[::1]", "::1")


def _safe_path(path, local=False):
    """把请求路径转成磁盘路径，并判断是否允许对外。"""
    p = urllib.parse.unquote(path.split("?")[0].split("#")[0])
    if p in ("", "/"):
        p = "/index.html"
    parts = [x for x in p.strip("/").split("/") if x and x != "."]
    if any(x == ".." for x in parts):
        return None
    if parts and parts[0].lower() in DENY_DIRS:
        return None
    joined = "/".join(parts).lower() + "/"
    if any(joined.startswith(d) for d in DENY_PREFIX):
        return None
    # 2026-11-08：assets/downloads/ 下除 .html（在线阅读器 iframe 直接用）之外，
    # 所有 zip / pdf 一律不许静态直取，必须走 /api/dl 云端验票。
    # 补的是 life-guide/ 的 8.2MB PDF —— 它原先既在 DL_ALLOW_PREFIX 又没进 DENY_PREFIX，
    # 等于按钮换了票，直接敲 URL 却能匿名拿走。
    if joined.startswith("assets/downloads/") and not joined.rstrip("/").endswith(".html"):
        return None
    # 下划线 / 点开头的任何一段（_tmp_img、.git、.tmp-kb-bak 之类）一律不对外
    # 2026-11-01：原来只挡下划线，结果 .tmp-kb-bak/（批量改手册前的备份）被匿名 200 拿到旧正文。
    if any(x.startswith(("_", ".")) for x in parts):
        return None
    full = os.path.normpath(os.path.join(ROOT, *parts)) if parts else os.path.join(ROOT, "index.html")
    if not full.startswith(ROOT):
        return None
    if os.path.isdir(full):
        full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            return None
    low = full.lower()
    if low.endswith(DENY_EXT):
        return None
    base = os.path.basename(low)
    if base in DENY_NAMES:
        return None
    # 2026-11-08：部署是**增量同步、不删远端已有文件** —— 本地已经删掉的自检截图
    # （shot_*.png，15 张约 11MB）在线上依然返回 200，还能被匿名枚举。
    # 同理还有旧的《小程序迁移方案》（正文全是 5 分/张的旧价）。这类一次性产物
    # 本地删除对线上无效，只能在这里封。
    if base.startswith("shot_"):
        return None
    if base in DENY_NAMES_LOCAL_OK and not local:
        return None
    if not low.endswith(ALLOW_EXT):
        return None
    return full


class Handler(SimpleHTTPRequestHandler):
    server_version = "KBH/2.0"

    def __init__(self, *a, **kw):
        kw["directory"] = ROOT
        super().__init__(*a, **kw)

    # ---------------------------------------------------------------- 工具
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if getattr(self, "_head_only", False):
            return
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _html_denied(self):
        """无来源直开正文 → 给一页人话提示（403）。不吐任何正文内容，爬虫走不到这里。"""
        body = DENIED_PAGE.encode("utf-8")
        self.send_response(403)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.end_headers()
        if getattr(self, "_head_only", False):
            return
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 200_000:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return {}

    def _api_call(self, fn):
        try:
            out = fn()
        except Exception:
            sys.stderr.write("API ERROR\n" + traceback.format_exc())
            out = {"ok": False, "error": "server_error",
                   "message": "抓取服务出了点问题，先把正文粘进来，四层拆解照常出报告。"}
        self._json(out)

    def _do_aihot(self):
        """转发 AI HOT 三个公开只读接口。任一失败 → ok=False，前端自动退回静态快照。

        用标准库 urllib，不依赖第三方包；5 分钟内存缓存避免每次刷新都打上游。
        三个 URL 由模块级 AIHOT_PATHS 写死，前端无任何入参，因此不是开放代理。
        """
        import urllib.request
        now = time.time()
        if _aihot_cache["data"] and now - _aihot_cache["ts"] < 300:
            return _aihot_cache["data"]
        out = {"ok": True}
        for key, suffix in AIHOT_PATHS:
            req = urllib.request.Request(
                AIHOT_API + suffix,
                headers={"User-Agent": AIHOT_UA, "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=8) as r:
                if getattr(r, "status", 200) != 200:
                    raise RuntimeError("aihot %s -> HTTP %s" % (key, r.status))
                out[key] = json.loads(r.read(1_500_000).decode("utf-8"))
        _aihot_cache.update(ts=now, data=out)
        return out

    # ---------------------------------------------------------------- 路由
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        # Authorization 必须放行：写作工坊是跨域客户端，带 Bearer token 调 /api/redfox
        self.send_header("Access-Control-Allow-Headers",
                         "Content-Type, Authorization, x-user-token")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/api/health", "/health"):
            self._json({"ok": True, "service": "kbh-site",
                        "build": BUILD_ID,
                        "fetch": _fetch["ok"], "err": _fetch["err"][:200],
                        "redfox": bool(_redfox_key()),
                        "hotspot": _hotspot["ok"], "byok": _byok["ok"],
                        "webcore": _webcore["ok"], "webtypeset": _wts["ok"],
                        "webworks": _ww["ok"],
                        "origin_fix": True,
                        "ts": int(time.time())})
            return
        if path == "/api/aihot":
            self._api_call(self._do_aihot)
            return
        if path == "/api/fetch":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            url = (q.get("url") or [""])[0]
            ocr_flag = (q.get("ocr") or [""])[0] in ("1", "true", "yes")
            self._api_call(lambda: self._do_fetch(url, ocr_flag))
            return
        if path == "/api/img":
            # 两个名字都收：前端 imgProxy 生成的是 ?u=，手敲调试时更习惯写 ?url=
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._serve_image((q.get("u") or q.get("url") or [""])[0])
            return
        if path in ("/api/hotspot/sync/pull", "/api/hotspot/sync/state"):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            params = {k: (v[0] if v else "") for k, v in q.items()}
            self._api_call(lambda: self._do_hotspot(
                "state" if path.endswith("/state") else "pull", params, self))
            return
        # BYOK 列出 Key（GET；save/delete 走 POST）
        if path == "/api/byok/list":
            utok = (self.headers.get("x-user-token") or "").strip()
            auth = (self.headers.get("Authorization") or "").strip()
            tok = utok or (auth[7:].strip() if auth[:7].lower() == "bearer " else "")
            self._api_call(lambda: self._do_byok("list", {}, tok))
            return
        if path == "/api/dl":
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            self._serve_download((q.get("ticket") or [""])[0],
                                 (q.get("file") or [""])[0])
            return
        if path == "/api/ai-score":
            # 零 token 本地打分，GET 便于前端即时校验；正文走 query（限长在 handler 内）
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            text = (q.get("content") or [""])[0]
            self._api_call(lambda: self._do_webcore("ai-score", {"content": text}, ""))
            return
        self._serve_static()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path in ("/api/ai-score", "/api/detox"):
            b = self._body()
            utok = (self.headers.get("x-user-token") or "").strip()
            auth = (self.headers.get("Authorization") or "").strip()
            tok = utok or (auth[7:].strip() if auth[:7].lower() == "bearer " else "")
            action = "detox" if path == "/api/detox" else "ai-score"
            self._api_call(lambda: self._do_webcore(action, b, tok))
            return
        if path in ("/api/generate", "/api/outline", "/api/write", "/api/polish",
                    "/api/improve-title", "/api/improve-content", "/api/generate-titles",
                    "/api/rewrite-segment"):
            b = self._body()
            utok = (self.headers.get("x-user-token") or "").strip()
            auth = (self.headers.get("Authorization") or "").strip()
            tok = utok or (auth[7:].strip() if auth[:7].lower() == "bearer " else "")
            act_map = {"/api/generate": "write", "/api/outline": "outline",
                       "/api/write": "write", "/api/polish": "polish",
                       "/api/improve-title": "improve-title",
                       "/api/improve-content": "improve-content",
                       "/api/generate-titles": "generate-titles",
                       "/api/rewrite-segment": "rewrite-segment"}
            body_ws = dict(b or {})
            body_ws["act"] = act_map.get(path, "outline")
            self._api_call(lambda: self._do_webcore("write", body_ws, tok))
            return
        if path in ("/api/works/save", "/api/works/list", "/api/works/load"):
            b = self._body()
            utok = (self.headers.get("x-user-token") or "").strip()
            auth = (self.headers.get("Authorization") or "").strip()
            tok = utok or (auth[7:].strip() if auth[:7].lower() == "bearer " else "")
            act = path.rsplit("/", 1)[1]
            self._api_call(lambda: self._do_works(act, b, tok))
            return
        if path in ("/api/typeset/slots", "/api/typeset/componentize",
                    "/api/export/html", "/api/docx-text", "/api/preflight"):
            b = self._body()
            if path == "/api/typeset/slots":
                act = "slots"
            elif path in ("/api/export/html", "/api/docx-text"):
                act = "export-html"
            elif path == "/api/preflight":
                act = "preflight"
            else:
                act = "componentize"
            self._api_call(lambda: self._do_typeset(act, b))
            return
        if path == "/api/fetch":
            b = self._body()
            raw = b.get("url") or b.get("text") or ""
            self._api_call(lambda: self._do_fetch(raw, bool(b.get("ocr"))))
            return
        if path == "/api/ocr":
            b = self._body()
            self._api_call(lambda: self._do_ocr(b.get("urls") or []))
            return
        if path == "/api/redfox":
            b = self._body()
            # 🔴 2026-11-09 修 P0（线上「登录凭证无法识别」）：
            #   线上前面有 CloudStudio Gateway，它会把 Authorization 头**整个替换**成
            #   平台自己的 token（claims 是 region/space/token/user_id，**没有 sub**），
            #   于是我们拿到的不是用户 token，_jwt_uid 取不到 sub 就报「凭证无法识别」。
            #   实测同一个 token：本地直连 18999 正常，走线上域名就被换掉 —— 网关行为。
            #   x-user-token 这个自定义头验证过**能原样透传**（sub 完整），
            #   所以改为优先读它，Authorization 仅为本地直连/兼容保留。
            utok = (self.headers.get("x-user-token") or "").strip()
            auth = (self.headers.get("Authorization") or "").strip()
            tok = utok or (auth[7:].strip() if auth[:7].lower() == "bearer " else "")
            self._api_call(lambda: self._do_redfox(
                b.get("action") or "",
                b.get("params") or {},
                b.get("tier") or "member",
                tok,
                b.get("checkup_session") or None,
                b.get("checkup_tier") or None))
            return
        if path == "/api/libzip":
            # 返回二进制 zip，不走 _api_call（那个会把结果 json 化）
            b = self._body()
            self._do_libzip(b.get("markdown") or "", b.get("covers") or [])
            return
        if path == "/api/hotspot/sync/publish":
            b = self._body()
            utok = (self.headers.get("x-user-token") or "").strip()
            auth = (self.headers.get("Authorization") or "").strip()
            tok = utok or (auth[7:].strip() if auth[:7].lower() == "bearer " else "")
            self._api_call(lambda: self._do_hotspot("publish", b, self, tok))
            return
        # ------------------------------------------------ 网页端登录（2026-11-27）
        # 自有域名（知识不惑.cn）下浏览器直连云端 signin 会被 Origin 白名单拒：
        #   403 {"error":"access_denied","error_description":"the request origin is not allowed for this client"}
        # 必须由服务端代发 —— 实测服务端请求（不带 Origin 或带会员站 Origin）能过校验。
        if path == "/api/auth/signin":
            b = self._body()
            self._api_call(lambda: self._do_signin(
                (b.get("username") or b.get("email") or "").strip(),
                b.get("password") or ""))
            return
        if path == "/api/auth/whoami":
            utok = (self.headers.get("x-user-token") or "").strip()
            self._api_call(lambda: self._do_whoami(utok))
            return
        # ------------------------------------------------ BYOK 密钥保险箱（#62）
        if path.startswith("/api/byok/"):
            action = path[len("/api/byok/"):]
            b = self._body()
            utok = (self.headers.get("x-user-token") or "").strip()
            auth = (self.headers.get("Authorization") or "").strip()
            tok = utok or (auth[7:].strip() if auth[:7].lower() == "bearer " else "")
            self._api_call(lambda: self._do_byok(action, b, tok))
            return
        if path.startswith("/api/"):
            self._json({"ok": False, "error": "not_found"}, 404)
            return
        self.send_response(405)
        self.send_header("Allow", "GET, HEAD, OPTIONS")
        self.end_headers()

    # ------------------------------------------------ 网页端登录（2026-11-27）
    def _do_signin(self, username, password):
        """账密登录，服务端代发到云端 signin，返回 access_token。

        为什么不让浏览器直连：云端按 Origin 白名单校验客户端，自有域名必然 403。
        为什么不用 /.cloud/auth/v1/token?grant_type=password：那条路存在，但
        password 授权返回 invalid_grant，白撞（cloud-sdk 的 signInWithPassword
        走的也是 signin，见写作工坊 tools/热点同步/sync_now.py 同处注释）。

        安全：只透传 token，不落盘、不写日志、不记密码。
        """
        if not username or not password:
            return {"ok": False, "error": "empty", "message": "账号和密码都要填"}
        payload = json.dumps({"username": username, "password": password}).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "x-wb-webapp-access-key": CLOUD_PUB_KEY,
            # 与 _cloud_headers 一致：云端把「完全没带 Origin」的客户端也当 another client
            "Origin": CLOUD_ENDPOINT,
            "Referer": CLOUD_ENDPOINT + "/",
        }
        url = CLOUD_ENDPOINT + "/.cloud/auth/v1/signin"
        import urllib.request
        import urllib.error
        try:
            req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=25) as r:
                raw = r.read(200_000).decode("utf-8", "replace")
            obj = json.loads(raw or "{}")
        except urllib.error.HTTPError as e:
            raw = e.read(200_000).decode("utf-8", "replace")
            try:
                obj = json.loads(raw or "{}")
            except Exception:  # noqa: BLE001
                obj = {"error": raw[:200]}
            code = str(obj.get("code") or obj.get("error_code") or "").upper()
            desc = str(obj.get("error_description") or obj.get("error") or "")
            if "INVALID_USERNAME" in code or "invalid_username" in desc:
                return {"ok": False, "error": "bad_credentials", "message": "账号或密码不对"}
            if "origin" in desc.lower():
                return {"ok": False, "error": "origin_blocked",
                        "message": "云端拒绝了本站来源，需要把本站域名加进会员站白名单"}
            return {"ok": False, "error": "upstream",
                    "message": (desc or code or ("HTTP %s" % e.code))[:160]}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "network",
                    "message": "连不上云端（%s），稍后再试" % type(e).__name__}
        tok = _pick_access_token(obj)
        if not tok:
            return {"ok": False, "error": "no_token",
                    "message": "云端没返回登录凭证，稍后再试"}
        return {"ok": True, "token": tok, "exp": _jwt_exp(tok), "username": username}

    def _do_whoami(self, token):
        """用 token 换云端身份，用于验证登录态是否还有效（不扣分、不占额度）。"""
        if not token:
            return {"ok": False, "error": "not_signed_in"}
        import urllib.request
        import urllib.error
        try:
            req = urllib.request.Request(
                CLOUD_ENDPOINT + "/.cloud/auth/v1/user",
                headers=_cloud_headers(token), method="GET")
            with urllib.request.urlopen(req, timeout=15) as r:
                return {"ok": True, "user": json.loads(r.read(200_000).decode("utf-8", "replace") or "{}")}
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                return {"ok": False, "error": "not_signed_in", "_http": e.code}
            return {"ok": False, "error": "upstream", "_http": e.code}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "network", "message": "%s: %s" % (type(e).__name__, e)}

    def _do_hotspot(self, action, params, handler, token=None):
        """热点同步三动作：publish / pull / state。

        错误一律返回 body 里的 {ok:false,error,http}，不抛给 _api_call
        （否则会被翻译成"抓取服务"的误导文案）。
        🔴 身份：线上只读 x-user-token（Authorization 会被网关换掉），本地兼容 Bearer。
        """
        if not _hotspot["ok"]:
            return {"ok": False, "error": "NOT_READY", "http": 503,
                    "message": _hotspot["err"][:160]}
        hs = _hotspot["mod"]
        tok = token if token is not None else (
            (handler.headers.get("x-user-token") or "").strip()
            or (handler.headers.get("Authorization") or "")[7:].strip())
        try:
            if action == "publish":
                data, _err = hs.publish(params, tok)
                out = {"ok": True}
                out.update(data or {})
                return out
            if action == "pull":
                data, _err = hs.pull(params, tok)
                return {"ok": True, **data}
            if action == "state":
                data, _err = hs.state(tok)
                return {"ok": True, **data}
            return {"ok": False, "error": "BAD_ACTION", "http": 400}
        except hs.SyncError as e:
            return {"ok": False, "error": e.code, "http": e.http,
                    "message": str(e)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "SERVER_ERROR", "http": 500,
                    "message": "%s: %s" % (type(e).__name__, str(e)[:160])}

    def _do_byok(self, action, body, token):
        """BYOK 保险箱：list / save / delete。

        🔴 明文 Key 只进 AES-256-GCM 加密后落库；这里所有回前端的字段
           都是 key_tail + sk-**** 脱敏，绝不回传 ciphertext 或明文。
           reveal() 仅供服务端代调用内部使用，不走这个 HTTP 入口。
        """
        if not _byok["ok"]:
            return {"ok": False, "error": "NOT_READY", "http": 503,
                    "message": "密钥保险箱组件未加载：" + _byok["err"][:160]}
        bv = _byok["mod"]
        uid = _jwt_uid(token)
        if not uid:
            return {"ok": False, "error": "NOT_SIGNED_IN", "http": 401,
                    "message": "请先登录会员账号，再管理自己的 Key"}
        try:
            if action == "list":
                data, _err = bv.list_keys(token, uid)
                return {"ok": True, **data}
            if action == "save":
                slot = str(body.get("slot") or "")
                key = str(body.get("key") or "").strip()
                if not key:
                    return {"ok": False, "error": "BAD_KEY", "http": 400,
                            "message": "Key 不能为空"}
                data, _err = bv.save(
                    token, uid, slot, key,
                    name=str(body.get("name") or ""),
                    base_url=str(body.get("base_url") or ""),
                    model=str(body.get("model") or ""))
                return {"ok": True, **data}
            if action == "delete":
                data, _err = bv.delete(token, uid, str(body.get("slot") or ""))
                return {"ok": True, **data}
            return {"ok": False, "error": "BAD_ACTION", "http": 400,
                    "message": "未知的保险箱操作：" + str(action)[:40]}
        except bv.VaultError as e:
            return {"ok": False, "error": e.code, "http": e.http,
                    "message": str(e)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "SERVER_ERROR", "http": 500,
                    "message": "%s: %s" % (type(e).__name__, str(e)[:160])}

    def _do_webcore(self, action, body, token):
        """写作工坊网页端业务：ai_score（零 token）/ detox（BYOK 代调用，锁 cloud_llm）。

        身份走 x-user-token → _jwt_uid；BYOK writing Key 由 webcore 内部 reveal，
        明文绝不出网到前端。所有异常收敛成 {ok:false,error,...}。
        """
        if not _webcore["ok"]:
            return {"ok": False, "error": "NOT_READY", "http": 503,
                    "message": "写作工坊核心未加载：" + _webcore["err"][:160]}
        wc = _webcore["mod"]
        if action == "ai-score":
            text = str((body or {}).get("content") or "")
            if not text.strip():
                return {"ok": False, "error": "EMPTY", "message": "正文不能为空"}
            if len(text) > wc.MAX_LEN:
                return {"ok": False, "error": "TOO_LONG", "message": "正文超过上限"}
            return {"ok": True, **wc.score(text)}
        if action == "write":
            uid = _jwt_uid(token)
            if not uid:
                return {"ok": False, "error": "NOT_SIGNED_IN", "http": 401,
                        "message": "请先登录会员账号，再去保险箱配置写作 Key"}
            b = body or {}
            try:
                out = wc.gen_longform(
                    token, uid,
                    str(b.get("act") or "outline").strip().lower(),
                    title=str(b.get("title") or b.get("content") or ""),
                    ctx=str(b.get("context") or b.get("prompt") or b.get("instructions") or ""),
                    n=b.get("n") or b.get("word_count") or 0)
                return {"ok": True, **out}
            except wc.WebError as e:
                return {"ok": False, "error": e.code, "http": e.http, "message": e.message}
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "error": "SERVER_ERROR", "http": 500,
                        "message": "%s: %s" % (type(e).__name__, str(e)[:160])}
        if action == "detox":
            uid = _jwt_uid(token)
            if not uid:
                return {"ok": False, "error": "NOT_SIGNED_IN", "http": 401,
                        "message": "请先登录会员账号，再去保险箱配置写作 Key"}
            text = str((body or {}).get("content") or "")
            mode = str((body or {}).get("mode") or "deep").strip().lower()
            if mode not in ("deep", "proof"):
                mode = "deep"
            try:
                out = wc.detox_once(token, uid, text, mode=mode)
                # AIGC 双标识：显式角标 + 隐式零宽元数据
                marked = wc.aigc_mark(out["content"], model="byok-writing")
                out["content"] = marked["content"]
                out["aigc"] = marked["meta"]
                out["aigc_label"] = marked["label"]
                return {"ok": True, **out}
            except wc.WebError as e:
                return {"ok": False, "error": e.code, "http": e.http, "message": e.message}
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "error": "SERVER_ERROR", "http": 500,
                        "message": "%s: %s" % (type(e).__name__, str(e)[:160])}
        return {"ok": False, "error": "BAD_ACTION", "message": "未知操作"}

    def _do_typeset(self, action, body):
        """排版导出：slots / export-html / preflight（纯逻辑，零 token）。"""
        if not _wts["ok"]:
            return {"ok": False, "error": "NOT_READY", "http": 503,
                    "message": "排版核心未加载：" + _wts["err"][:160]}
        wt = _wts["mod"]
        b = body or {}
        try:
            if action == "slots":
                return {"ok": True, **wt.slots_summary(b.get("content") or "")}
            if action == "export-html":
                return wt.export_html(
                    b.get("content") or "",
                    template=str(b.get("template") or ""),
                    theme=str(b.get("theme") or ""),
                    byline=str(b.get("byline") or ""),
                    cover_src=str(b.get("cover_src") or ""),
                    footer_cta=bool(b.get("footer_cta")),
                    ip=b.get("ip"), publish=bool(b.get("publish")),
                    content_type=str(b.get("content_type") or "article"),
                    spots=b.get("image_spots") or b.get("spots"))
            if action == "preflight":
                return wt.preflight(b.get("content") or "", b.get("html") or "",
                                    str(b.get("track") or ""))
            return {"ok": False, "error": "BAD_ACTION", "message": "未知排版操作"}
        except wt.TypeError_ as e:
            return {"ok": False, "error": e.code, "message": e.message}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "SERVER_ERROR", "http": 500,
                    "message": "%s: %s" % (type(e).__name__, str(e)[:160])}

    def _do_works(self, action, body, token):
        """作品云端：save / list / load，按 uid 隔离（web_work 表 RLS）。"""
        if not _ww["ok"]:
            return {"ok": False, "error": "NOT_READY", "http": 503,
                    "message": "作品库未加载：" + _ww["err"][:160]}
        ww = _ww["mod"]
        uid = _jwt_uid(token)
        if not uid:
            return {"ok": False, "error": "NOT_SIGNED_IN", "http": 401,
                    "message": "请先登录会员账号"}
        b = body or {}
        try:
            if action == "save":
                return {"ok": True, **ww.save(token, uid, b)}
            if action == "list":
                return {"ok": True, **ww.list_works(token, uid, b.get("limit") or 100)}
            if action == "load":
                return {"ok": True, **ww.load_work(token, uid, b.get("work_id") or "")}
            return {"ok": False, "error": "BAD_ACTION", "message": "未知作品操作"}
        except ww.WorkError as e:
            return {"ok": False, "error": e.code, "http": e.http, "message": e.message}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "SERVER_ERROR", "http": 500,
                    "message": "%s: %s" % (type(e).__name__, str(e)[:160])}

    # ---------------------------------------------------------------- 业务
    def _do_fetch(self, raw, do_ocr):
        if not _fetch["ok"]:
            return {"ok": False, "error": "fetcher_unavailable",
                    "message": "抓取组件没加载起来。" + _fetch["err"][:120]
                               + " 这一步先把正文粘进来，四层拆解照常出报告。"}
        if not (raw or "").strip():
            return {"ok": False, "error": "no_url", "message": "没收到链接。"}
        t0 = time.time()
        out = _fetch["mod"].fetch_any(raw, do_ocr)
        out["elapsed"] = round(time.time() - t0, 1)
        return out

    def _do_ocr(self, urls):
        if not isinstance(urls, list):
            return {"ok": False, "error": "bad_urls"}
        urls = [u for u in urls if isinstance(u, str) and u.startswith("http")][:10]
        if not urls:
            return {"ok": False, "error": "no_urls"}
        if not _fetch["ok"]:
            return {"ok": False, "error": "fetcher_unavailable",
                    "message": "OCR 组件没加载起来，封面文字手抄一句即可。"}
        ocr = getattr(_fetch["mod"], "ocr_mod", None)
        if ocr is None or not ocr.available():
            return {"ok": False, "error": "ocr_unavailable",
                    "message": "服务端没装 OCR 组件，这步用不了，手抄关键句即可。"}
        items = []
        for u in urls:
            lines, err = ocr.ocr_url(u)
            items.append({"url": u, "text": ocr.join_lines(lines)[:800], "err": err})
        return {"ok": True, "items": items}

    # ---------------------------------------------------------------- 图片代理
    # ---------------------------------------------------------------- 红狐网关
    def _do_redfox(self, action, params, tier="member", token="", session=None, session_tier=None):
        """把前端的一个「功能动作」翻译成红狐的真实 path 并转发。

        五条设计红线（每条都是踩过或会踩的坑）：
          1. 只认白名单里的 action，绝不接受前端传任意 path —— 否则本站就是开放代理；
          2. path 里带 {suffix} 的必须由平台名替换（文档列表页是截断版，照抄全 404）；
          3. 🔴 **必须带用户 token 才给数据**。旧版只看 IP 额度、不验身份，
             任何脚本 curl 一下就能白嫖站长付钱的红狐余额；
          4. 🔴 **先扣分、再调上游**。反过来的话并发 10 个请求能刷成负余额；
          5. code != 2000 一律 ok=False，并**自动退分**（红狐失败不计费，站内扣了必须退）。
        """
        act = REDFOX_ACTIONS.get(action)
        if not act:
            return {"ok": False, "error": "bad_action",
                    "message": "未知动作：%s" % action}
        method, path = act
        body = dict(params or {})
        if "{suffix}" in path:
            plat = body.pop("platform", "") or ""
            sfx = REDFOX_SUFFIX.get(plat)
            if not sfx:
                return {"ok": False, "error": "bad_platform",
                        "message": "这个平台暂不支持该动作"}
            path = path.replace("{suffix}", sfx)
        else:
            # platform 在多数动作里只是前端用来选路径后缀的提示，不该进请求体；
            # 但 hot_platform 的 platform 本身就是接口必填参数（1 快手 2 抖音 5 微博
            # 6 小红书 7 百度 8 B站），这里误删过一次，导致热榜恒报「接口执行异常」。
            if action not in REDFOX_KEEP_PLATFORM:
                body.pop("platform", None)

        # ① 鉴权：没有 token 一律不给数据（这一条是本次 P0 的核心修复）
        token = (token or "").strip()
        if not token:
            return {"ok": False, "error": "unauthorized",
                    "message": "情报功能要登录才能用。去「会员服务」登录后再来（这次不扣分）"}
        uid = _jwt_uid(token)
        if not uid:
            return {"ok": False, "error": "unauthorized",
                    "message": "登录凭证无法识别，请重新登录（这次不扣分）"}

        key = _redfox_key()
        if not key:
            return {"ok": False, "error": "no_key",
                    "message": "情报服务还没接通（服务端缺 REDFOX_API_KEY 环境变量），这次不扣分"}

        # ② 每日额度：按 uid 计（不按 IP），额度用完不扣分
        limit = REDFOX_QUOTA.get("vip" if tier == "vip" else "member", 20)
        used = _redfox_quota_used(uid)
        if used >= limit:
            return {"ok": False, "error": "quota",
                    "message": "今天的额度用完了（%d/%d），明天再来。额度是防脚本刷爆红狐余额的硬闸，不是限制你。" % (used, limit),
                    "used": used, "limit": limit}

        # ③ 先扣分（服务端定价，前端说了不算）
        # 账号体检走 session 聚合：整次只扣一次（完整 20 / 轻量 10），后续子调用 0 分
        is_first = False
        if session:
            is_first = _checkup_first(session)
            points = (10 if session_tier == 'lite' else 20) if is_first else 0
        else:
            points = REDFOX_POINTS.get(action, REDFOX_POINTS_DEFAULT)
        charged = _charge(token, action, points)
        if not charged.get("ok"):
            return charged["payload"]
        log_id = charged.get("log_id")
        balance = charged.get("balance")

        # ④ 调红狐
        body = {k: v for k, v in body.items() if v not in (None, "")}
        url = REDFOX_API + path
        headers = {"REDFOX_API_KEY": key}
        try:
            import requests
            if method == "GET":
                r = requests.get(url, params=body, headers=headers, timeout=30)
            else:
                r = requests.post(url, json=body, headers=headers, timeout=30)
            data = r.json()
        except Exception as e:
            left = _refund(token, log_id)
            return {"ok": False, "error": "upstream",
                    "message": "红狐没响应（%s），%s" % (
                        type(e).__name__,
                        "本次 %s 分已退回" % points if log_id else "这次不扣分"),
                    "billing": {"charged": 0, "refunded": bool(log_id),
                                "balance": left if left is not None else balance}}

        code = data.get("code")
        if code != 2000:
            left = _refund(token, log_id)
            return {"ok": False, "error": "upstream", "code": code,
                    "message": "%s（%s）" % (
                        data.get("msg") or data.get("message") or "红狐返回了错误",
                        "本次 %s 分已退回" % points if log_id else "这次不扣分"),
                    "billing": {"charged": 0, "refunded": bool(log_id),
                                "balance": left if left is not None else balance}}

        if action not in REDFOX_NO_QUOTA and not (session and not is_first):
            _redfox_quota_add(uid)
        return {"ok": True, "code": code, "data": data.get("data"),
                "billing": {
                    "charged": points,
                    "balance": balance,
                    "log_id": log_id,
                    "quota": {"used": _redfox_quota_used(uid), "limit": limit},
                }}

    @staticmethod
    def _img_allowed(url):
        """只看 host，且必须精确匹配白名单或为其子域名。"""
        try:
            h = (urllib.parse.urlparse(url).hostname or "").lower()
        except Exception:
            return False
        if not h:
            return False
        return any(h == d or h.endswith("." + d) for d in IMG_HOSTS)

    # ---------------------------------------------------------------- 素材库打包
    MAX_ZIP_COVERS = 60
    MAX_COVER_BYTES = 8 * 1024 * 1024

    def _do_libzip(self, markdown, covers):
        """
        把「素材库导出」打成一个 zip：README.md + covers/NN.jpg。

        为什么放服务端：
          1. 封面图在平台 CDN 上，前端 fetch 会被 Referer 防盗链 403（和 /api/img 同一个坑）；
          2. 站内没有打包库，又不允许引 CDN，用标准库 zipfile 比自己写 store-only 稳；
          3. 顺手用 PIL 统一转 JPEG 压到 1200px，几百张封面打包也只有几 MB，
             Obsidian 打开不用等。

        安全：封面 URL 必须过 IMG_HOSTS 白名单（复用 _img_allowed），重定向逐跳校验，
        防 SSRF；单张 ≤8MB、最多 60 张；任何一张失败都不影响整体导出。
        """
        try:
            import io
            import zipfile
        except Exception:
            self._json({"ok": False, "error": "no_deps"}, 500)
            return

        md = (markdown or "")[:400000]
        urls = []
        if isinstance(covers, list):
            for c in covers[:self.MAX_ZIP_COVERS]:
                if isinstance(c, dict):
                    urls.append(str(c.get("url") or "").strip())
                elif isinstance(c, str):
                    urls.append(c.strip())

        buf = io.BytesIO()
        got, missed = 0, []
        try:
            # 先抓图再写 md：只有真拿到图的才在 md 里留引用。
            # 原来是无条件写引用、抓图失败留空位，导出的 md 里就有断链，
            # 在 Obsidian 里显示成一片破图标记 —— 比缺张图更让人以为文件坏了。
            imgs = {}
            for i, url in enumerate(urls, 1):
                data = self._zip_image(url) if url else None
                if data:
                    imgs[i] = data
                    got += 1
                else:
                    missed.append(i)

            import re as _re
            cover_ref = _re.compile(r'(?:\./)?covers/(\d+)\.(?:jpg|jpeg|png)', _re.I)

            def _keep(line):
                m = cover_ref.search(line)
                return True if not m else int(m.group(1)) in imgs

            kept = [ln for ln in md.split("\n") if _keep(ln)]
            md_out = _re.sub(r'\n{3,}', '\n\n', "\n".join(kept)).strip() + "\n"

            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                z.writestr("README.md", md_out)
                for i in sorted(imgs):
                    z.writestr("covers/%02d.jpg" % i, imgs[i])
                note = ["素材库导出", "",
                        "正文与链接见 README.md。",
                        "封面图在 covers/ 目录，编号 = 素材序号（01.jpg 对应第 1 条）。",
                        "md 里的封面引用写成 ./covers/NN.jpg 相对路径，解压后保持目录结构就能直接显示。", "",
                        "封面 %d 张成功，%d 张没拿到。" % (got, len(missed))]
                if missed:
                    note.append("没拿到的序号：%s" % "、".join(str(x) for x in missed))
                    note.append("原因通常是平台 CDN 防盗链、图片已删除，或该条本来就没有封面。")
                    note.append("这些条目的封面引用已从 README.md 里去掉，原图链接仍在，点开能看。")
                z.writestr("说明.txt", "\n".join(note) + "\n")
        except Exception:
            sys.stderr.write("LIBZIP ERROR\n" + traceback.format_exc())
            self._json({"ok": False, "error": "zip_failed",
                        "message": "打包失败，先导出 Markdown 也能用。"}, 500)
            return

        data = buf.getvalue()
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(len(data)))
        # 文件名用 ASCII：中文名要走 RFC5987 编码，浏览器兼容性参差。
        # 真正的下载名由前端 a.download 决定，这里只兜底。
        self.send_header("Content-Disposition", 'attachment; filename="library.zip"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if getattr(self, "_head_only", False):
            return
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _zip_image(self, url):
        """
        按白名单抓一张封面并统一转成 JPEG（≤1200px，质量 88）。
        拿不到返回 None —— 宁可缺一张图，也不能让整个导出失败。
        """
        if not url or not self._img_allowed(url):
            return None
        try:
            import io
            import requests
            UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
            cur = url
            headers = {"User-Agent": UA}
            raw = None
            for _ in range(4):                      # 最多跟 3 跳，和 _serve_image 一致
                if "xhscdn" in cur or "xiaohongshu" in cur:
                    headers["Referer"] = "https://www.xiaohongshu.com/"
                elif "qpic.cn" in cur or "qlogo.cn" in cur:
                    headers["Referer"] = "https://mp.weixin.qq.com/"
                elif "douyinpic" in cur or "byteimg" in cur or "snssdk" in cur:
                    headers["Referer"] = "https://www.douyin.com/"
                r = requests.get(cur, timeout=12, headers=headers, allow_redirects=False)
                if r.status_code in (301, 302, 303, 307, 308):
                    nxt = urllib.parse.urljoin(cur, r.headers.get("Location") or "")
                    if not self._img_allowed(nxt):
                        return None
                    cur = nxt
                    continue
                if r.status_code != 200:
                    return None
                if not r.content or len(r.content) > self.MAX_COVER_BYTES:
                    return None
                raw = r.content
                break
            if not raw:
                return None
            try:
                from PIL import Image
                im = Image.open(io.BytesIO(raw))
                im = im.convert("RGB")
                im.thumbnail((1200, 1200), Image.LANCZOS)
                out = io.BytesIO()
                im.save(out, "JPEG", quality=88, optimize=True)
                return out.getvalue()
            except Exception:
                # PIL 转不动就原样塞进去，扩展名仍按 .jpg —— 浏览器能容错
                return raw
        except Exception:
            return None

    def _serve_image(self, url):
        """
        把平台 CDN 的图片原样吐给前端，由服务端带正确的 Referer。

        重定向逐跳校验而不是交给 requests 自动跟随 —— 自动跟随可能先跳到
        内网地址再跳回来，白名单就形同虚设了（SSRF 经典绕过）。
        """
        if not self._img_allowed(url):
            self.send_error(403, "image host not allowed")
            return

        UA_BROWSER = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
        MAX_BYTES = 8 * 1024 * 1024

        try:
            import requests
            cur = url
            headers = {"User-Agent": UA_BROWSER}
            for _ in range(4):                      # 最多跟 3 跳
                if "xhscdn" in cur or "xiaohongshu" in cur:
                    headers["Referer"] = "https://www.xiaohongshu.com/"
                elif "qpic.cn" in cur or "qlogo.cn" in cur:
                    headers["Referer"] = "https://mp.weixin.qq.com/"
                r = requests.get(cur, timeout=20, headers=headers,
                                 allow_redirects=False)
                if r.status_code in (301, 302, 303, 307, 308):
                    nxt = r.headers.get("Location") or ""
                    if not nxt:
                        self.send_error(502, "bad redirect")
                        return
                    cur = urllib.parse.urljoin(cur, nxt)
                    if not self._img_allowed(cur):  # 跳出站外/内网直接拒
                        self.send_error(403, "redirect host not allowed")
                        return
                    continue
                if r.status_code != 200:
                    self.send_error(502, "upstream %s" % r.status_code)
                    return
                data = r.content
                if not data or len(data) > MAX_BYTES:
                    self.send_error(502, "image too large")
                    return
                ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip()
                if not ctype.startswith("image/"):
                    ctype = "image/jpeg"        # CDN 偶尔不吐类型，兜底
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=3600")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                try:
                    self.wfile.write(data)
                except Exception:
                    pass
                return
            self.send_error(502, "too many redirects")
        except Exception:
            sys.stderr.write("IMG PROXY ERROR\n" + traceback.format_exc())
            try:
                self.send_error(502, "image proxy failed")
            except Exception:
                pass

    # ---------------------------------------------------------------- 验票下载
    def _serve_download(self, ticket, file_rel):
        """站内下载物：必须持云端签发的一次性票据。

        链路：前端点下载 → 云端 trial_authorize(cat, file) 判身份/锁大类/扣名额
        → 返回 ticket → 请求 /api/dl?ticket=&file= → 这里匿名验票 → 才吐文件。
        静态直取 skills/ free/ 已被 DENY_PREFIX 挡死，票据 10 分钟过期且一次性，
        转发链接给别人也会因 used=true 被拒。
        """
        if not ticket or not file_rel:
            self._json({"ok": False, "error": "missing_params"}, 400)
            return
        rel = urllib.parse.unquote(file_rel).lstrip("/")
        rel_low = rel.lower()
        parts = [x for x in rel.split("/") if x]
        if (not parts or any(x in ("..", ".") for x in parts)
                or not any(rel_low.startswith(p) for p in DL_ALLOW_PREFIX)):
            self._json({"ok": False, "error": "forbidden_path"}, 403)
            return
        full = os.path.normpath(os.path.join(ROOT, *parts))
        if not full.startswith(ROOT) or not os.path.isfile(full):
            self._json({"ok": False, "error": "not_found"}, 404)
            return
        # p_file 必须与签票时传入的值逐字节一致（trial_authorize 存的也是这个）
        verdict = _cloud_rpc_anon(
            "trial_consume_ticket", {"p_ticket": ticket, "p_file": rel})
        if not (verdict and verdict.get("ok")):
            self._json({"ok": False,
                        "error": (verdict or {}).get("error") or "ticket_rejected"}, 403)
            return
        try:
            size = os.path.getsize(full)
            ctype = self.guess_type(full) or "application/octet-stream"
            fname = urllib.parse.quote(os.path.basename(full))
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition",
                             "attachment; filename*=UTF-8''" + fname)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if getattr(self, "_head_only", False):
                return
            with open(full, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            sys.stderr.write("DL ERROR\n" + traceback.format_exc())

    # ---------------------------------------------------------------- 静态
    def _serve_static(self):
        ip, trusted = _client_ip(self)
        path_only = urllib.parse.unquote(self.path.split("?")[0]).lower()

        # 0) 蜜罐：正常页面从不链这些路径，跟进去的只可能是爬虫 → 直接封。
        #    先判它，因为蜜罐指向的文件本来就不存在。
        if path_only in HONEYPOT_PATHS:
            _ban(ip, trusted, "honeypot " + path_only[:60])
            self._json({"ok": False, "error": "not_found"}, 404)
            return
        if _is_banned(ip, trusted):
            self._json({"ok": False, "error": "not_found"}, 404)
            return

        full = _safe_path(self.path, local=_is_local_host(self))
        if not full or not os.path.isfile(full):
            self._json({"ok": False, "error": "not_found", "path": self.path[:80]}, 404)
            return

        # 1) 正文 / PDF / zip / 白皮书片段：挡脚本直取，正常站内点开无感。
        #    2026-10-29 只有 wp-doc.html 一处校验；2026-11-01 扩到 articles/、kb/*.html、
        #    assets/pdf/、*.zip —— 体检实测这些能匿名直取（9044 字正文、7.7MB PDF）。
        #    注意口径：**只拦住批量抓取，不做严格会员门禁**，所以要放行带本站 Referer 的请求。
        if _is_sensitive(full):
            ua = self.headers.get("User-Agent") or ""
            if _ua_is_spider(ua):
                _ban(ip, trusted, "ua " + ua[:48])
                self._json({"ok": False, "error": "not_found"}, 404)
                return
            if not _referer_same_site(self):
                # 无来源直开：正常浏览器给一页「请从会员站进入」，脚本/curl 仍旧伪装 404。
                if _ua_is_browser(ua):
                    self._html_denied()
                else:
                    # 伪装成"文件不存在"，不告诉对方这里有什么
                    self._json({"ok": False, "error": "not_found"}, 404)
                return
            if not _rate_check(ip, trusted, os.path.getsize(full)):
                self._json({"ok": False, "error": "not_found"}, 404)
                return

        try:
            size = os.path.getsize(full)
            ctype = self.guess_type(full)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            low = full.lower()
            if low.endswith((".html", ".htm")):
                self.send_header("Cache-Control", "no-cache")
            elif "?v=" in self.path:
                self.send_header("Cache-Control", "public, max-age=31536000")
            else:
                self.send_header("Cache-Control", "public, max-age=300")
            self.end_headers()
            if getattr(self, "_head_only", False):
                return                       # HEAD 只要头，写 body 会让下游 500
            with open(full, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            sys.stderr.write("STATIC ERROR %s\n" % self.path[:80] + traceback.format_exc())

    def do_HEAD(self):
        # 2026-11-01：原来直接复用 do_GET 会连 body 一起写，HEAD 对端不读 ->
        # 触发 BrokenPipe/500，线上批量 HEAD 体检时一堆假故障。改成只发头。
        self._head_only = True
        self.do_GET()

    def log_message(self, fmt, *args):
        try:
            sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))
        except Exception:
            pass


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    sys.stderr.write("kbh site listening on %d (fetch=%s)\n" % (PORT, _fetch["ok"]))
    srv.serve_forever()


if __name__ == "__main__":
    main()
