/* ============================================================
 * 万物写作工坊 · 网页端适配层 (adapter.js)
 * ------------------------------------------------------------
 * 作用：让桌面端完整前端 (index.html) 在浏览器 + 会员站后端上直接跑。
 * 原则：只做「浏览器化」适配，不改任何业务 JS。
 *   1) 登录态：引入会员站 cloud-sdk，把 accessToken 注入 x-user-token
 *   2) 门禁：网页端不做本机激活，模拟已授权，跳过首启引导遮罩
 *   3) 菜单裁剪：隐藏本机绑定 / 漫画模块（胜元 2026-11-26 拍板）
 *   4) 端点兜底：后端未实现的端点返回友好空数据，避免首屏满屏报错
 *   5) 皮肤：默认酸绿浅色
 * 后续每补一个真端点，就从 STUB_SET 里删掉对应项即可。
 * ============================================================ */
(function () {
  "use strict";

  // ---------- 1) 登录态（复用会员站同 appId 的 SDK）----------
  // SDK / config.js 在 <head> 里同步引入；这里只读取，不重复加载。
  var _token = "";
  var AUTH_KEY = "buhuo_web_auth_v1";
  function authLoad() {
    try {
      var o = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
      if (!o || !o.t) return null;
      if (o.e && o.e < Math.floor(Date.now() / 1000) + 60) return null;
      return o;
    } catch (e) { return null; }
  }
  function readToken() {
    // 自有域名下 SDK 会话（存 workbuddy.host 域）跨域拿不到，先读本站登录态
    var a = authLoad();
    if (a) return a.t;
    try {
      // config.js 用 `const cloud` 顶层声明（不挂 window），同全局词法作用域可见。
      // 用 typeof 规避未加载时的 ReferenceError。
      var c = (typeof cloud !== "undefined") ? cloud : window.cloud;
      if (!c || !c.auth || !c.auth.getSession) return "";
      var s = c.auth.getSession();
      var sess = s && (s.data && s.data.session || s.session);
      return (sess && sess.access_token) || "";
    } catch (e) { return ""; }
  }
  window.__wbToken = function () { if (!_token) _token = readToken(); return _token; };

  // ---------- 2) 门禁绕过 ----------
  // 桌面端 frgBoot() 在脚本底部同步调用，必须在它之前把 localStorage 标记设好。
  try { localStorage.setItem("buhuo_onboarded_v1", "1"); } catch (e) {}

  // ---------- 3) 端点兜底 ----------
  // 值 = 该端点被拦时返回的 JSON。空对象/数组按各前端函数容错设计。
  var STUB = {
    "/api/activation/status": {
      is_activated: true, tier: "web", tier_label: "网页版",
      machine_code: "WEB", days_left: 999, expire_at: "", hours_left: 0
    },
    "/api/auth/access": {
      allowed: true, need_login: false,
      cloud: { logged_in: true, username: "网页版用户" },
      license: { is_activated: true, tier: "web" },
      reason: "", message: ""
    },
    "/api/cloud/status": { logged_in: true, username: "网页版用户", membership: {} },
    "/api/ip-profile": { ok: true, profile: null },
    "/api/cache/stats": { ok: true, tokens: 0, calls: 0, size: 0 },
    "/api/image/billing": { ok: true, mode: "credits", cost: 3, balance: 0 },
    "/api/cockpit/data": { ok: true, accounts: [], summary: {}, rows: [] },
    "/api/style-profile": { ok: true, profiles: [], active: null },
    "/api/ext-cookie/status": { ok: false, configured: false },
    "/api/accounts": { ok: true, accounts: [] },
    "/api/reminders": { ok: true, items: [] },
    "/api/user": { ok: true, username: "网页版用户" },
    "/api/token-stats": { ok: true, total: 0 },
    "/api/models/vision": { ok: true, models: [] },
    "/api/themes14": { ok: true, themes: [] },
    "/api/styles": { ok: true, styles: [] },
    "/api/tutorial": { ok: true, steps: [] },
    // 下面是实测会在首屏打 404 的（桌面端本地接口，云端没有）：
    // 不兜会刷一屏红字，而且「加载模型/风格失败」会弹给用户看
    "/api/models": { ok: true, models: [], styles: [] },
    "/api/style-layers": { ok: true, items: [], layers: [] },
    "/api/books": { ok: true, items: [], books: [] },
    // 生图模型/风格：网页端只走 KG 云端的 gpt-image-2，本地模型列表没有意义。
    // 不给会连打两个 404，并在「配图」「漫画」面板各挂一条红色失败说明。
    "/api/image/models": { ok: true, models: [{ id: "gpt-image-2", name: "GPT-Image-2（云端）" }] },
    "/api/image/styles": {
      ok: true,
      styles: [
        { id: "k3_minimal", name: "K3简约风格" },
        { id: "hand_drawn", name: "手绘风格" },
        { id: "flat_cover", name: "扁平风格" },
        { id: "photo_real", name: "写实质感" }
      ]
    }
  };
  // 前缀匹配（这些端点的子路径也兜底）
  var STUB_PREFIX = [
    "/api/inspiration/", "/api/redfox/", "/api/feed/refresh",
    "/api/wx/scan/", "/api/update/", "/api/local-", "/api/diag/",
    "/api/metrics/", "/api/library/", "/api/materials/", "/api/presets/"
  ];
  // 真正由后端实现的端点（放行，绝不拦）
  var REAL = [
    "/api/health", "/api/ai-score", "/api/detox", "/api/aihot",
    "/api/typeset/slots", "/api/typeset/componentize", "/api/export/html",
    "/api/docx-text", "/api/preflight",
    "/api/works/save", "/api/works/list", "/api/works/load", "/api/works/delete",
    "/api/generate", "/api/outline", "/api/write", "/api/polish",
    "/api/improve-title", "/api/improve-content", "/api/generate-titles",
    "/api/rewrite-segment", "/api/hotspot/sync/", "/api/byok/",
    "/api/img", "/api/feed/img", "/api/image/generate",
    /* 图生图（二创复刻）：同样走浏览器直连 KG API，不经过本机后端 */
    "/api/image/ref-regen", "/api/image/edit"
  ];

  function stubFor(path) {
    if (STUB[path]) return STUB[path];
    for (var i = 0; i < STUB_PREFIX.length; i++) {
      if (path.indexOf(STUB_PREFIX[i]) === 0) {
        return { ok: true, items: [], list: [], rows: [], data: [] };
      }
    }
    return null;
  }
  function isReal(url) {
    for (var i = 0; i < REAL.length; i++) {
      if (url.indexOf(REAL[i]) >= 0) return true;
    }
    return false;
  }
  function jsonResp(data) {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  // ---------- 热点库存桥接（2026-11-26）----------
  // 桌面端首页/热点广场读 /api/feed/library（本机 DATA_DIR），会员站没这个路由。
  // 网页端改成读云端 hotspot_item：/api/hotspot/sync/pull（RLS authenticated），
  // 字段从 snake_case 转回桌面端 camelCase，前端渲染逻辑一行都不用改。
  // 这样「本地抓取 → 云端 → 网页端」才真正闭环。
  var _HOTSPOT_CACHE = { at: 0, items: null };

  function hpCount(n) {
    // 云端列是 int，桌面端显示的是 "10w+"，转回去才有原有观感
    n = Number(n);
    if (!isFinite(n) || n <= 0) return "";
    if (n >= 10000) {
      var w = n / 10000;
      return (Math.round(w * 10) / 10).toString().replace(/\.0$/, "") + "w+";
    }
    return String(Math.round(n));
  }

  function hpRow(r) {
    return {
      id: r.item_id, oriUrl: r.ori_url, title: r.title, summary: r.summary,
      content: r.content, coverUrl: r.cover_url, thumbnail: r.thumbnail,
      track: r.track, form: r.form,
      formConfidence: r.form_confidence, formConflict: r.form_conflict,
      clicksCount: hpCount(r.clicks_count), shareCount: hpCount(r.share_count),
      likeCount: hpCount(r.like_count), commentCount: hpCount(r.comment_count),
      watchCount: hpCount(r.watch_count),
      userName: r.user_name, publicTime: r.public_time, dataDate: r.data_date,
      serverVersion: r.server_version
    };
  }

  function pullHotspots(force) {
    if (!force && _HOTSPOT_CACHE.items && Date.now() - _HOTSPOT_CACHE.at < 60000) {
      return Promise.resolve(_HOTSPOT_CACHE.items);
    }
    var tok = window.__wbToken();
    if (!tok) return Promise.resolve([]);   // 没登录就不硬拉，交给上层登录提示
    var out = [], since = 0, guard = 0;
    function next() {
      if (guard++ > 40) return Promise.resolve(out);
      var q = "/api/hotspot/sync/pull?since=" + since + "&limit=1000";
      return _fetch(q, { headers: { "x-user-token": tok } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var rows = (j && j.items) || [];
          for (var i = 0; i < rows.length; i++) out.push(hpRow(rows[i]));
          var sv = Number(j && j.server_version) || 0;
          if (!j || !j.has_more || !rows.length || sv <= since) return out;
          since = sv;
          return next();
        })
        .catch(function () { return out; });
    }
    return next().then(function (items) {
      _HOTSPOT_CACHE = { at: Date.now(), items: items };
      return items;
    });
  }
  window.__wbHotspots = pullHotspots;

  // ---------- 包装 fetch ----------
  var _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var path = url.split("?")[0];

    // 封面代理：桌面端是 /api/feed/img?u=xxx&w=400，会员站是 /api/img?u=xxx（同签名，直接改路径）
    // 不转的话封面全 404，瀑布流就是一排空图框。
    if (path === "/api/feed/img") {
      return _fetch(url.replace("/api/feed/img", "/api/img"), init);
    }

    // 热点库存 → 云端 hotspot_item（网页端唯一数据源）
    if (path === "/api/feed/library") {
      return pullHotspots(false).then(function (items) {
        return jsonResp({ success: true, items: items });
      });
    }

    // 生图端点 → 走会员站已验证的计费链路（浏览器直连 KG API）
    // 图生图（二创复刻）：带参考图，走 WBGen.generateRef（失败绝不降级文生图）
    if ((path === "/api/image/ref-regen" || path === "/api/image/edit") && window.WBGen) {
      var rb = {}; try { rb = JSON.parse((init && init.body) || "{}"); } catch (e) {}
      return window.WBGen.generateRef(rb).then(function (r) { return jsonResp(r); });
    }
    if (path === "/api/image/generate" && window.WBGen) {
      var body = {};
      try { body = JSON.parse((init && init.body) || "{}"); } catch (e) {}
      return window.WBGen.generate(body).then(function (r) { return jsonResp(r); });
    }

    // 未实现端点 → 友好空数据（同步返回 Promise，不打扰后端）
    if (path.indexOf("/api/") === 0 && !isReal(url)) {
      var stub = stubFor(path);
      if (stub) return Promise.resolve(jsonResp(stub));
    }

    // 已实现端点 → 注入登录态
    init = init || {};
    var h = new Headers(init.headers || (input && input.headers) || {});
    var tok = window.__wbToken();
    if (tok && !h.has("x-user-token")) h.set("x-user-token", tok);
    init.headers = h;
    return _fetch(input, init);
  };

  // ---------- 4) 菜单裁剪 ----------
  // 本机绑定 + 漫画 + 热点写入按钮：胜元拍板侧栏不显示。
  var HIDE = {
    "comic-topic": 1, "comic-script": 1, "comic-image": 1,
    "comic-export": 1, "comic-ip": 1,
    "settings": 1  // 设置里全是本机激活/本地模型/自更新，网页端无意义
  };
  function trimMenu() {
    var nodes = document.querySelectorAll('[data-module]');
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].getAttribute("data-module");
      if (HIDE[id]) {
        nodes[i].style.display = "none";
      }
    }
    // 左下角设置入口（ws-set-btn）：打开的是本机激活/本地模型面板，网页端无意义
    // 注意 DOM 里有两份（桌面版 + 移动版），getElementById 只取第一个，必须 querySelectorAll
    var setBtns = document.querySelectorAll("#ws-set-btn");
    for (var s = 0; s < setBtns.length; s++) setBtns[s].style.display = "none";

    // 热点广场的「抓取/刷新」按钮：网页端只读，去掉
    var btns = document.querySelectorAll('button,a');
    for (var j = 0; j < btns.length; j++) {
      var t = (btns[j].textContent || "").trim();
      if (/^(抓取|刷新榜单|立即抓取|全量抓取|更新榜单)$/.test(t)) {
        btns[j].style.display = "none";
      }
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", trimMenu);
  } else { trimMenu(); }
  // 兜底：模块面板可能延迟渲染，再补一次
  setTimeout(trimMenu, 1500);

  // ---------- 4b) 动态插入的本机元素（MutationObserver 兜底）----------
  // 有些提示条是 JS 运行时创建的（如 #lm-guide「还没装本地去味模型」），
  // 一开始 DOM 里没有，靠 trimMenu 定时跑容易漏。这里持续监听。
  var DYN_HIDE_IDS = { "lm-guide": 1 };
  function killDyn(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.id && DYN_HIDE_IDS[node.id]) { node.style.display = "none"; return; }
    if (node.querySelectorAll) {
      var hit = node.querySelectorAll("#lm-guide");
      for (var i = 0; i < hit.length; i++) hit[i].style.display = "none";
    }
  }
  try {
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) killDyn(added[j]);
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  // ---------- 5) 皮肤：默认酸绿浅色 ----------
  // B1 已在 index.html 里落了正式双皮肤令牌（body[data-skin="acid"] / "acid-dark"），
  // 这里不注入 CSS 覆盖（否则会和令牌打架），只负责**把默认皮肤真正刷上去**。
  // 🔴 坑：桌面端的 applySkin() 只在 initSkinPicker() 里调，而 initSkinPicker()
  //    只在「打开设置弹窗」时执行 → 网页端首屏 body 上没有 data-skin，
  //    酸绿令牌一条都不生效，页面永远是晨雾绿。必须在启动时自己补一次。
  function bootSkin() {
    var skin = "acid";
    try {
      // State 是 index.html 顶层 let，跨 script 可见（不是 window.State）。
      // defaultState() 给的就是 'acid'；用户手动选了晨雾绿才会是 ''，要尊重。
      if (typeof State !== "undefined" && State && typeof State.skin === "string") {
        skin = State.skin;
      }
    } catch (e) {}
    if (skin) document.body.dataset.skin = skin;
    else delete document.body.dataset.skin;
    window.__WB_SKIN_DEFAULT__ = skin || "";
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootSkin);
  } else {
    bootSkin();
  }

  // ---------- 5b) 网页端账密登录（2026-11-27）----------
  /* 为什么要自建一套登录：
     1) 站点搬到自有域名（知识不惑.cn）后，cloud-sdk 的会话存在 workbuddy.host 域下，
        跨域读不到，__wbToken() 恒为空 → 热点广场「初始化库存读取失败」；
     2) 浏览器直连云端 signin 会被 Origin 白名单拒：
        403 {"error":"access_denied","error_description":"the request origin is not allowed for this client"}
        —— 只有服务端发起的请求能过。所以登录交给本机后端 /api/auth/signin 代发。
     3) token 存 localStorage，其余业务代码一律不动（__wbToken 已优先返回它）。
     密码只在登录请求里过一遍，不落 localStorage、不记日志。 */
  var AUTH_CSS = "" +
    "#wbauth-pill{position:fixed;top:66px;right:14px;z-index:9000;display:flex;align-items:center;gap:6px;" +
    "padding:6px 12px;border-radius:999px;background:#C8FF00;color:#12210a;font:600 12px/1 " +
    "'PingFang SC','Microsoft YaHei',sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.14);" +
    "border:1px solid rgba(0,0,0,.06);user-select:none}" +
    "#wbauth-pill:hover{filter:brightness(1.05)}" +
    "#wbauth-pill.on{background:#fff;color:#2b3a22;font-weight:500;max-width:190px;overflow:hidden;" +
    "text-overflow:ellipsis;white-space:nowrap}" +
    "#wbauth-mask{position:fixed;inset:0;z-index:9500;background:rgba(16,26,12,.42);display:none;" +
    "align-items:center;justify-content:center;backdrop-filter:blur(2px)}" +
    "#wbauth-mask.on{display:flex}" +
    "#wbauth-card{width:340px;max-width:calc(100vw - 40px);background:#fff;border-radius:16px;padding:22px 22px 16px;" +
    "box-shadow:0 24px 60px rgba(0,0,0,.26);font:14px/1.5 'PingFang SC','Microsoft YaHei',sans-serif;color:#1b2416}" +
    "#wbauth-card h3{margin:0 0 6px;font-size:17px;font-weight:700}" +
    "#wbauth-card p.sub{margin:0 0 14px;font-size:12px;color:#6b7a5f;line-height:1.5}" +
    "#wbauth-card input{width:100%;box-sizing:border-box;height:38px;margin-bottom:10px;padding:0 12px;" +
    "border:1px solid #dde4d6;border-radius:9px;font-size:14px;outline:none;background:#fbfcf9}" +
    "#wbauth-card input:focus{border-color:#a8d400;background:#fff}" +
    "#wbauth-err{min-height:16px;font-size:12px;color:#c0392b;margin:0 0 6px}" +
    "#wbauth-go{width:100%;height:40px;border:0;border-radius:10px;background:#C8FF00;color:#12210a;" +
    "font-size:14px;font-weight:700;cursor:pointer}" +
    "#wbauth-go:disabled{opacity:.6;cursor:default}" +
    "#wbauth-later{margin-top:10px;text-align:center;font-size:12px;color:#8a9681;cursor:pointer}" +
    "#wbauth-later:hover{color:#4a5a3e}";

  function authUi() {
    var st = document.createElement("style");
    st.id = "wb-auth-css";
    st.textContent = AUTH_CSS;
    (document.head || document.documentElement).appendChild(st);

    var pill = document.createElement("div");
    pill.id = "wbauth-pill";
    var mask = document.createElement("div");
    mask.id = "wbauth-mask";
    mask.innerHTML =
      '<div id="wbauth-card">' +
      "<h3>登录会员账号</h3>" +
      '<p class="sub">登录后同步云端热点库存、按积分生图；写作和配图填自己的 Key 不用登录。</p>' +
      '<input id="wbauth-u" type="text" placeholder="邮箱 / 手机号" autocomplete="username">' +
      '<input id="wbauth-p" type="password" placeholder="密码" autocomplete="current-password">' +
      '<div id="wbauth-err"></div>' +
      '<button id="wbauth-go">登录</button>' +
      '<div id="wbauth-later">先不用，稍后再说</div>' +
      "</div>";
    document.body.appendChild(pill);
    document.body.appendChild(mask);

    var u = mask.querySelector("#wbauth-u");
    var p = mask.querySelector("#wbauth-p");
    var err = mask.querySelector("#wbauth-err");
    var go = mask.querySelector("#wbauth-go");

    function paint() {
      var a = authLoad();
      if (a) {
        pill.className = "on";
        pill.textContent = (a.u || "已登录") + " · 退出";
        pill.title = "点击退出登录";
      } else {
        pill.className = "";
        pill.textContent = "未登录 · 登录";
        pill.title = "登录会员账号，读取云端热点";
      }
    }
    function open_() {
      err.textContent = "";
      mask.classList.add("on");
      setTimeout(function () { u.focus(); }, 30);
    }
    function close_() { mask.classList.remove("on"); }

    function submit() {
      var uv = (u.value || "").trim();
      var pv = p.value || "";
      if (!uv || !pv) { err.textContent = "账号和密码都要填"; return; }
      go.disabled = true;
      go.textContent = "登录中…";
      err.textContent = "";
      _fetch("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: uv, password: pv })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.ok || !j.token) {
          err.textContent = (j && (j.message || j.error)) || "登录失败";
          go.disabled = false;
          go.textContent = "登录";
          return;
        }
        try {
          localStorage.setItem(AUTH_KEY, JSON.stringify({
            t: j.token, e: Number(j.exp) || 0, u: j.username || uv
          }));
        } catch (e) {}
        p.value = "";
        go.textContent = "已登录";
        // 全量刷新：热点库存、积分、生图通道都按登录态重新初始化
        setTimeout(function () { location.reload(); }, 400);
      }).catch(function (e) {
        err.textContent = "网络异常，稍后再试";
        go.disabled = false;
        go.textContent = "登录";
      });
    }

    pill.addEventListener("click", function () {
      if (authLoad()) {
        localStorage.removeItem(AUTH_KEY);
        _token = "";
        _HOTSPOT_CACHE = { at: 0, items: null };
        paint();
        location.reload();
        return;
      }
      open_();
    });
    go.addEventListener("click", submit);
    p.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    u.addEventListener("keydown", function (e) { if (e.key === "Enter") p.focus(); });
    mask.addEventListener("click", function (e) { if (e.target === mask) close_(); });
    mask.querySelector("#wbauth-later").addEventListener("click", function () {
      try { localStorage.setItem("buhuo_auth_later_v1", String(Date.now())); } catch (e) {}
      close_();
    });

    paint();

    /* 首次打开自动弹一次：热点广场没登录只会显示「初始化库存读取失败」，
       与其让人先去点热点再猜原因，不如开门见山。24 小时内不再自动弹。 */
    if (!authLoad()) {
      var later = 0;
      try { later = Number(localStorage.getItem("buhuo_auth_later_v1") || 0); } catch (e) {}
      if (!later || Date.now() - later > 86400000) {
        setTimeout(open_, 900);
      }
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", authUi);
  } else {
    authUi();
  }

  window.__WB_ADAPTER__ = true;

  // ---------- 6) 强制隐藏（CSS !important，不受 JS 重渲染影响）----------
  // JS 的 setStyle 会被后续渲染覆盖，用样式表兜底最稳。
  var HIDE_CSS = "" +
    "#ws-set-btn{display:none !important}" +
    "#lm-guide{display:none !important}" +
    /* 侧栏底部的「⚙ 设置」：v4 分组后由 renderRail 统一产出（class rail-foot），
       网页端不显示本机设置入口（胜元 2026-11-26 拍板「本机功能侧栏不显示」）。
       🔴 用 CSS 兜住而不是改 index.html —— 这样桌面端源码可以带设置入口，两端同源。 */
    "#rail .rail-foot,#rail .rail-sec{display:none !important}" +
    '[data-module="comic-topic"],[data-module="comic-script"],[data-module="comic-image"],' +
    '[data-module="comic-export"],[data-module="comic-ip"],[data-module="settings"]' +
    "{display:none !important}" +
    /* 板块切换器里的「漫画号」：网页端不做漫画（胜元 2026-11-26 拍板） */
    '#ws-sector [data-sector="comic"],#nav-comic,#rail [data-sector="comic"]{display:none !important}';
  var hs = document.createElement("style");
  hs.id = "wb-hide-css";
  hs.textContent = HIDE_CSS;
  (document.head || document.documentElement).appendChild(hs);

  // ---------- 7) 「我的设定 · 提示词模板」默认收起 ----------
  /* 桌面端 openModule() 每次打开模块都会 sw.classList.add('on') 把右侧 318px 面板推出来
     （见 index.html 约 20174 行）。桌面窗口宽，那样合理；网页端是全屏浏览器，
     1440 屏被吃掉 318px 后瀑布流直接从 4 列掉到 3 列。胜元 2026-11-26 拍板：
     网页端默认收起，只保留右侧绿色竖条标签，点它照常展开，功能一点不少。

     实现靠 MutationObserver 撤 .on，而不是改 index.html —— 保证两端同一份源码。
     🔴 必须区分「用户主动点开」和「代码自动加」：前者要保留，否则面板永远打不开。
        判据是最近 400ms 内有没有点过 .sw-tab。 */
  (function () {
    function initSetwin() {
      var sw = document.getElementById("setwin");
      if (!sw) return;
      document.addEventListener("click", function (ev) {
        var t = ev.target;
        if (t && t.closest && t.closest("#setwin .sw-tab")) window.__wbSetwinUser = Date.now();
      }, true);
      try {
        new MutationObserver(function () {
          if (!sw.classList.contains("on")) return;
          var t = window.__wbSetwinUser || 0;
          if (Date.now() - t < 400) return;     // 用户刚点的，放行
          sw.classList.remove("on");
          if (document.body) document.body.dataset.setwin = "off";
        }).observe(sw, { attributes: true, attributeFilter: ["class"] });
      } catch (e) {}
    }
    /* adapter 在 <head> 里同步执行，#setwin 在 body 里还没解析 → 必须等 DOM 就绪 */
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initSetwin);
    } else {
      initSetwin();
    }
  })();
})();
