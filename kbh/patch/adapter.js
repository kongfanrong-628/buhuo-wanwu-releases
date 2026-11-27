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
    /* 网页端 Token 用量：真实统计在会员站侧还没接，给一份结构完整的空账。
       🔴 必须是 success:true + today/week/by_model 全套：前端只判 d.success，
          少一个字段就渲染成「⚠ 读取失败」，看着像坏了。 */
    "/api/token-stats": {
      success: true,
      today: { tokens: 0, calls: 0 },
      week: { tokens: 0, calls: 0 },
      by_model: []
    },
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
    /* 🔴 2026-11-27：这两个必须是「按真实登录态」动态返回，不能用静态 stub。
       写死 logged_in:true 会让前端永远以为已登录 —— 写作区顶部不提示登录、
       热点广场也不提示，用户只看到「初始化库存读取失败」这种误导文案。 */
    if (path === "/api/auth/access") {
      var a = authLoad();
      return {
        allowed: true, need_login: !a,
        cloud: { logged_in: !!a, username: a ? (a.u || "网页版用户") : "" },
        license: { is_activated: true, tier: "web" },
        reason: "", message: a ? "" : "登录后可同步云端热点库存"
      };
    }
    if (path === "/api/cloud/status") {
      var b = authLoad();
      return { logged_in: !!b, username: b ? (b.u || "网页版用户") : "", membership: {} };
    }
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

    // 模型预设：网页端自己实现（清单在 localStorage，Key 进云端保险箱）
    // 🔴 必须排在 STUB_PREFIX 的 /api/presets/ 之前，否则会被兜底成空清单
    if (path.indexOf("/api/presets/writing/") === 0) {
      var pact = path.slice("/api/presets/writing/".length);
      var pbd = {};
      try { pbd = JSON.parse((init && init.body) || "{}"); } catch (e) {}
      return presetsHandle(pact, pbd).then(function (o) { return jsonResp(o); });
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
    "#wbauth-later:hover{color:#4a5a3e}" +
    "#wbauth-card .wbauth-tabs{display:flex;gap:20px;margin:0 0 14px;font-size:15px;font-weight:700;color:#b6c0ad}" +
    "#wbauth-card .wbauth-tabs span{cursor:pointer;padding-bottom:6px;border-bottom:2px solid transparent}" +
    "#wbauth-card .wbauth-tabs span.on{color:#1b2416;border-bottom-color:#C8FF00}" +
    "#wbauth-card .wbauth-row{display:flex;gap:8px;align-items:center}" +
    "#wbauth-card .wbauth-row input{flex:1;margin-bottom:10px}" +
    "#wbauth-card .wbauth-mini{white-space:nowrap;height:38px;padding:0 12px;border:1px solid #dde4d6;" +
    "border-radius:9px;background:#fff;font-size:12px;font-weight:600;color:#3d4a33;cursor:pointer;" +
    "font-family:inherit;margin-bottom:10px}" +
    "#wbauth-card .wbauth-mini:disabled{opacity:.55;cursor:default}" +
    "#wbauth-r-go{width:100%;height:40px;border:0;border-radius:10px;background:#C8FF00;color:#12210a;" +
    "font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}" +
    "#wbauth-r-go:disabled{opacity:.6;cursor:default}" +
    "#wbauth-r-err{min-height:16px;font-size:12px;color:#c0392b;margin:0 0 6px}" +
    "#wbauth-card .sub b{color:#1b2416}";

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
      '<div class="wbauth-tabs">' +
      '<span data-tab="login" class="on">登录</span>' +
      '<span data-tab="reg">注册</span>' +
      "</div>" +
      '<div class="wbauth-f" data-f="login">' +
      '<p class="sub">登录后同步云端热点库存、按积分生图；写作和配图填自己的 Key 不用登录。</p>' +
      '<input id="wbauth-u" type="text" placeholder="邮箱 / 手机号" autocomplete="username">' +
      '<input id="wbauth-p" type="password" placeholder="密码" autocomplete="current-password">' +
      '<div id="wbauth-err"></div>' +
      '<button id="wbauth-go">登录</button>' +
      "</div>" +
      '<div class="wbauth-f" data-f="reg" style="display:none">' +
      '<p class="sub">新用户注册即开通 <b>24 小时体验</b>，到账 <b>10 积分</b>（生图 3 分/张，可出 3 张）。</p>' +
      '<input id="wbauth-r-id" type="text" placeholder="邮箱 / 手机号" autocomplete="username">' +
      '<div class="wbauth-row">' +
      '<input id="wbauth-r-code" type="text" placeholder="验证码" inputmode="numeric" autocomplete="one-time-code">' +
      '<button id="wbauth-r-send" class="wbauth-mini" type="button">获取验证码</button>' +
      "</div>" +
      '<input id="wbauth-r-pwd" type="password" placeholder="设置密码（至少 6 位）" autocomplete="new-password">' +
      '<div id="wbauth-r-err"></div>' +
      '<button id="wbauth-r-go" type="button">注册并开通体验</button>' +
      "</div>" +
      '<div id="wbauth-later">先不用，稍后再说</div>' +
      "</div>";
    document.body.appendChild(pill);
    document.body.appendChild(mask);

    var u = mask.querySelector("#wbauth-u");
    var p = mask.querySelector("#wbauth-p");
    var err = mask.querySelector("#wbauth-err");
    var go = mask.querySelector("#wbauth-go");
    // ---- 注册 tab ----
    var rId = mask.querySelector("#wbauth-r-id");
    var rCode = mask.querySelector("#wbauth-r-code");
    var rPwd = mask.querySelector("#wbauth-r-pwd");
    var rSend = mask.querySelector("#wbauth-r-send");
    var rGo = mask.querySelector("#wbauth-r-go");
    var rErr = mask.querySelector("#wbauth-r-err");
    var regVid = "";

    /* 注册三步走（云端强制）：发验证码 → 换 verification_token → 建号。
       建号 succeeds 后服务端顺手调 trial_auto_open，24 小时体验 + 10 积分自动到账。 */
    function sendOtp() {
      var id = (rId.value || "").trim();
      if (!id) { rErr.textContent = "请先填邮箱或手机号"; return; }
      rSend.disabled = true;
      rSend.textContent = "发送中…";
      rErr.textContent = "";
      _fetch("/api/auth/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ident: id })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.ok) {
          rErr.textContent = (j && (j.message || j.error)) || "验证码没发出去";
          rSend.disabled = false; rSend.textContent = "重新获取";
          return;
        }
        if (j.is_user) {
          rErr.textContent = "这个账号已经注册过了，切到「登录」直接登就行";
          rSend.disabled = false; rSend.textContent = "获取验证码";
          return;
        }
        regVid = j.verification_id;
        var left = 60;
        rSend.textContent = left + "s 后重发";
        var t = setInterval(function () {
          left -= 1;
          if (left <= 0) { clearInterval(t); rSend.disabled = false; rSend.textContent = "重新获取"; return; }
          rSend.textContent = left + "s 后重发";
        }, 1000);
        try { rCode.focus(); } catch (e) {}
      }).catch(function () {
        rErr.textContent = "网络异常，稍后再试";
        rSend.disabled = false; rSend.textContent = "获取验证码";
      });
    }

    function submitReg() {
      var id = (rId.value || "").trim();
      var code = (rCode.value || "").trim();
      var pwd = rPwd.value || "";
      if (!id || !code || !pwd) { rErr.textContent = "账号、验证码、密码都要填"; return; }
      if (pwd.length < 6) { rErr.textContent = "密码至少 6 位"; return; }
      if (!regVid) { rErr.textContent = "请先点「获取验证码」"; return; }
      rGo.disabled = true;
      rGo.textContent = "注册中…";
      rErr.textContent = "";
      _fetch("/api/auth/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verification_id: regVid, code: code })
      }).then(function (r) { return r.json(); }).then(function (v) {
        if (!v || !v.ok) {
          rErr.textContent = (v && (v.message || v.error)) || "验证码不对";
          rGo.disabled = false; rGo.textContent = "注册并开通体验";
          return null;
        }
        return _fetch("/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ident: id, password: pwd, verification_token: v.verification_token })
        }).then(function (r) { return r.json(); }).then(function (s) {
          if (!s || !s.ok) {
            rErr.textContent = (s && (s.message || s.error)) || "注册没成功";
            rGo.disabled = false; rGo.textContent = "注册并开通体验";
            return;
          }
          try {
            localStorage.setItem(AUTH_KEY, JSON.stringify({
              t: s.token, e: Number(s.exp) || 0, u: s.username || id
            }));
          } catch (e) {}
          var tr = s.trial || {};
          rGo.textContent = (tr && tr.granted)
            ? "✅ 已到账 " + tr.granted + " 积分，正在进入…"
            : "✅ 注册成功，正在进入…";
          setTimeout(function () { location.reload(); }, 1000);
        });
      }).catch(function () {
        rErr.textContent = "网络异常，稍后再试";
        rGo.disabled = false; rGo.textContent = "注册并开通体验";
      });
    }

    function switchTab(name) {
      var tabs = mask.querySelectorAll(".wbauth-tabs span");
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].className = (tabs[i].getAttribute("data-tab") === name) ? "on" : "";
      }
      var fs = mask.querySelectorAll(".wbauth-f");
      for (var k = 0; k < fs.length; k++) {
        fs[k].style.display = (fs[k].getAttribute("data-f") === name) ? "" : "none";
      }
      err.textContent = ""; rErr.textContent = "";
      setTimeout(function () { (name === "reg" ? rId : u).focus(); }, 30);
    }

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
    rSend.addEventListener("click", sendOtp);
    rGo.addEventListener("click", submitReg);
    rCode.addEventListener("keydown", function (e) { if (e.key === "Enter") rPwd.focus(); });
    rPwd.addEventListener("keydown", function (e) { if (e.key === "Enter") submitReg(); });
    var tabEls = mask.querySelectorAll(".wbauth-tabs span");
    for (var ti = 0; ti < tabEls.length; ti++) {
      tabEls[ti].addEventListener("click", function () {
        switchTab(this.getAttribute("data-tab"));
      });
    }
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

  // ---------- 5c) 生图结果桥接（2026-11-27）----------
  /* 桌面端由 Python 后端把图存盘，前端用 /images/<fn> 取；网页端 wbgen 直连 KG API，
     拿到的是 dataURL，index.html 渲染时仍写 /images/<fn> → 全部 404，
     用户看到的就是「生成了但图是空的、下载也没反应」。这里补三件事：
       ① 出图后把 dataURL POST 到 /api/img-cache 落盘（刷新后还在）
       ② 页面里 /images/ 开头的 src 改写成 /imgcache/
       ③ 接管「⬇下载」，用 <a download> 直接存到本机                        */
  function initImgBridge() {
    function rewrite() {
      var list = document.querySelectorAll('img[src^="/images/"]');
      for (var i = 0; i < list.length; i++) {
        var s = list[i].getAttribute("src") || "";
        var name = s.slice("/images/".length).split("?")[0];
        if (!name) continue;
        list[i].setAttribute("src", "/imgcache/" + name);
      }
    }
    rewrite();
    var pending = false;
    try {
      new MutationObserver(function () {
        if (pending) return;
        pending = true;
        setTimeout(function () { pending = false; rewrite(); }, 80);
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}

    document.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest
        ? ev.target.closest('[data-action="imgCardDownload"]') : null;
      if (!btn) return;
      var idx = parseInt(btn.getAttribute("data-idx") || "-1", 10);
      var st = (typeof State !== "undefined" && State) ? State : window.State;
      var rec = st && st.generatedImages ? st.generatedImages[idx] : null;
      if (!rec || !rec.filename) return;
      ev.preventDefault();
      ev.stopPropagation();
      var a = document.createElement("a");
      a.href = "/imgcache/" + encodeURIComponent(rec.filename);
      a.download = rec.filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 300);
    }, true);
  }

  // ---------- 5d) 模型预设 + Key（网页端：清单在本地，Key 进云端保险箱）----------
  /* 桌面端预设走 /api/presets/writing/*（本机 JSON 文件），网页端这些端点被 stub 成空成功
     → 下拉是空的、Key「保存」看着成功但没存下 → 写作必然 need_key。
     网页端换个存法：
       · 预设清单（名称/BaseURL/模型名）存 localStorage（不进云端，无敏感信息）
       · 真 Key 进云端保险箱 /api/byok/save 的 writing 槽（AES-256-GCM，服务端代调时才取明文）
     因此网页端要能 AI 写作，必须「登录 + 在设置里填一次 Key」。 */
  var PRESET_LS = "buhuo_web_presets_v1";
  var BUILTIN_PRESETS = [
    { id: "deepseek-flash", name: "Deepseek", model: "deepseek-chat",
      base_url: "https://api.deepseek.com/v1", builtin: true, is_default: true },
    { id: "qwen-plus", name: "通义千问", model: "qwen-plus",
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", builtin: true },
    { id: "kimi", name: "Kimi", model: "moonshot-v1-8k",
      base_url: "https://api.moonshot.cn/v1", builtin: true },
    { id: "glm", name: "智谱 GLM", model: "glm-4-plus",
      base_url: "https://open.bigmodel.cn/api/paas/v4", builtin: true },
    { id: "doubao", name: "豆包", model: "doubao-pro-32k",
      base_url: "https://ark.cn-beijing.volces.com/api/v3", builtin: true }
  ];

  function presetMine() {
    try { return JSON.parse(localStorage.getItem(PRESET_LS) || "[]") || []; } catch (e) { return []; }
  }
  function presetAll() { return BUILTIN_PRESETS.concat(presetMine()); }
  function presetFind(id) {
    var all = presetAll();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function vaultCall(path, payload) {
    var tok = window.__wbToken();
    if (!tok) return Promise.resolve({ ok: false, error: "NOT_SIGNED_IN", message: "先登录" });
    return _fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-token": tok },
      body: JSON.stringify(payload || {})
    }).then(function (r) { return r.json(); }).catch(function () {
      return { ok: false, error: "NET" };
    });
  }

  function presetsHandle(act, bd) {
    if (act === "list") {
      return vaultCall("/api/byok/list", {}).then(function (j) {
        var w = null;
        var keys = (j && j.keys) || [];
        for (var i = 0; i < keys.length; i++) if (keys[i].slot === "writing") w = keys[i];
        var presets = presetAll().map(function (p) {
          return {
            id: p.id, name: p.name, model: p.model, base_url: p.base_url,
            builtin: !!p.builtin, is_default: !!p.is_default,
            has_key: !!(w && w.key_tail),
            key_preview: w && w.key_tail ? ("sk-****" + String(w.key_tail).slice(-4)) : ""
          };
        });
        return { success: true, presets: presets, signed_in: !!window.__wbToken() };
      });
    }
    if (act === "add") {
      var mine = presetMine();
      var nid = bd.id || ("web_" + Date.now());
      mine.push({
        id: nid, name: bd.name || "自定义模型",
        base_url: bd.base_url || "", model: bd.model || ""
      });
      try { localStorage.setItem(PRESET_LS, JSON.stringify(mine)); } catch (e) {}
      if (!bd.api_key) return Promise.resolve({ success: true, id: nid });
      return vaultCall("/api/byok/save", {
        slot: "writing", key: bd.api_key, name: bd.name || "",
        base_url: bd.base_url || "", model: bd.model || ""
      }).then(function (r) {
        return r && r.ok ? { success: true, id: nid }
          : { success: false, error: (r && r.message) || "Key 没存进云端" };
      });
    }
    if (act === "update") {
      var p = presetFind(bd.id);
      var base = bd.base_url || (p && p.base_url) || "";
      var model = bd.model || (p && p.model) || "";
      var mine2 = presetMine();
      var hit = false;
      for (var k = 0; k < mine2.length; k++) {
        if (mine2[k].id === bd.id) {
          hit = true;
          if (bd.name) mine2[k].name = bd.name;
          if (bd.base_url) mine2[k].base_url = bd.base_url;
          if (bd.model) mine2[k].model = bd.model;
        }
      }
      if (hit) { try { localStorage.setItem(PRESET_LS, JSON.stringify(mine2)); } catch (e) {} }
      if (!bd.api_key) return Promise.resolve({ success: true });
      return vaultCall("/api/byok/save", {
        slot: "writing", key: bd.api_key,
        name: (bd.name || (p && p.name) || ""), base_url: base, model: model
      }).then(function (r) {
        return r && r.ok ? { success: true }
          : { success: false, error: (r && r.message) || "Key 没存进云端" };
      });
    }
    if (act === "delete") {
      var left = presetMine().filter(function (x) { return x.id !== bd.id; });
      try { localStorage.setItem(PRESET_LS, JSON.stringify(left)); } catch (e) {}
      return Promise.resolve({ success: true });
    }
    if (act === "test") {
      var p2 = presetFind(bd.id);
      return vaultCall("/api/byok/test", {
        base_url: bd.base_url || (p2 && p2.base_url) || "",
        model: bd.model || (p2 && p2.model) || "",
        api_key: bd.api_key || ""
      }).then(function (j) {
        if (j && j.ok) return { success: true, message: j.message || "连通" };
        return { success: false, error: (j && (j.message || j.error)) || "测试失败" };
      });
    }
    return Promise.resolve({ success: false, error: "unknown_action" });
  }

  function initWebBridges() {
    initImgBridge();
    initSettingsEntry();
  }

  /* ---------- 5e) 设置入口（2026-11-27）----------
     桌面端靠侧栏「⚙ 设置」模块打开 #settings-modal，网页端那个入口被隐藏了
     （里面全是本机项），结果文本模型 Key / 公众号上传两个「网页端也需要」的配置
     没有入口 —— 用户只能看到右侧的「提示词模板」面板。
     这里补一个左下角浮动按钮，直接调桌面端现成的 openSettings()，不复制任何逻辑。 */
  function initSettingsEntry() {
    var b = document.createElement("div");
    b.id = "wbset-btn";
    b.textContent = "⚙ 设置";
    b.title = "文本模型 Key / 公众号上传 / 出图计费";
    document.body.appendChild(b);
    b.addEventListener("click", function () {
      if (typeof window.openSettings === "function") {
        try { window.openSettings(); return; } catch (e) {}
      }
      try { toast("设置面板没加载出来，刷新页面再试", "warn"); } catch (e) {}
    });

    /* 弹窗顶部那句「密钥只保存在本机」在网页端是错的：Key 进了云端保险箱。
       包一层 openSettings，打开后把文案换掉（不动 index.html，两端同源）。 */
    var origOpen = window.openSettings;
    function tune() {
      var sub = document.querySelector("#settings-modal .bh-modal-sub");
      if (sub) {
        sub.textContent = "网页端：Key 加密存放在云端保险箱（AES-256-GCM），只在服务端代调模型时取明文 —— 不写日志、不回传前端。";
      }
    }
    if (typeof origOpen === "function") {
      window.openSettings = function () {
        var r = origOpen.apply(this, arguments);
        setTimeout(tune, 80);
        return r;
      };
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initWebBridges);
  } else {
    initWebBridges();
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
    '#ws-sector [data-sector="comic"],#nav-comic,#rail [data-sector="comic"]{display:none !important}' +
    /* 网页端没有本机磁盘：「打包 zip」「打开文件夹」两个按钮点了只会报错，直接不显示。
       单张「⬇下载」由 initImgBridge 接管（<a download> 存到浏览器下载目录）。 */
    '[data-action="imgCardZipAll"],[data-action="imgCardFolder"]{display:none !important}' +
    /* 设置弹窗里属于「本机」的部分（本地模型 / 授权状态 / 生图密钥 / 朱雀 / 清缓存），
       网页端没有对应能力 —— 留着点了就是报错，直接不显示。 */
    '#llm-panel,#llm-toggle-btn,#set-lic-info,#set-clear-cache-btn{display:none !important}' +
    'button[onclick="cacheClear()"]{display:none !important}' +
    /* 设置入口：左下角浮动按钮（桌面端侧栏那个入口在网页端被隐藏） */
    '#wbset-btn{position:fixed;left:16px;bottom:16px;z-index:9000;display:flex;align-items:center;' +
    'gap:4px;padding:7px 13px;border-radius:999px;background:rgba(255,255,255,.92);color:#2b3a22;' +
    "font:600 12px/1 'PingFang SC','Microsoft YaHei',sans-serif;cursor:pointer;" +
    'box-shadow:0 4px 14px rgba(0,0,0,.12);border:1px solid rgba(0,0,0,.06);user-select:none}' +
    '#wbset-btn:hover{background:#fff;box-shadow:0 6px 18px rgba(0,0,0,.16)}';
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
