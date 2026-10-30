/*
 * Restaurant chat widget (framework-free). Embed on any page (WordPress/Elementor "HTML" widget works):
 *   <script src="https://api.example.com/widget/chat-widget.js" data-api="https://api.example.com"
 *           data-key="wk_..." data-title="Restaurant name" data-lang="en|ar" data-color="#1f6feb" defer></script>
 * The page's origin must be in the widget key's allowed origins. All text is inserted with textContent,
 * never innerHTML, so nothing a customer or the model writes can run as HTML or script.
 *
 * Optional attributes: data-lang (en or ar; defaults to the page's <html lang>, then en),
 * data-color (a #rrggbb brand colour), data-title (header text).
 */
(function () {
  "use strict";
  var script = document.currentScript;
  var api = (script && script.dataset.api || "").replace(/\/+$/, "");
  var key = script && script.dataset.key || "";
  if (!api || !/^wk_[A-Za-z0-9_-]{32}$/.test(key)) { console.error("chat-widget: data-api and a valid data-key are required"); return; }

  var TEXT = {
    en: {
      title: "Chat with us", open: "Open chat", close: "Close chat", send: "Send", placeholder: "Type your message", label: "Message",
      hello: "Hi! Ask me about our menu, prices, opening hours or location.",
      notice: "AI assistant. Please do not share personal or payment details. For allergies and anything urgent, call the restaurant.",
      call: "Call ", closed: "This conversation was closed.",
      e_origin: "Chat is not available on this website.", e_rate: "You're sending messages too fast. Please wait a moment.",
      e_full: "This conversation is full. Please reload to start a new one.", e_ai: "I'm having trouble right now. Please try again in a moment.",
      e_net: "Can't reach the chat service. Check your connection and try again.", e_other: "Something went wrong. Please try again."
    },
    ar: {
      title: "تحدث معنا", open: "فتح المحادثة", close: "إغلاق المحادثة", send: "إرسال", placeholder: "اكتب رسالتك", label: "الرسالة",
      hello: "مرحباً! اسألني عن القائمة والأسعار وساعات العمل والموقع.",
      notice: "مساعد ذكي. يرجى عدم مشاركة بيانات شخصية أو بيانات الدفع. للحساسية الغذائية وأي أمر عاجل، اتصل بالمطعم.",
      call: "اتصل ", closed: "تم إغلاق هذه المحادثة.",
      e_origin: "المحادثة غير متاحة على هذا الموقع.", e_rate: "ترسل الرسائل بسرعة كبيرة. يرجى الانتظار قليلاً.",
      e_full: "اكتملت هذه المحادثة. يرجى إعادة تحميل الصفحة لبدء محادثة جديدة.", e_ai: "أواجه مشكلة حالياً. يرجى المحاولة بعد قليل.",
      e_net: "تعذر الاتصال بخدمة المحادثة. تحقق من الاتصال وحاول مجدداً.", e_other: "حدث خطأ ما. يرجى المحاولة مرة أخرى."
    }
  };
  var lang = (script.dataset.lang || document.documentElement.lang || "en").toLowerCase().slice(0, 2);
  var t = TEXT[lang] || TEXT.en;
  var rtl = lang === "ar";
  var title = script.dataset.title || t.title;
  var color = /^#[0-9a-fA-F]{6}$/.test(script.dataset.color || "") ? script.dataset.color : "#1f6feb";
  var REQUEST_TIMEOUT_MS = 30000;

  var storeKey = "chat-session:" + key;
  var token = null;
  try { token = sessionStorage.getItem(storeKey); } catch (e) { /* storage blocked: session lasts until reload */ }
  var busy = false, ended = false;

  var host = document.createElement("div");
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    '<style>' +
    ':host{all:initial;--c:' + color + '}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}' +
    '.btn{position:fixed;inset-inline-end:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:0;background:var(--c);color:#fff;font-size:24px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3);z-index:2147483000}' +
    '.box{position:fixed;inset-inline-end:20px;bottom:88px;width:340px;max-width:calc(100vw - 40px);height:460px;max-height:calc(100vh - 110px);background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;z-index:2147483000}' +
    '.box.open{display:flex}.head{background:var(--c);color:#fff;padding:12px 14px;font-weight:600;display:flex;align-items:center;justify-content:space-between;gap:8px}' +
    '.x{background:transparent;border:0;color:#fff;font-size:20px;line-height:1;cursor:pointer;padding:0 4px}' +
    '.log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f6f8fa}' +
    '.m{max-width:85%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word;font-size:14px;line-height:1.4}' +
    '.u{align-self:flex-end;background:var(--c);color:#fff}.a{align-self:flex-start;background:#fff;border:1px solid #d0d7de;color:#1f2328}' +
    '.s{align-self:center;color:#57606a;font-size:12px;text-align:center}' +
    '.n{padding:6px 12px;font-size:11px;color:#57606a;background:#fff;border-top:1px solid #d0d7de;text-align:center}' +
    '.t{align-self:center;color:var(--c);font-size:13px;font-weight:600;text-decoration:none;border:1px solid var(--c);border-radius:16px;padding:5px 12px;background:#fff}' +
    'form{display:flex;border-top:1px solid #d0d7de}input{flex:1;border:0;padding:12px;font-size:14px;outline:none;min-width:0}' +
    'form button{border:0;background:#fff;color:var(--c);font-weight:600;padding:0 14px;cursor:pointer}form button:disabled,input:disabled{opacity:.5;cursor:default}' +
    'button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--c);outline-offset:2px}' +
    '@media (prefers-reduced-motion:no-preference){.box.open{animation:p .15s ease-out}@keyframes p{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}}' +
    '</style>' +
    '<button class="btn" type="button">\u{1F4AC}</button>' +
    '<div class="box" role="dialog"><div class="head"><span class="title"></span><button class="x" type="button">\u00D7</button></div>' +
    '<div class="log" aria-live="polite"></div><div class="n"></div>' +
    '<form><input maxlength="1000" autocomplete="off"><button type="submit"></button></form></div>';
  host.setAttribute("dir", rtl ? "rtl" : "ltr");
  document.body.appendChild(host);

  var btn = root.querySelector(".btn"), box = root.querySelector(".box"), log = root.querySelector(".log"), closeBtn = root.querySelector(".x");
  var form = root.querySelector("form"), input = root.querySelector("input"), sendBtn = root.querySelector("form button");
  root.querySelector(".title").textContent = title;
  root.querySelector(".n").textContent = t.notice;
  btn.setAttribute("aria-label", t.open); box.setAttribute("aria-label", title); closeBtn.setAttribute("aria-label", t.close);
  input.setAttribute("placeholder", t.placeholder); input.setAttribute("aria-label", t.label); sendBtn.textContent = t.send;

  function scroll() { log.scrollTop = log.scrollHeight; }
  function add(cls, text) {
    var d = document.createElement("div");
    d.className = "m " + cls; d.setAttribute("dir", "auto"); d.textContent = text;
    log.appendChild(d); scroll(); return d;
  }
  // The number comes from the server and is re-validated here before it is placed in a tel: link.
  function callLink(phone) {
    if (!/^\+?\d{5,20}$/.test(phone || "")) return;
    var a = document.createElement("a"); a.className = "t"; a.href = "tel:" + phone; a.textContent = t.call + phone; a.setAttribute("dir", "ltr");
    log.appendChild(a); scroll();
  }
  function note(text) { var d = document.createElement("div"); d.className = "s"; d.textContent = text; log.appendChild(d); scroll(); }
  function lock(v) { busy = v; input.disabled = v || ended; sendBtn.disabled = v || ended; }
  function setOpen(open) {
    box.classList.toggle("open", open);
    if (open) { if (log.childElementCount === 0) add("a", t.hello); input.focus(); } else { btn.focus(); }
  }

  // Every request has a timeout so a stalled connection never leaves the customer waiting forever.
  function call(path, body, auth) {
    var headers = { "Content-Type": "application/json" };
    if (auth) headers.Authorization = "Bearer " + auth;
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, REQUEST_TIMEOUT_MS) : null;
    return fetch(api + "/v1/chat/" + key + path, { method: "POST", headers: headers, body: JSON.stringify(body || {}), signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; }); })
      .finally(function () { if (timer) clearTimeout(timer); });
  }
  function ensureSession() {
    if (token) return Promise.resolve(token);
    return call("/sessions").then(function (r) {
      if (r.status !== 201) throw r;
      token = r.body.sessionToken;
      try { sessionStorage.setItem(storeKey, token); } catch (e) { /* ignore */ }
      return token;
    });
  }
  function errorText(r) {
    if (!r || !r.body) return t.e_net;
    var code = r.body.error && r.body.error.code;
    if (code === "origin_not_allowed") return t.e_origin;
    if (code === "rate_limited") return t.e_rate;
    if (code === "conversation_limit") return t.e_full;
    if (code === "ai_unavailable") return t.e_ai;
    return t.e_other;
  }
  function send(text, retried) {
    lock(true);
    var pending = retried ? null : add("u", text);
    ensureSession().then(function (tk) { return call("/messages", { message: text }, tk); }).then(function (r) {
      if (r.status === 401 && !retried) { token = null; try { sessionStorage.removeItem(storeKey); } catch (e) { /* ignore */ } return send(text, true); }
      if (r.status === 200) {
        add("a", r.body.message);
        if (r.body.type === "contact") { callLink(r.body.contactPhone); }
      } else { note(errorText(r)); if (pending && r.status === 409) { ended = true; note(t.closed); } }
      lock(false); if (!ended) input.focus();
    }).catch(function (r) { note(errorText(r)); lock(false); });
  }

  btn.addEventListener("click", function () { setOpen(!box.classList.contains("open")); });
  closeBtn.addEventListener("click", function () { setOpen(false); });
  root.addEventListener("keydown", function (e) { if (e.key === "Escape" && box.classList.contains("open")) setOpen(false); });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy || ended) return;
    input.value = ""; send(text, false);
  });
})();
