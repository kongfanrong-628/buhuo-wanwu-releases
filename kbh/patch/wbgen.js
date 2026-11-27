/* ============================================================
 * 万物写作工坊 · 网页端生图桥接 (wbgen.js)
 * ------------------------------------------------------------
 * 让桌面端 /api/image/generate 的调用契约，在网页端复用会员站
 * 已验证的计费链路（window.cloud.database.rpc + KG API 直连）。
 * 零后端改动，浏览器直连（KG API 已开 CORS，生产验证过）。
 *
 * 计费口径：3 分/张（2026-11-07 拍板，与写作工坊统一）
 * 失败退款：kg_refund_credit（同一笔只退一次）
 * ============================================================ */
(function () {
  "use strict";

  var KG_API = "https://kongbuhuo-kg-api.app.workbuddy.host";
  var KG_SHARECODE = "DYVSPKP27B";
  var COST = 3;

  // 反水印指令（对齐桌面端 ensure_no_watermark 精神）
  var IMG_GUARD = "画面干净利落，不要任何文字、水印、logo、字幕、UI 元素或签名。";

  function _cloud() {
    return (typeof cloud !== "undefined") ? cloud : window.cloud;
  }

  // 把桌面端请求拼成 KG API 的 prompt
  function buildPrompt(req) {
    if (req.direct_prompt && req.content) return String(req.content) + "。" + IMG_GUARD;
    var topic = String(req.topic || "").trim();
    var content = String(req.content || "").trim();
    var type = String(req.image_type || "插图");
    var hint = String(req.context_hint || "").trim();
    var parts = [];
    var typeMap = { "插图": "正文配图", "封面": "公众号封面首图", "贴图": "社交媒体贴图" };
    parts.push("为" + (typeMap[type] || type) + "创作一张图片");
    if (topic) parts.push("主题：" + topic.slice(0, 80));
    // 正文取最长的两句做画面主体（避免空话）
    if (content) {
      var sents = content.split(/[。！？\n]/).filter(function (s) { return s.trim().length > 8; });
      sents.sort(function (a, b) { return b.length - a.length; });
      var body = sents.slice(0, 2).join("；").slice(0, 120);
      if (body) parts.push("画面主体：" + body);
    }
    if (hint) parts.push("用途：" + hint.slice(0, 60));
    parts.push("风格：写实、有质感、光线自然、构图清晰");
    parts.push(IMG_GUARD);
    return parts.join("。");
  }

  // 调 KG API（POST /api/gen 提交 + GET /api/gen/status 轮询）
  function postJson(path, body, timeoutMs, tag) {
    var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs) : null;
    var opt = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    };
    if (ctl) opt.signal = ctl.signal;
    return fetch(KG_API + path + "?sharecode=" + KG_SHARECODE, opt)
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "bad json" }; }); })
      .then(function (json) { return { status: 200, data: json }; })
      .catch(function (e) {
        var to = e && e.name === "AbortError";
        return { status: 0, data: { ok: false, error: to ? ("timeout_" + tag) : "network_error" } };
      })
      .then(function (x) { if (timer) clearTimeout(timer); return x; });
  }

  function getJson(path, params, timeoutMs) {
    var qs = [];
    for (var k in params) if (params.hasOwnProperty(k)) qs.push(k + "=" + encodeURIComponent(params[k]));
    qs.push("sharecode=" + KG_SHARECODE);
    var ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs) : null;
    var opt = ctl ? { method: "GET", signal: ctl.signal } : { method: "GET" };
    return fetch(KG_API + path + "?" + qs.join("&"), opt)
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (json) { return { status: 200, data: json }; })
      .catch(function () { return { status: 0, data: {} }; })
      .then(function (x) { if (timer) clearTimeout(timer); return x; });
  }

  // 积分扣费（先扣后签票，原子）
  function pay(cost, meta) {
    var c = _cloud();
    if (!c || !c.database || !c.database.rpc) {
      return Promise.resolve({ ok: false, error: "not_signed_in", message: "请先登录会员站" });
    }
    return c.database.rpc("kg_pay_ticket", {
      p_amount: cost,
      p_kind: "gen",
      p_model: null,
      p_template: meta.template || null,
      p_prompt: String(meta.prompt || "").slice(0, 500) || null,
      p_meta: null
    }).then(function (res) {
      var data = res && res.data, error = res && res.error;
      if (error) return { ok: false, error: "rpc_error", message: error.message || "扣费失败" };
      if (!data || data.ok === false) {
        if (data && data.error === "insufficient") {
          return { ok: false, error: "insufficient", message: "积分不足：需要 " + data.need + " 分，当前 " + data.balance + " 分", balance: data.balance };
        }
        return { ok: false, error: (data && data.error) || "pay_failed", message: "扣分开票失败（未扣分）" };
      }
      return { ok: true, ticket: data.ticket, logId: data.log_id, userId: data.user_id, balance: data.balance };
    }).catch(function (e) {
      return { ok: false, error: "network_error", message: (e && e.message) || "网络错误" };
    });
  }

  function refund(logId) {
    var c = _cloud();
    if (!c || !c.database || !c.database.rpc || !logId) return Promise.resolve();
    return c.database.rpc("kg_refund_credit", { p_log_id: logId }).catch(function () {});
  }

  // AIGC 显式角标（canvas 画角标，成功则用 data URL，失败降级原图）
  function stampAiMark(src) {
    return new Promise(function (resolve) {
      try {
        var im = new Image();
        im.crossOrigin = "anonymous";
        im.onload = function () {
          try {
            var w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
            if (!w || !h) return resolve(src);
            var cv = document.createElement("canvas");
            cv.width = w; cv.height = h;
            var ctx = cv.getContext("2d");
            ctx.drawImage(im, 0, 0, w, h);
            var base = Math.min(w, h);
            var fs = Math.max(14, Math.round(base * 0.03));
            var label = "AI 生成";
            ctx.font = "600 " + fs + "px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
            var tw = ctx.measureText(label).width;
            var padX = Math.round(fs * 0.66), padY = Math.round(fs * 0.34);
            var bw = Math.round(tw + padX * 2), bh = Math.round(fs + padY * 2);
            var margin = Math.round(base * 0.028);
            var x = w - bw - margin, y = h - bh - margin;
            ctx.globalAlpha = 0.8;
            ctx.fillStyle = "#101010";
            ctx.fillRect(x, y, bw, bh);
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#fff";
            ctx.fillText(label, x + padX, y + fs + Math.round(padY * 0.5));
            resolve(cv.toDataURL("image/png"));
          } catch (e) { resolve(src); }
        };
        im.onerror = function () { resolve(src); };
        im.src = src;
      } catch (e) { resolve(src); }
    });
  }

  // 主入口：对齐桌面端 /api/image/generate 返回契约
  function generate(req) {
    req = req || {};
    var n = Math.max(1, Math.min(4, parseInt(req.n, 10) || 1));
    var size = req.size || "1024x1024";
    var prompt = buildPrompt(req);
    var perCall = COST; // 每次提交扣 3 分（n>1 时桌面端会分多次，这里一次一张）

    return pay(perCall, { prompt: prompt, template: req.image_type || "gen" }).then(function (p) {
      if (!p.ok) return { success: false, error: p.error, message: p.message, need_login: p.error === "not_signed_in" };
      var body = {
        prompt: prompt, size: size, n: 1, ticket: p.ticket,
        user_id: p.userId, images: [], async: true
      };
      return postJson("/api/gen", body, 30000, "gen-submit").then(function (sub) {
        var jobId = sub.data && sub.data.data && sub.data.data.job_id;
        if (!jobId) {
          // 老版本同步返回：直接取 images
          var imgs0 = sub.data && sub.data.data && sub.data.data.images;
          if (imgs0 && imgs0.length) return { ok: true, images: imgs0 };
          refund(p.logId);
          return { success: false, error: "submit_failed", message: (sub.data && sub.data.data && sub.data.data.error) || "提交失败，已退款" };
        }
        // 轮询（最多 4 分钟）
        var deadline = Date.now() + 240000;
        function poll() {
          if (Date.now() > deadline) {
            refund(p.logId);
            return { success: false, error: "timeout_gen", message: "生图超时，已退款" };
          }
          return getJson("/api/gen/status", { id: jobId, user_id: p.userId }, 20000).then(function (r) {
            var st = r.data && r.data.data;
            if (!st || r.status !== 200) return new Promise(function (res) { setTimeout(function () { res(poll()); }, 2000); });
            if (st.status === "pending") return new Promise(function (res) { setTimeout(function () { res(poll()); }, 2000); });
            if (st.status === "ok" && st.images && st.images.length) return { ok: true, images: st.images };
            refund(p.logId);
            return { success: false, error: "gen_failed", message: (st.error || "生图失败") + "，已退款" };
          });
        }
        return poll();
      });
    }).then(function (r) {
      if (!r || !r.ok) return r;
      // 转桌面端契约：images[{filename, local_path}]
      var out = [];
      var imgs = r.images || [];
      var chain = Promise.resolve();
      imgs.forEach(function (it) {
        chain = chain.then(function () {
          var src = it.b64 ? ("data:image/png;base64," + it.b64) : it.url;
          if (!src) return;
          return stampAiMark(src).then(function (marked) {
            out.push({
              filename: "web_" + Date.now() + "_" + out.length + ".png",
              local_path: marked,
              url: marked,
              prompt: prompt,
              aigc: { label: "AI 生成", tool: "gpt-image-2", model: "gpt-image-2", created_at: new Date().toISOString() }
            });
          });
        });
      });
      return chain.then(function () {
        return { success: true, images: out, prompt: prompt, balance: null, topic: req.topic || "" };
      });
    }).catch(function (e) {
      return { success: false, error: "exception", message: (e && e.message) || "生图异常" };
    });
  }

  // ============================================================
  // 图生图（二创复刻 /api/image/ref-regen）——图片是参考图不是素材
  // 对齐桌面端 app/main.py 的 _REF_REGEN_STYLES / _ref_regen_prompt：
  //   · 收 URL（前端直接拿抓图结果来用），不是让用户上传文件
  //   · 提示词强制「重绘成明显不同的画风」，不给「原样重出」留门
  //   · 标题必须绘入画面（1.0.80 胜元反馈「设置了标题但没植入」）
  // 🔴 失败绝不降级成文生图 —— 那是另一张无关的图，用户会以为二创成功。
  // ============================================================
  var REF_STYLES = {
    "手帐插画": "手帐拼贴插画风（暖色纸质感、细线条、留白呼吸感）",
    "扁平信息图": "扁平化信息图风（大色块、几何造型、清晰层级）",
    "水彩": "淡水彩风（柔和晕染、纸纹肌理、低饱和）",
    "水墨": "中式水墨风（写意笔墨、大量留白、宣纸质感）",
    "3D渲染": "3D 卡通渲染风（圆润造型、柔和光照、干净背景）",
    "商务极简": "商务极简风（克制的配色、网格排版、专业感）",
    "扁平插画": "扁平矢量插画风（明快色块、简洁造型、现代感）",
    "赛博朋克": "赛博朋克风（霓虹光效、高对比、科技氛围）",
    "复古胶片": "复古胶片风（颗粒感、暖调、轻微褪色）",
    "极简线稿": "极简线稿风（细线条、黑白为主、大量留白）",
    "国潮古风": "国潮插画风（传统纹样、浓郁配色、东方审美）",
    "日系清新": "日系清新风（淡雅色调、柔和光感、干净画面）",
    "轻度改写": "轻度改写（保留构图与画风，只调光线/清晰度/饱和度）"
  };

  function refPrompt(style, extra, title) {
    var p;
    if (String(style || "").indexOf("轻度改写") === 0) {
      p = "以参考图为依据，重新绘制一张新图：完整保留原图的构图、主体造型与整体色调倾向，" +
          "只做画面质量层面的调整——统一光线、提升清晰度、轻微调整饱和度与对比度、" +
          "弱化画面杂点与噪点。必须重新绘制为一张全新图片，不得复制原图像素。";
    } else {
      var d = REF_STYLES[style] || REF_STYLES["手帐插画"];
      p = "以参考图为依据，重新绘制一张全新的" + d + "作品：" +
          "保留原图的主题、构图与信息要点，但必须完整重绘——" +
          "不得复刻原图的笔触、细节纹理、水印、文字与品牌标识；" +
          "成品在风格上必须与原图有明显区别。";
    }
    var t = String(title || "").trim();
    if (t) {
      p += " 画面中必须把标题文字「" + t + "」完整绘入：置于画面视觉重心（上方或中部），" +
           "字号大而醒目、字重粗、与背景形成足够对比，作为这张图的主体文字；" +
           "汉字必须逐字准确清晰，不得错字、漏字、缺笔或画成乱码变形字。";
    }
    var e = String(extra || "").trim();
    if (e) p += " 额外要求：" + e;
    return p;
  }

  /* 参考图 URL → PNG data URL。
     必须走同源 /api/img 代理：微信 CDN 图要文章页 Referer，浏览器直连会被 403/CORS 拦。
     再经 canvas 统一转 PNG —— 微信封面大量是 WEBP，生图接口对 webp 支持不稳
     （桌面端同样的坑，见 main.py 的 _ref_image_normalize）。 */
  function refToPngDataUrl(url) {
    return fetch("/api/img?u=" + encodeURIComponent(url), { credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("参考图下载失败（HTTP " + r.status + "）");
        return r.blob();
      })
      .then(function (blob) {
        if (blob.size > 15 * 1024 * 1024) throw new Error("参考图超过 15MB，换一张");
        return new Promise(function (resolve, reject) {
          var im = new Image();
          im.onload = function () {
            try {
              var w = im.naturalWidth || im.width, h = im.naturalHeight || im.height;
              if (!w || !h) return reject(new Error("参考图不是有效图片"));
              var cv = document.createElement("canvas");
              cv.width = w; cv.height = h;
              cv.getContext("2d").drawImage(im, 0, 0, w, h);
              resolve(cv.toDataURL("image/png"));
            } catch (e) { reject(new Error("参考图处理失败：" + (e.message || e))); }
          };
          im.onerror = function () { reject(new Error("参考图无法解码（可能已失效）")); };
          var fr = new FileReader();
          fr.onload = function () { im.src = fr.result; };
          fr.onerror = function () { reject(new Error("参考图读取失败")); };
          fr.readAsDataURL(blob);
        });
      });
  }

  /* 提交 + 轮询（文生图/图生图共用）。返回 {ok:true, images} 或 {success:false,...} */
  function submitAndPoll(prompt, size, imageList, p) {
    var body = {
      prompt: prompt, size: size, n: 1, ticket: p.ticket,
      user_id: p.userId, images: imageList || [], async: true
    };
    return postJson("/api/gen", body, 45000, "gen-submit").then(function (sub) {
      var jobId = sub.data && sub.data.data && sub.data.data.job_id;
      if (!jobId) {
        var imgs0 = sub.data && sub.data.data && sub.data.data.images;
        if (imgs0 && imgs0.length) return { ok: true, images: imgs0 };
        refund(p.logId);
        return { success: false, error: "submit_failed",
                 message: (sub.data && sub.data.data && sub.data.data.error) || "提交失败，已退款" };
      }
      var deadline = Date.now() + 240000;
      function poll() {
        if (Date.now() > deadline) {
          refund(p.logId);
          return { success: false, error: "timeout_gen", message: "生图超时，已退款" };
        }
        return getJson("/api/gen/status", { id: jobId, user_id: p.userId }, 20000).then(function (r) {
          var st = r.data && r.data.data;
          if (!st || r.status !== 200 || st.status === "pending") {
            return new Promise(function (res) { setTimeout(function () { res(poll()); }, 2000); });
          }
          if (st.status === "ok" && st.images && st.images.length) return { ok: true, images: st.images };
          refund(p.logId);
          return { success: false, error: "gen_failed",
                   message: (st.error || "生图失败") + "，已退款" };
        });
      }
      return poll();
    });
  }

  // 图生成结果 → 桌面端契约（含 AIGC 角标）
  /* 🔴 2026-11-27：出图后必须落盘到本站 /api/img-cache。
     桌面端由 Python 后端存盘、前端用 /images/<fn> 取；网页端图只在浏览器内存里，
     而 index.html 渲染时照样写 /images/<fn> —— 不落盘就是一片裂图，
     「下载」也只能下到一个 404。落盘后文件名不变，adapter 会把 /images/ 改写成 /imgcache/。 */
  function cacheImage(filename, dataUrl) {
    return new Promise(function (res) {
      try {
        fetch("/api/img-cache", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: filename, data: dataUrl })
        }).then(function (r) { return r.json(); }).then(function (j) {
          res(j && j.ok && j.url ? j.url : "");
        }).catch(function () { res(""); });
      } catch (e) { res(""); }
    });
  }

  function toContract(r, prompt) {
    if (!r || !r.ok) return r;
    var out = [];
    var chain = Promise.resolve();
    (r.images || []).forEach(function (it) {
      chain = chain.then(function () {
        var src = it.b64 ? ("data:image/png;base64," + it.b64) : it.url;
        if (!src) return;
        return stampAiMark(src).then(function (marked) {
          var fn = "web_" + Date.now() + "_" + out.length + ".png";
          // 落盘失败不阻断出图：退回 dataURL，本次页面内能看能下，只是刷新后会丢
          return cacheImage(fn, marked).then(function (url) {
            out.push({
              filename: fn,
              local_path: url || marked, url: url || marked, prompt: prompt,
              aigc: { label: "AI 生成", tool: "gpt-image-2", model: "gpt-image-2",
                      created_at: new Date().toISOString() }
            });
          });
        });
      });
    });
    return chain.then(function () { return { success: true, images: out, prompt: prompt }; });
  }

  // 主入口 2：图生图（对齐桌面端 /api/image/ref-regen 契约）
  function generateRef(req) {
    req = req || {};
    var url = String(req.image_url || "").trim();
    if (!url) return Promise.resolve({ success: false, error: "no_image", message: "缺参考图地址" });
    var prompt = refPrompt(req.style, req.extra, req.title);
    var size = req.size || "1024x1024";
    var style = String(req.style || "手帐插画");

    return refToPngDataUrl(url).then(function (dataUrl) {
      return pay(COST, { prompt: prompt, template: "ref-regen" }).then(function (p) {
        if (!p.ok) {
          return { success: false, error: p.error, message: p.message,
                   need_login: p.error === "not_signed_in" };
        }
        return submitAndPoll(prompt, size, [dataUrl], p);
      });
    }).then(function (r) {
      return toContract(r, prompt);
    }).then(function (r) {
      if (r && r.success) {
        r.style = style;
        r.note = "已按「" + style + "」重绘为新图；原图仅作构图/信息参考，版权仍归原作者，请勿直接使用原图。";
      }
      return r;
    }).catch(function (e) {
      return { success: false, error: "ref_exception", message: (e && e.message) || "图生图异常" };
    });
  }

  window.WBGen = {
    generate: generate,
    generateRef: generateRef,
    refPrompt: refPrompt,
    refStyles: REF_STYLES,
    cost: function () { return COST; },
    buildPrompt: buildPrompt
  };
})();
