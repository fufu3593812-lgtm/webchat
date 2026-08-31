
// 终端后端地址。局域网直连: PC 局域网 IP + token(手机须连同一 WiFi)。换网络/出门须改回隧道或局域网 IP
var TERMINAL_URL = 'http://192.168.1.94:8787/?token=wt-9360dea685ca737731';
function openTerminal() { window.open(TERMINAL_URL, '_blank', 'noopener'); }



"use strict";
const $ = s => document.querySelector(s);
const THEME_VARS = [
  { v: "--bg-color", t: "背景色" },
  { v: "--bubble-left-bg", t: "对方气泡背景", color: true },
  { v: "--bubble-left-color", t: "对方气泡文字", color: true },
  { v: "--bubble-right-bg", t: "自己气泡背景", color: true },
  { v: "--bubble-right-color", t: "自己气泡文字", color: true },
  { v: "--bubble-radius", t: "气泡圆角" },
  { v: "--nav-color", t: "导航文字", color: true },
  { v: "--status-color", t: "状态文字", color: true },
  { v: "--time-color", t: "时间文字", color: true },
  { v: "--input-bg", t: "输入框背景", color: true },
  { v: "--input-border", t: "输入框描边", color: true }
];
const THEME_KEY = "webchat_theme_v2"; // v2: 默认白色 + 背景/字体进 IndexedDB
const NOTIF_KEY = "webchat_notify_v1"; // 浏览器弹窗通知开关(localStorage, "0"=关, 默认开)

const state = { active: null, contacts: [], groups: [], providers: [], view: "home", dockPage: "msg", curKind: "single", renderedIds: new Set(), sending: new Set(), typingEls: {}, deltaEls: {}, deltaTexts: {}, es: null, online: false, cfg: null, font: null, pending: null, think: false, askId: "", atBottom: true, lock: null, bellBusy: false, _lockDraft: "", activeWindow: "0", windows: [], winMap: {}, multi: false, multiSel: new Set() };
let _stkBuf = null, _stkDefault = ""; // 添加表情弹窗的暂存: base64 图 + 默认名

// ---------- 工具函数 ----------
// 日期分隔(微信式居中 pill): 今天/昨天/前天/N月N日
function fmtDay(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sd = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((sd(now) - sd(d)) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff === 2) return "前天";
  const year = d.getFullYear() === now.getFullYear() ? "" : " " + d.getFullYear();
  return (d.getMonth() + 1) + "月" + d.getDate() + "日" + year;
}
// 时间(气泡下方): AM/PM 12 小时制
function fmtTm(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + String(d.getMinutes()).padStart(2, "0") + " " + ap;
}
// 会话列表右侧时间: 今天显示 HH:MM, 昨天显示"昨天", 更早显示 M/D
function fmtConvTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sd = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((sd(now) - sd(d)) / 86400000);
  if (diff === 0) return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  if (diff === 1) return "昨天";
  return (d.getMonth() + 1) + "/" + d.getDate();
}
// 群头像兜底: 没有图就按名字hash出一个彩色圆(首字)
const GHOST_COLORS = ["#4C9AFF", "#5E8CFF", "#34C98E", "#F59E5B", "#B97FE8", "#E8728A", "#59B6E0", "#D98A3D"];
function ghostAvatar(name, size) {
  const el = document.createElement("div");
  el.className = "hav ghost";
  el.style.width = el.style.height = size + "px";
  el.style.borderRadius = Math.round(size / 4) + "px";
  const s = String(name || "群");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  el.style.background = GHOST_COLORS[h % GHOST_COLORS.length];
  el.textContent = s[0];
  return el;
}
// 头像加载失败时的兜底: 纯 SVG dataURL(名字hash色 + 首字), 永不空白
function ghostDataURL(name) {
  const s = String(name || "?");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const c = GHOST_COLORS[h % GHOST_COLORS.length];
  const ch = s[0];
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="' + c + '"/><text x="32" y="44" font-size="30" text-anchor="middle" fill="#fff" font-family="-apple-system,PingFang SC,Noto Sans KR,sans-serif" font-weight="600">' + ch + "</text></svg>";
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
function avKey(contactId, who) {
  return who === "user" ? "webchat_av_user" : "webchat_av_c_" + contactId;
}
function avatarURL(contactId, who) {
  try {
    const v = localStorage.getItem(avKey(contactId, who));
    if (v && v.indexOf("data:") === 0) return v;
  } catch (e) {}
  return "/api/chat/avatar?who=" + who + (who === "ice" ? "&contact=" + contactId : "") + "&t=" + Date.now();
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove("show"), 2400);
}
// 贴底才滚动: 用户往上翻历史时不被流式回复/新消息拽走(也省掉每块强滚的卡顿)
function scrollBottom() {
  const m = $("#msgs");
  if (m.scrollHeight - m.scrollTop - m.clientHeight < 80) { m.scrollTop = m.scrollHeight; state.atBottom = true; }
}
// 强制到底: 进会话/自己发消息时无条件滚到最新(与流式贴底守卫区分开)
function scrollBottomForce() {
  const m = $("#msgs"); m.scrollTop = m.scrollHeight; state.atBottom = true;
}
// 异步布局增长兜底: 图片/表情/自定义字体加载完会让列表变高, 此刻用户在底部就补滚到底
// (不然进会话时 scrollBottomForce 按加载前的高度滚, 图片加载后就被顶回中间); 用户翻历史时不打扰
function scrollBottomAsync() {
  if (state.atBottom) requestAnimationFrame(() => { if (state.atBottom) scrollBottomForce(); });
}
const _msgsEl = document.getElementById("msgs");
if (_msgsEl) _msgsEl.addEventListener("scroll", () => {
  const m = _msgsEl;
  state.atBottom = (m.scrollHeight - m.scrollTop - m.clientHeight < 80);
}, { passive: true });
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- IndexedDB(存背景图/字体等大文件, 避开 localStorage 配额) ----------
let _db = null;
function idbOpen() {
  return new Promise((res, rej) => {
    if (_db) return res(_db);
    const rq = indexedDB.open("webchat_store", 1);
    rq.onupgradeneeded = () => { const d = rq.result; if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv"); };
    rq.onsuccess = () => { _db = rq.result; res(_db); };
    rq.onerror = () => rej(rq.error);
  });
}
async function idbSet(k, v) { const d = await idbOpen(); return new Promise((res, rej) => { const tx = d.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function idbGet(k) { const d = await idbOpen(); return new Promise((res, rej) => { const tx = d.transaction("kv", "readonly"); const rq = tx.objectStore("kv").get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); }
async function idbDel(k) { const d = await idbOpen(); return new Promise((res, rej) => { const tx = d.transaction("kv", "readwrite"); tx.objectStore("kv").delete(k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }

// ---------- 主题系统(localStorage 存小设置 + IndexedDB 存背景/字体) ----------
function loadTheme() {
  try { return JSON.parse(localStorage.getItem(THEME_KEY)) || {}; } catch (e) { return {}; }
}
function saveThemeToLS(t) { localStorage.setItem(THEME_KEY, JSON.stringify(t)); }
function fontFaceCss(f) {
  if (!f || !f.dataURL) return "";
  const fmt = f.ext === "ttf" ? "truetype" : f.ext === "otf" ? "opentype" : f.ext === "woff" ? "woff" : "woff2";
  return "\n@font-face{font-family:'UserFont';src:url(" + f.dataURL + ") format('" + fmt + "');font-display:swap}\nbody, .bubble, input, textarea, button { font-family:'UserFont', -apple-system, 'PingFang SC', 'Noto Sans KR', 'Microsoft YaHei', 'Hiragino Sans', sans-serif !important; }";
}
function applyTheme(t, bgURL) {
  t = t || {};
  const r = document.documentElement.style;
  for (const k in (t.vars || {})) { if (t.vars[k]) r.setProperty(k, t.vars[k]); }
  if (bgURL) {
    r.setProperty("--bg-image", "url(" + bgURL + ")");
    r.setProperty("--bg-size", t.bgSize || "cover");
    r.setProperty("--bg-position", "center");
  } else {
    r.setProperty("--bg-image", "none");
    r.setProperty("--bg-size", "cover");
  }
  $("#userCss").textContent = (t.css || "") + fontFaceCss(state.font);
}
async function applyThemeAll() {
  const t = loadTheme();
  const bg = t.hasBg ? await idbGet("webchat_bg") : null;
  applyTheme(t, bg ? bg.dataURL : null);
}
async function initTheme() {
  try { state.font = await idbGet("webchat_font") || null; } catch (e) { state.font = null; }
  await applyThemeAll();
  renderThemeVars();
  // 自定义字体加载完会让文本重排(行高变化), 贴底时补滚到最新
  try { document.fonts.ready.then(scrollBottomAsync); } catch (e) {}
}
function renderThemeVars() {
  const t = loadTheme();
  const host = $("#themeVars");
  host.innerHTML = "";
  const cs = getComputedStyle(document.documentElement);
  for (const row of THEME_VARS) {
    const cur = (t.vars && t.vars[row.v]) || cs.getPropertyValue(row.v).trim() || "";
    const line = document.createElement("div");
    line.className = "tvar-row";
    const lbl = document.createElement("span"); lbl.className = "tl"; lbl.textContent = row.t;
    const txt = document.createElement("input"); txt.type = "text"; txt.value = cur;
    txt.addEventListener("input", () => { applyVarNow(row.v, txt.value); });
    line.appendChild(lbl);
    if (row.color) {
      const picker = document.createElement("input"); picker.type = "color";
      if (cur && cur.indexOf("rgb") === 0) { picker.value = rgbToHex(cur); }
      else if (/^#[0-9a-fA-F]{6}$/.test(cur)) picker.value = cur;
      picker.addEventListener("input", () => { txt.value = picker.value; applyVarNow(row.v, picker.value); });
      line.appendChild(picker);
    }
    line.appendChild(txt);
    host.appendChild(line);
  }
  $("#themeCss").value = t.css || "";
  $("#bgSizeSel").value = t.bgSize || "cover";
  $("#bgSizeSel").disabled = !t.hasBg;
  $("#fontName").textContent = state.font ? state.font.name : "未导入";
}
function rgbToHex(rgb) {
  const m = String(rgb).match(/\d+/g);
  if (!m || m.length < 3) return "#000000";
  const h = n => { const s = Number(n).toString(16); return s.length < 2 ? "0" + s : s; };
  return "#" + h(m[0]) + h(m[1]) + h(m[2]);
}
function applyVarNow(v, val) { document.documentElement.style.setProperty(v, val); }
function saveTheme() {
  const t = loadTheme();
  t.vars = t.vars || {};
  for (const row of THEME_VARS) {
    const input = Array.from(document.querySelectorAll(".tvar-row")).find(x => x.querySelector(".tl").textContent === row.t);
    if (input) t.vars[row.v] = input.querySelector('input[type=text]').value;
  }
  t.css = $("#themeCss").value;
  t.bgSize = $("#bgSizeSel").value;
  saveThemeToLS(t);
  applyThemeAll();
  toast("主题已保存");
}
async function resetTheme() {
  localStorage.removeItem(THEME_KEY);
  document.documentElement.style.cssText = "";
  $("#userCss").textContent = "";
  $("#themeCss").value = "";
  $("#bgSizeSel").value = "cover";
  renderThemeVars();
  await applyThemeAll();
  toast("已恢复默认");
}
function pickBg() {
  const input = document.createElement("input");
  input.type = "file"; input.accept = "image/*";
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast("背景图不能超过 8MB"); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const t = loadTheme();
      try { await idbSet("webchat_bg", { dataURL: String(reader.result) }); }
      catch (e) { toast("存储失败（浏览器空间不足）"); return; }
      t.hasBg = true; t.bgSize = $("#bgSizeSel").value || "cover";
      saveThemeToLS(t);
      await applyThemeAll();
      renderThemeVars();
      toast("背景图已设置");
    };
    reader.readAsDataURL(f);
  };
  input.click();
}
async function clearBg() {
  const t = loadTheme();
  try { await idbDel("webchat_bg"); } catch (e) {}
  delete t.hasBg;
  saveThemeToLS(t);
  await applyThemeAll();
  renderThemeVars();
  toast("已移除背景图");
}
function bgSizeChange(sel) {
  const t = loadTheme();
  t.bgSize = sel.value;
  saveThemeToLS(t);
  applyThemeAll();
}
function pickFont() {
  const input = document.createElement("input");
  input.type = "file"; input.accept = ".ttf,.otf,.woff,.woff2,application/font-woff,application/font-sfnt,font/ttf,font/otf,font/woff,font/woff2";
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { toast("字体文件不能超过 10MB"); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const ext = (f.name.split(".").pop() || "woff2").toLowerCase();
      const font = { name: f.name, dataURL: String(reader.result), ext };
      try { await idbSet("webchat_font", font); } catch (e) { toast("存储失败（浏览器空间不足）"); return; }
      state.font = font;
      await applyThemeAll();
      renderThemeVars();
      toast("字体已导入: " + f.name);
    };
    reader.readAsDataURL(f);
  };
  input.click();
}
async function removeFont() {
  try { await idbDel("webchat_font"); } catch (e) {}
  state.font = null;
  await applyThemeAll();
  renderThemeVars();
  toast("已移除字体");
}

// ---------- 通讯录 ----------
function openContacts() { $("#contactsDrawer").classList.add("show"); $("#scrim").classList.add("show"); }
function closeDrawers() {
  const cd = $("#contactsDrawer"); if (cd) cd.classList.remove("show");
  const dr = $("#drawer"); if (dr) dr.classList.remove("show");
  const sc = $("#scrim"); if (sc) sc.classList.remove("show");
}
async function loadContacts() {
  try {
    const r = await fetch("/api/chat/contacts");
    if (r.status === 401) return location.reload();
    const j = await r.json();
    state.contacts = j.contacts || [];
    state.groups = j.groups || [];
    state.winMap = j.activeWindow || {};
    if (!state.active && j.activeContactId) state.active = j.activeContactId;
    if (!state.active && state.contacts.length) state.active = state.contacts[0].id;
    renderContacts();
    setNav();
  } catch (e) {}
}
function renderContacts() {
  // 通讯录抽屉 + 通讯录页 共用一份渲染
  ["cList", "cListPage"].forEach(id => {
    const host = document.getElementById(id);
    if (!host) return;
    host.innerHTML = "";
    if (!state.contacts.length) {
      host.innerHTML = '<div class="empty">还没有 AI，点上面「添加」接一个</div>';
      return;
    }
    for (const c of state.contacts) {
      const item = document.createElement("div");
      item.className = "citem" + (c.id === state.active ? " on" : "");
      item.onclick = () => switchContact(c.id);
      const img = document.createElement("img");
      img.className = "cav"; img.alt = ""; img.src = avatarURL(c.id, "ice");
      const info = document.createElement("div"); info.className = "cinfo";
      const cn = document.createElement("div"); cn.className = "cn"; cn.textContent = c.name;
      const sub = document.createElement("div"); sub.className = "csub";
      sub.textContent = c.id === state.active ? (state.online ? "在线" : "离线") : "AI";
      info.appendChild(cn); info.appendChild(sub);
      const act = document.createElement("div"); act.className = "cact";
      const ed = document.createElement("button"); ed.className = "mini"; ed.textContent = "✎";
      ed.onclick = e => { e.stopPropagation(); openContactModal("edit", c.id); };
      const del = document.createElement("button"); del.className = "mini del"; del.textContent = "✕";
      del.onclick = e => { e.stopPropagation(); deleteContact(c.id); };
      act.appendChild(ed); act.appendChild(del);
      item.appendChild(img); item.appendChild(info); item.appendChild(act);
      host.appendChild(item);
    }
  });
}
// ---------- 会话列表主屏(微信式) ----------
function groupOf(id) { return state.groups.find(x => x.id === id) || null; }
// ---------- 主屏页面导航(消息/功能/设置) + 底部 dock(消息/功能/设置) ----------
const PAGE_IDS = { msg: "home", func: "funcPage", set: "settingsPage" };
function hideMainViews() {
  $("#home").classList.remove("show");
  $("#funcPage").classList.remove("show");
  $("#settingsPage").classList.remove("show");
}
function hideDock() { const d = $("#dock"); if (d) d.classList.remove("show"); }
function setDock(page) {
  const d = $("#dock"); if (!d) return;
  d.classList.add("show");
  d.querySelectorAll(".dock-item").forEach(b => b.classList.toggle("on", b.dataset.page === page));
}
async function goPage(page) {
  // 进入设置页时记住从哪来(聊天视图 or 上一个主屏页), 返回键才有地方回
  if (page === "set" && state.view !== "set") state.prevPage = state.view === "chat" ? "chat" : (state.dockPage || "msg");
  closeDrawers(); closePanels();
  state.dockPage = page;
  state.view = page === "msg" ? "home" : page;
  hideMainViews();
  $("#app").classList.remove("show");
  $("#" + PAGE_IDS[page]).classList.add("show");
  setDock(page);
  if (page === "msg") { renderConvs(); }
  else if (page === "set") { openSettingsPage(); }
  else { renderContacts(); renderMe(); loadMusicList(); }
}
function showHomeView() { goPage("msg"); }
function showChatView() {
  state.view = "chat";
  hideMainViews(); $("#app").classList.add("show");
  hideDock();
  syncLockUI();   // 锁着的话聊天页输入区换成锁条
}
async function renderMe() {
  if (!document.getElementById("meName")) return;
  $("#meName").textContent = "服服";
  $("#meSub").textContent = (state.contacts ? state.contacts.length : 0) + " 个 AI 好友 · v5";
  const cid = state.active || (state.contacts && state.contacts[0] && state.contacts[0].id) || "ice";
  try {
    const r = await fetch("/api/chat/config?contact=" + encodeURIComponent(cid));
    if (r.ok) { const c = await r.json(); if (c && c.userAvatar) { $("#meAvatar").src = avatarURL(cid, "user"); return; } }
  } catch (e) {}
  $("#meAvatar").src = avatarURL(cid, "user");
}
async function renderConvs() {
  try {
    const r = await fetch("/api/chat/conversations");
    if (r.status === 401) return location.reload();
    const j = await r.json();
    const items = j.conversations || [];
    const host = $("#hlist");
    host.innerHTML = "";
    if (!items.length) {
      host.innerHTML = '<div class="empty">还没有会话，点右上角 ＋ 拉个 AI 进群聊</div>';
      return;
    }
    const mid = state.active;
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "hitem";
      row.onclick = () => openChat(it.id, it.kind);
      let avEl;
      if (it.kind === "group" && !it.avatar) {
        avEl = ghostAvatar(it.name, 44);
      } else {
        avEl = document.createElement("img");
        avEl.className = "hav"; avEl.alt = ""; avEl.src = avatarURL(it.id, "ice");
        // 只接受真实URL, 忽略配置文件里的裸文件名(如 "ice.png" → 404)
        if (it.avatar && (it.avatar.indexOf("data:") === 0 || it.avatar.indexOf("http://") === 0 || it.avatar.indexOf("https://") === 0 || it.avatar.indexOf("/api/") === 0)) { try { avEl.src = it.avatar; } catch (e) {} }
      }
      const info = document.createElement("div"); info.className = "hinfo";
      const hn = document.createElement("div"); hn.className = "hn"; hn.textContent = it.name;
      const hl = document.createElement("div"); hl.className = "hl";
      hl.textContent = it.last ? (it.last.from && it.last.from !== "me" ? (groupOf(it.id) ? (contactName(it.last.from) + ": ") : "") + String(it.last.content).replace(/\n/g, " ") : String(it.last.content).replace(/\n/g, " ")) : (it.kind === "group" ? "群聊已创建" : "打个招呼吧");
      const ht = document.createElement("div"); ht.className = "ht"; ht.textContent = fmtConvTime(it.ts);
      if (it.id === mid && state.view === "chat") row.style.background = "color-mix(in srgb, var(--nav-color) 7%, transparent)";
      info.appendChild(hn); info.appendChild(hl);
      row.appendChild(avEl); row.appendChild(info); row.appendChild(ht);
      host.appendChild(row);
    }
  } catch (e) {}
}
function contactName(id) {
  const c = state.contacts.find(x => x.id === id);
  return c ? c.name : id;
}
function gname(g) {
  if (!g) return "群聊";
  if (g.name && String(g.name).trim()) return String(g.name).trim();
  return (g.memberIds || []).map(id => contactName(id)).join("、");
}
async function openChat(id, kind) {
  state.active = id;
  state.curKind = kind === "group" ? "group" : "single";
  state.renderedIds = new Set();
  state.typingEls = {};
  state.windows = [];
  state.activeWindow = kind === "group" ? "0" : String(state.winMap[id] || "0");
  $("#msgs").innerHTML = "";
  closeDrawers();
  showChatView();
  if (kind === "single") { try { await fetch("/api/chat/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "switch", id }) }); } catch (e) {} }
  renderContacts();
  setNav();
  await loadHistory();
}
function goHome() {
  if (state.view !== "chat") return;
  closeDrawers();
  goPage(state.dockPage || "msg");
}
async function switchContact(id) {
  await openChat(id, "single");
}
async function switchGroup(id) {
  await openChat(id, "group");
}

// ---------- 群聊创建/编辑/删除 ----------
let gmMode = "add", gmId = null;
function openGroupModal(mode, id) {
  gmMode = mode; gmId = id || null;
  const g = id ? groupOf(id) : null;
  $("#gmTitle").textContent = mode === "add" ? "新建群聊" : "编辑群聊";
  $("#gmName").value = g ? (g.name || "") : "";
  $("#gmSave").textContent = mode === "add" ? "创建" : "保存";
  const delSlot = $("#gmDelSlot"); delSlot.innerHTML = "";
  if (mode === "edit" && g) {
    const delBtn = document.createElement("button");
    delBtn.className = "btn danger small"; delBtn.textContent = "删除群聊";
    delBtn.onclick = () => { closeGroupModal(); deleteGroup(g.id); };
    delSlot.appendChild(delBtn);
  }
  renderGroupMems(g ? g.memberIds : []);
  $("#groupModal").classList.add("show");
}
function closeGroupModal() { $("#groupModal").classList.remove("show"); }
function renderGroupMems(selected) {
  const sel = new Set(selected || []);
  const host = $("#gmMems");
  host.innerHTML = "";
  for (const c of state.contacts) {
    const item = document.createElement("div");
    item.className = "gmem" + (sel.has(c.id) ? " on" : "");
    item.onclick = () => { item.classList.toggle("on"); };
    const img = document.createElement("img");
    img.className = "gmc"; img.alt = ""; img.src = avatarURL(c.id, "ice");
    const nm = document.createElement("span"); nm.textContent = c.name;
    const cb = document.createElement("input"); cb.type = "checkbox";
    cb.checked = sel.has(c.id);
    item.appendChild(img); item.appendChild(cb); item.appendChild(nm);
    host.appendChild(item);
  }
}
function selectedMembers() {
  return Array.from($("#gmMems").querySelectorAll(".gmem.on")).map(el => {
    const cb = el.querySelector("input");
    const name = el.querySelector("span").textContent;
    const c = state.contacts.find(x => x.name === name);
    return c ? c.id : cb.value;
  });
}
async function saveGroup() {
  const name = $("#gmName").value.trim();
  const members = selectedMembers();
  if (!members.length) { toast("至少要选 1 个 AI 成员"); return; }
  if (gmMode === "add" && members.length < 2) { toast("群聊至少 2 个 AI 成员"); return; }
  const body = { action: gmMode === "add" ? "add" : "edit", name, members };
  if (gmMode === "edit") body.id = gmId;
  const r = await fetch("/api/chat/group", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast((j && j.error) || "保存失败"); return; }
  closeGroupModal();
  state.groups = j.groups || state.groups;
  renderConvs();
  toast(gmMode === "add" ? "群聊已创建" : "已保存");
}
async function deleteGroup(id) {
  if (!confirm("删除这个群聊？消息也会一起清空。")) return;
  const r = await fetch("/api/chat/group", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", id })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { toast((j && j.error) || "删除失败"); return; }
  state.groups = j.groups || state.groups;
  if (state.active === id) { state.active = null; state.curKind = "single"; goHome(); }
  renderConvs(); renderContacts();
  toast("已删除");
}
function setNav() {
  if (state.curKind === "group") {
    const g = groupOf(state.active);
    $("#navName").textContent = gname(g);
    $("#navSub").textContent = (g ? g.memberIds.length : 0) + " 位成员";
    $("#groupBtn").style.display = "";
    $("#gearBtn").style.display = "none";
    return;
  }
  const c = state.contacts.find(x => x.id === state.active);
  if (c) {
    $("#navName").textContent = c.name;
    $("#lName").textContent = c.name;
    $("#lIce").src = avatarURL(c.id, "ice");
    $("#gearBtn").style.display = "";
    $("#groupBtn").style.display = "none";
  }
  updateNavSub();
}
function setStatus(ok) { state.online = ok; updateNavSub(); }
function updateNavSub() {
  if (state.active && state.sending.has(state.active)) { $("#navSub").textContent = "正在回复…"; return; }
  if (state.curKind === "group") {
    const g = groupOf(state.active);
    $("#navSub").textContent = (g ? g.memberIds.length : 0) + " 位成员";
    return;
  }
  $("#navSub").textContent = state.online ? "在线" : "离线";
}

// ---------- 消息渲染(每条消息独立头像+小时间戳, 不再合并同侧连发) ----------
// 微信式拆泡, 前缀稳定(流式增量只追加新泡、不改旧泡):
// 句尾标点(。！？!? 后还有内容)与空行(\n\n)是定界; 单换行/编号列表不拆(列表保持一个泡);
// 最多 4 个泡, 超出部分并进第 4 泡 → 长回复也不会碎成"好多气泡"
function splitBubbles(content) {
  const text = String(content || "").trim();
  if (!text) return [""];
  // 代码围栏(```)内的空行/句尾标点不做切分, 否则代码块会被拆散
  const inFenceAt = new Uint8Array(text.length);
  {
    let inF = false, pos = 0;
    for (const ln of text.split("\n")) {
      if (/^\s*```/.test(ln)) inF = !inF;
      if (inF) { for (let p = pos, e = Math.min(pos + ln.length, text.length - 1); p <= e; p++) inFenceAt[p] = 1; }
      pos += ln.length + 1;
    }
  }
  const segs = [];
  const SENT = /[。！？!?]/;
  const isWs = c => c === "\n" || c === "\r" || c === " " || c === "\t";
  const n = text.length;
  let start = 0, i = 0;
  while (i < n) {
    const c = text[i];
    if (inFenceAt[i]) { i++; continue; }
    if (SENT.test(c)) {
      let j = i;
      while (j < n && SENT.test(text[j])) j++;
      if (j < n) {                                    // 句尾标点后还有内容 → 定界
        const s = text.slice(start, j).trim();
        if (s) segs.push(s);
        start = j;
        while (start < n && isWs(text[start])) start++;
        i = start;
        continue;
      }
      i = j;                                          // 结尾的句尾标点留给末尾段
      continue;
    }
    if (c === "\n") {                                 // 空行 = 段落定界
      let j = i, nl = 0;
      while (j < n && isWs(text[j])) { if (text[j] === "\n") nl++; j++; }
      if (nl >= 2) {
        const s = text.slice(start, i).trim();
        if (s) segs.push(s);
        start = j;
        i = start;
        continue;
      }
    }
    i++;
  }
  if (start < n) {
    const s = text.slice(start).trim();
    if (s) segs.push(s);
  }
  if (segs.length > 4) {                              // 最多 4 泡, 多的并进第 4 泡
    return [segs[0], segs[1], segs[2], segs.slice(3).join("\n")];
  }
  return segs.length ? segs : [text];
}
// 富文本渲染: ```围栏``` 代码块 + 行内 `code`, 其余纯文本(DOM 构建, 无 innerHTML → 防注入)
function renderRichText(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text || "").split("\n");
  let i = 0, para = [];
  const flush = () => { if (para.length) { frag.appendChild(renderInline(para.join("\n"))); para = []; } };
  while (i < lines.length) {
    if (/^\s*```/.test(lines[i])) {
      flush();
      const lang = lines[i].replace(/^\s*```/, "").trim();
      i++;
      const codeLines = [];
      let closed = false;
      while (i < lines.length) {
        if (/^\s*```/.test(lines[i])) { closed = true; i++; break; }
        codeLines.push(lines[i]); i++;
      }
      frag.appendChild(renderCodeBlock(lang, codeLines.join("\n")));
      if (!closed) break;                    // 流式中围栏未闭合, 先这样
    } else { para.push(lines[i]); i++; }
  }
  flush();
  return frag;
}
// 聊天文字里夹的网易云歌曲链接 → 封面卡片骨架 + 异步补封面/标题/时长: 前后文字保留, 链接原地变卡片
function renderNeteaseLinks(str) {
  const re = /(?:https?:\/\/)?[a-z0-9.-]*music\.163\.com[^\s]*[?&#]id=(\d+)/gi;
  let frag = null, last = 0, mm;
  while ((mm = re.exec(str)) !== null) {
    if (!frag) frag = document.createDocumentFragment();
    if (mm.index > last) frag.appendChild(document.createTextNode(str.slice(last, mm.index)));
    const nid = mm[1];
    const m = { nid, title: "", artist: "", duration: 0, cover: "" };
    const card = buildMusicCard(m, true);
    frag.appendChild(card);
    // best-effort 补封面/标题/时长(详情接口), 失败就停在 ♪ 占位卡(点▶照样能播)
    fetch("/api/chat/musicinfo?id=" + encodeURIComponent(nid))
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d && d.ok && d.music) Object.assign(m, d.music);
        const t = card.querySelector(".mc-title");
        if (t) t.textContent = mcTitle(m);
        const s = card.querySelector(".mc-sub");
        if (s) s.textContent = mcSub(m);
        if (m.cover) {
          const cov = card.querySelector(".mc-cover");
          if (cov && cov.classList.contains("mc-cover-none")) {
            const img = document.createElement("img");
            img.className = "mc-cover";
            img.src = m.cover; img.alt = ""; img.referrerPolicy = "no-referrer"; img.loading = "lazy";
            cov.replaceWith(img);
          }
        }
        try { scrollBottomAsync(); } catch (e) {}
      })
      .catch(() => {});
    last = mm.index + mm[0].length;
  }
  if (frag && last < str.length) frag.appendChild(document.createTextNode(str.slice(last)));
  return frag;   // 没链接 → null, 调用方落纯文本
}
function renderInline(str) {
  const span = document.createElement("span");
  const parts = str.split(/`([^`]+)`/);
  parts.forEach((p, idx) => {
    if (idx % 2 === 1) {
      const c = document.createElement("code");
      c.className = "ic";
      c.textContent = p;
      span.appendChild(c);
    } else if (p) {
      const links = renderNeteaseLinks(p);
      span.appendChild(links ? links : document.createTextNode(p));
    }
  });
  return span;
}
function renderCodeBlock(lang, code) {
  const box = document.createElement("div");
  box.className = "code";
  const hd = document.createElement("div"); hd.className = "ch";
  const lg = document.createElement("span"); lg.className = "lg"; lg.textContent = lang || "代码";
  // 展开/收起: 纯符号 chevron(同思考链), 收起朝下/展开朝上, 由 .collapsed 类控制旋转
  const tgl = document.createElement("button"); tgl.className = "ct";
  const chv = document.createElement("span"); chv.className = "chev";
  tgl.appendChild(chv);
  const cp = document.createElement("button"); cp.className = "cp"; cp.textContent = "复制";
  const copy = () => {
    const t = code.replace(/\n+$/, "");
    const done = () => { cp.textContent = "已复制"; setTimeout(() => { cp.textContent = "复制"; }, 1200); };
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); ta.remove(); done();
      } catch (e) {}
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done, fallback);
    } else fallback();
  };
  cp.onclick = copy;
  hd.appendChild(lg);
  // 前端代码 → 「预览」按钮(实时渲染出效果)
  if (/^(html|htm|css|js|javascript|ts|typescript)$/i.test((lang || "").trim())) {
    const pv = document.createElement("button"); pv.className = "pv"; pv.textContent = "预览";
    pv.onclick = () => openCodePreview(code, lang);
    hd.appendChild(pv);
  }
  hd.appendChild(cp);
  // 展开/收起 toggle: 单行也支持折叠(完全折叠, 收起态只看第一行预览)
  hd.appendChild(tgl);
  tgl.onclick = () => { box.classList.toggle("collapsed"); };
  // 收起态: 只显示第一行预览(不再占满屏幕)
  const prev = document.createElement("div"); prev.className = "prev";
  prev.textContent = ((code.split("\n")[0] || "").trim() || " ").slice(0, 80);
  const pre = document.createElement("pre");
  const ce = document.createElement("code");
  ce.textContent = code;
  pre.appendChild(ce);
  box.appendChild(hd); box.appendChild(prev); box.appendChild(pre);
  box.classList.add("collapsed");   // 完全折叠: 所有代码块默认收起(含单行), 点 chevron 展开
  return box;
}
// 代码实时预览: 在弹窗 iframe 里把前端代码渲染出效果(sandbox 只放脚本, 防越权)
function openCodePreview(code, lang) {
  const l = String(lang || "").toLowerCase();
  let srcdoc;
  if (/^css/.test(l)) {
    srcdoc = '<style>' + code + '</style><div style="font-family:sans-serif;padding:16px;color:#333">纯 CSS 预览(没有 HTML 结构, 效果不一定完整)</div>';
  } else if (/^(js|javascript|ts|typescript)$/.test(l)) {
    srcdoc = '<div id="app" style="font-family:sans-serif;padding:16px;color:#333"></div><script>try{' + code + '}catch(e){document.getElementById("app").innerHTML="<span style=color:red>"+e.message+"</span>"}<\/script>';
  } else {
    srcdoc = code;   // html 等整页直接渲染
  }
  const f = document.getElementById("codePrevFrame");
  f.srcdoc = srcdoc;
  f.sandbox = "allow-scripts";
  document.getElementById("codePrevModal").classList.add("show");
}
function closeCodePreview() {
  document.getElementById("codePrevModal").classList.remove("show");
  const f = document.getElementById("codePrevFrame");
  if (f) f.srcdoc = "";
}
// 音乐卡片渲染: 主题适配封面卡片(封面缩略图+标题+歌手·时长+▶按钮), 点▶才展开官方外链播放器(auto=1), 可收起;
// 无 nid(QQ 歌) → 标题+跳转链接卡片
function fmtDur(sec) {
  if (!sec || !isFinite(sec) || sec <= 0) return "";
  const s = Math.round(sec), m = Math.floor(s / 60), ss = s % 60;
  return m + ":" + (ss < 10 ? "0" : "") + ss;
}
function mcTitle(m) { return (m && m.title ? m.title : "分享一首歌"); }
function mcSub(m) {
  const parts = [];
  if (m && m.artist) parts.push(m.artist);
  const d = fmtDur(m && m.duration);
  if (d) parts.push(d);
  return parts.join(" · ");
}
function buildMusicCard(m, inline) {
  const card = document.createElement("div");
  card.className = inline ? "music-card music-inline" : "music-card";
  if (!(m && m.nid)) {
    card.classList.add("music-qq");
    const cap = document.createElement("div"); cap.className = "music-cap";
    cap.textContent = (m && m.artist ? m.artist + " · " : "") + mcTitle(m);
    card.appendChild(cap);
    const a = document.createElement("a");
    a.href = (m && m.url) || "https://y.qq.com/";
    a.target = "_blank"; a.rel = "noopener";
    a.textContent = "在 QQ 音乐打开";
    card.appendChild(a);
    return card;
  }
  // 静置态: 封面 + 标题/歌手·时长 + ▶
  const renderRest = () => {
    card.classList.remove("music-playing");
    card.innerHTML = "";
    const row = document.createElement("div"); row.className = "mc-row";
    const cov = document.createElement(m.cover ? "img" : "div");
    cov.className = "mc-cover" + (m.cover ? "" : " mc-cover-none");
    if (m.cover) { cov.src = m.cover; cov.alt = ""; cov.referrerPolicy = "no-referrer"; cov.loading = "lazy"; }
    else cov.textContent = "♪";
    const meta = document.createElement("div"); meta.className = "mc-meta";
    const t = document.createElement("div"); t.className = "mc-title"; t.textContent = mcTitle(m);
    const s = document.createElement("div"); s.className = "mc-sub"; s.textContent = mcSub(m);
    meta.appendChild(t); meta.appendChild(s);
    const play = document.createElement("button"); play.className = "mc-play"; play.title = "播放";
    play.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72L19 12 8 5.14z"/></svg>';
    play.onclick = renderPlay;
    row.appendChild(cov); row.appendChild(meta); row.appendChild(play);
    card.appendChild(row);
  };
  // 播放态: 控制条(歌名+收起) + 官方外链播放器 iframe(auto=1 直接放)
  const renderPlay = () => {
    card.classList.add("music-playing");
    card.innerHTML = "";
    const ctl = document.createElement("div"); ctl.className = "mc-ctl";
    const name = document.createElement("div"); name.className = "mc-ctl-name";
    name.textContent = "▶ " + mcTitle(m) + (m.artist ? " · " + m.artist : "");
    const fold = document.createElement("button"); fold.className = "mc-collapse"; fold.textContent = "收起";
    fold.onclick = renderRest;
    ctl.appendChild(name); ctl.appendChild(fold);
    const pl = document.createElement("div"); pl.className = "mc-player";
    const ifr = document.createElement("iframe");
    ifr.src = "//music.163.com/outchain/player?type=2&id=" + encodeURIComponent(String(m.nid)) + "&auto=1&height=66";
    ifr.width = "100%"; ifr.height = "66"; ifr.frameBorder = "0"; ifr.scrolling = "no";
    ifr.setAttribute("allow", "autoplay");
    ifr.addEventListener("load", () => { try { scrollBottomAsync(); } catch (e) {} });
    pl.appendChild(ifr);
    card.appendChild(ctl); card.appendChild(pl);
  };
  renderRest();
  return card;
}
function musicPlayer(m) { return buildMusicCard(m, false); }

// ---------- 功能页 · 歌单 ----------
let _musicList = [];
async function loadMusicList() {
  try {
    const res = await fetch("/api/chat/music");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const d = await res.json();
    _musicList = Array.isArray(d.music) ? d.music : [];
  } catch (e) { _musicList = []; }
  const box = $("#musicList");
  if (!box) return;
  box.innerHTML = "";
  if (!_musicList.length) {
    const em = document.createElement("div");
    em.className = "music-empty";
    em.textContent = "歌单还空着，点「＋ 加歌」贴首歌";
    box.appendChild(em);
    return;
  }
  for (const s of _musicList) {
    const row = document.createElement("div");
    row.className = "music-row";
    row.appendChild(musicPlayer(s));
    const btns = document.createElement("div");
    btns.className = "music-row-btns";
    const sbtn = document.createElement("button");
    sbtn.className = "music-btn";
    sbtn.textContent = "发送到聊天";
    sbtn.onclick = () => sendMusic(s);
    const dbtn = document.createElement("button");
    dbtn.className = "music-btn";
    dbtn.textContent = "删除";
    dbtn.onclick = () => delMusic(s.id);
    btns.appendChild(sbtn); btns.appendChild(dbtn);
    row.appendChild(btns);
    box.appendChild(row);
  }
}
function toggleMusicForm(force) {
  const f = $("#musicAddForm");
  if (!f) return;
  const show = typeof force === "boolean" ? force : f.style.display === "none";
  f.style.display = show ? "flex" : "none";
  if (show) $("#musicLink").focus();
}
async function addMusic() {
  const link = ($("#musicLink").value || "").trim();
  const title = ($("#musicTitle").value || "").trim();
  const artist = ($("#musicArtist").value || "").trim();
  if (!link && !title) { toast("贴个网易云链接，或至少填个歌名"); return; }
  try {
    const res = await fetch("/api/chat/music", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link, title, artist })
    });
    const d = await res.json().catch(() => ({}));
    if (res.status === 400) { toast((d && d.error) || "加歌失败"); return; }
    if (d && d.needMeta) {
      toast("没抓到歌名，手动填一下");
      $("#musicLink").value = link;
      $("#musicTitle").focus();
      return;
    }
    $("#musicLink").value = ""; $("#musicTitle").value = ""; $("#musicArtist").value = "";
    toggleMusicForm(false);
    toast("已加入歌单 🎵");
    await loadMusicList();
  } catch (e) { toast("加歌失败: " + e.message); }
}
function sendMusic(s) {
  if (!state.active) { toast("先选一个聊天对象再发送"); return; }
  showChatView();
  send({ id: s.id, content: "🎵 " + (s.artist ? s.artist + " · " : "") + (s.title || "分享一首歌") });
}
async function delMusic(id) {
  try {
    const res = await fetch("/api/chat/music?id=" + encodeURIComponent(id), { method: "DELETE" });
    if (!res.ok) { toast("删除失败 (" + res.status + ")"); return; }
    await loadMusicList();
  } catch (e) { toast("删除失败: " + e.message); }
}

function addMessage(m) {
  if (!m || m.id == null || state.renderedIds.has(m.id)) return;
  state.renderedIds.add(m.id);
  const isMine = m.role === "user";
  const inGroup = state.curKind === "group";
  const from = inGroup ? (m.from || "") : "";
  const fromC = from && from !== "me" ? state.contacts.find(x => x.id === from) : null;
  const msgsEl = $("#msgs");
  const prevMsg = Array.from(msgsEl.children).reverse().find(el => el.classList && el.classList.contains("msg"));
  // 日期变化 → 插一条居中分隔(微信式)
  const day = fmtDay(m.ts);
  if (day && !(prevMsg && prevMsg.dataset.day === day)) {
    const dv = document.createElement("div"); dv.className = "day"; dv.textContent = day;
    msgsEl.appendChild(dv);
  }
  // 2026-08-30 服服反馈「他发消息还是连着的，只要我没回复就不是分开的」：同侧连发不再合并。
  // 之前同组连发只保留最后一条的头像/时间，唤醒连发的几条会并成一长串只有一个头像；
  // 现在每条消息都保留自己的头像+小时间戳，一眼能分出是几条。群聊里不同人本就各自带头像。
  const wrap = document.createElement("div");
  wrap.className = "msg" + (isMine ? " mine" : " ice");
  wrap.dataset.id = m.id;
  wrap.dataset.from = from;
  if (day) wrap.dataset.day = day;
  let av;
  const ghostName = isMine ? "服" : (inGroup && fromC ? fromC.name : contactName(state.active));
  const mkAv = () => {
    const img = document.createElement("img");
    img.className = "avatar"; img.alt = "";
    img.onerror = () => { try { img.src = ghostDataURL(ghostName); } catch (e) {} };
    return img;
  };
  if (inGroup && fromC) {
    av = mkAv(); av.src = avatarURL(fromC.id, "ice");
  } else {
    av = mkAv(); av.src = avatarURL(state.active, isMine ? "user" : "ice");
    av.title = "点击更换头像";
    av.onclick = () => pickAvatar(isMine ? "user" : "ice");
  }
  const col = document.createElement("div"); col.className = "col";
  if (inGroup && !isMine && fromC) {
    const nm = document.createElement("div"); nm.className = "sender"; nm.textContent = fromC.name;
    col.appendChild(nm);
  }
  // 工具调用标注(整条消息可能调了多个工具), 渲染在气泡上方
  if (!isMine && m.tools && m.tools.length) {
    const tc = document.createElement("div"); tc.className = "toolchip";
    const names = m.tools.map(t => esc(t.name || "工具")).join("、");
    tc.innerHTML = IC_TOOL + "<span>调用 " + names + "</span>";
    col.appendChild(tc);
  }
  // 碎碎念(可展开), 渲染在气泡上方
  if (!isMine && m.reasoning) {
    const tb = document.createElement("div"); tb.className = "think";
    const head = document.createElement("div"); head.className = "think-head";
    head.innerHTML = IC_THINK + "<span>碎碎念</span><i class='chev'></i>";
    const body = document.createElement("div"); body.className = "think-body";
    body.textContent = m.reasoning;
    tb.appendChild(head); tb.appendChild(body);
    head.onclick = () => tb.classList.toggle("open");
    col.appendChild(tb);
  }
  const isSticker = !!(m.image && m.sticker);   // 表情包消息: 文字泡在上 + 小图表情泡(图+名)在下
  const bubbleTexts = (m.content && !m.image) ? splitBubbles(m.content) : [m.content || ""];
  if (m.bell) {   // 门铃消息自带 🔔🐾 前缀, 改为专属小图标泡, 剥掉前导 emoji
    if (bubbleTexts[0] != null) bubbleTexts[0] = bubbleTexts[0].replace(/^[\s🔔🐾]+/, "");
  }
  if (isSticker) {
    // 文字泡单独先渲染
    if (m.content) {
      for (const bt of splitBubbles(m.content)) {
        const b = document.createElement("div");
        b.className = "bubble";
        if (bt) b.appendChild(renderRichText(bt));
        col.appendChild(b);
      }
    }
    // 表情小图泡(微信收藏表情样式, 只显示小图不放大图; 名称在发的时候已悄悄带给AI, 界面上不显示)
    const sb = document.createElement("div");
    sb.className = "bubble stick-bubble";
    const sim = document.createElement("img");
    sim.className = "stick-img"; sim.alt = ""; sim.src = m.image; sim.loading = "lazy";
    sim.onerror = () => { try { sim.src = ghostDataURL("表情"); } catch (e) {} };
    sim.onclick = () => { try { window.open(m.image, "_blank"); } catch (e) {} };
    sim.onload = scrollBottomAsync;
    sb.appendChild(sim);
    col.appendChild(sb);
  } else {
    if (m.bell) {   // 门铃消息: 前置一个 🔔 小狗爪门铃小图标泡
      const bb = document.createElement("div");
      bb.className = "bubble bell-bubble";
      bb.title = "服服按了小狗爪门铃";
      bb.innerHTML = IC_BELL;
      col.appendChild(bb);
    }
    if (m.music) {   // 音乐消息: 播放器卡片泡排在文字泡之前
      const mb = document.createElement("div");
      mb.className = "bubble music-bubble";
      mb.appendChild(musicPlayer(m.music));
      col.appendChild(mb);
    }
    for (const bt of bubbleTexts) {
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      if (m.image) {
        bubble.classList.add("hasimg");
        const im = document.createElement("img");
        im.className = "bimg"; im.alt = ""; im.src = m.image;
        im.onclick = () => { try { window.open(m.image, "_blank"); } catch (e) {} };
        im.onload = scrollBottomAsync;
        bubble.appendChild(im);
      }
      if (m.file && m.file.name) {
        const fc = document.createElement("div");
        fc.className = "bfile";
        fc.innerHTML = '<span class="ficon">' + IC_FILE + '</span><span class="fname">' + esc(m.file.name) + "</span>";
        fc.onclick = () => { try { window.open(m.file.url, "_blank"); } catch (e) {} };
        bubble.appendChild(fc);
      }
      if (bt) bubble.appendChild(renderRichText(bt));
      col.appendChild(bubble);
    }
  }
  const tm = document.createElement("div"); tm.className = "tm";
  const t = fmtTm(m.ts);
  if (t) tm.textContent = t;
  if (m.source === "wake") {
    const tag = document.createElement("span"); tag.className = "wake-tag"; tag.textContent = " · 对方发来的";
    tm.appendChild(tag);
  }
  if (tm.childNodes.length) col.appendChild(tm);
  // 删除消息(2026-08-31): 常驻 ✕ 单条删除 + 多选圈选框(整行点击切换)
  const mck = document.createElement("span"); mck.className = "mck";
  wrap.appendChild(mck);
  const del = document.createElement("button");
  del.className = "msgdel"; del.title = "删除这条消息";
  del.textContent = "✕";
  del.onclick = e => { e.stopPropagation(); e.preventDefault(); delOne(m.id); };
  wrap.appendChild(del);
  wrap.onclick = e => { if (state.multi) { e.preventDefault(); e.stopPropagation(); toggleSel(m.id, wrap); } };
  wrap.appendChild(av); wrap.appendChild(col);
  msgsEl.appendChild(wrap);
  scrollBottom();
}
async function loadHistory() {
  try {
    const inGroup = state.curKind === "group";
    const r = await fetch("/api/chat/history?contact=" + encodeURIComponent(state.active) + (inGroup ? "" : "&window=" + encodeURIComponent(state.activeWindow)));
    if (r.status === 401) return location.reload();
    const data = await r.json();
    if (!inGroup) {
      if (data.window != null) state.activeWindow = String(data.window);
      if (Array.isArray(data.windows)) state.windows = data.windows;
    }
    renderWinBar();
    (data.messages || []).forEach(addMessage);
    scrollBottomForce();   // 进会话/重连都强制停在最新消息处
  } catch (e) {}
}

// ---------- 删除消息(单条/多选批量), 2026-08-31 ----------
function toggleMulti() { state.multi ? exitMulti() : enterMulti(); }
function enterMulti() {
  state.multi = true;
  state.multiSel = new Set();
  $("#msgs").classList.add("multi");
  document.querySelectorAll("#msgs .msg.sel").forEach(w => w.classList.remove("sel"));
  $("#inputbar").style.display = "none";
  const mb = $("#multibar"); if (mb) mb.style.display = "flex";
  const b = $("#multiBtn"); if (b) b.classList.add("on");
  updateMultiCount();
}
function exitMulti() {
  state.multi = false;
  state.multiSel = new Set();
  $("#msgs").classList.remove("multi");
  document.querySelectorAll("#msgs .msg.sel").forEach(w => w.classList.remove("sel"));
  $("#inputbar").style.display = "";
  const mb = $("#multibar"); if (mb) mb.style.display = "none";
  const b = $("#multiBtn"); if (b) b.classList.remove("on");
}
function toggleSel(id, wrap) {
  if (state.multiSel.has(id)) { state.multiSel.delete(id); wrap.classList.remove("sel"); }
  else { state.multiSel.add(id); wrap.classList.add("sel"); }
  updateMultiCount();
}
function updateMultiCount() {
  const c = $("#multiCount"); if (c) c.textContent = "已选 " + state.multiSel.size + " 条";
  const b = $("#multiDelBtn"); if (b) b.disabled = !state.multiSel.size;
}
function doMultiDelete() {
  if (!state.multiSel.size) return;
  if (!confirm("确定删除选中的 " + state.multiSel.size + " 条消息吗?")) return;
  const ids = Array.from(state.multiSel);
  delMsgs(ids).then(() => exitMulti());
}
function delOne(id) {
  if (!confirm("删除这条消息?")) return;
  delMsgs([id]);
}
async function delMsgs(ids) {
  const inGroup = state.curKind === "group";
  const body = { contact: state.active, ids };
  if (!inGroup) body.window = state.activeWindow;
  let j;
  try {
    const r = await fetch("/api/chat/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.status === 401) return location.reload();
    j = await r.json().catch(() => ({}));
  } catch (e) { return toast("删除失败: " + e.message); }
  if (!j || !j.ok) return toast((j && j.error) || "删除失败");
  const idset = new Set(ids.map(Number));
  let removed = 0;
  document.querySelectorAll("#msgs .msg").forEach(w => {
    const mid = Number(w.dataset.id);
    if (idset.has(mid)) { w.remove(); removed++; state.renderedIds.delete(mid); state.multiSel.delete(mid); }
  });
  // 清理没了消息的空日期分隔(日期 pill 后不再接 .msg 就摘掉)
  document.querySelectorAll("#msgs .day").forEach(dv => {
    const nx = dv.nextElementSibling;
    if (!nx || !nx.classList.contains("msg")) dv.remove();
  });
  toast("已删除 " + (removed || j.deleted || ids.length) + " 条消息");
}

// ---------- 窗口切换条(单聊多会话线程) ----------
function renderWinBar() {
  const bar = $("#winBar"); if (!bar) return;
  if (state.curKind === "group" || state.view !== "chat") { bar.style.display = "none"; bar.innerHTML = ""; return; }
  bar.style.display = "flex";
  bar.innerHTML = "";
  const list = Array.isArray(state.windows) ? state.windows : [];
  for (const w of list) {
    const pill = document.createElement("button");
    pill.className = "winpill" + (String(w.id) === String(state.activeWindow) ? " act" : "");
    const bone = document.createElement("img");
    bone.className = "bone"; bone.src = "/dock/dock_bone.png";
    bone.alt = w.name || ("窗口" + (Number(w.id) + 1));
    pill.title = w.name || ("窗口" + (Number(w.id) + 1));
    const cnt = document.createElement("span"); cnt.className = "cnt"; cnt.textContent = (w.count || 0) + "条";
    pill.appendChild(bone); pill.appendChild(cnt);
    pill.onclick = () => switchWindow(w.id);
    attachWinMenu(pill, w);
    bar.appendChild(pill);
  }
  const add = document.createElement("button");
  add.className = "winadd"; add.textContent = "+"; add.setAttribute("aria-label", "新建窗口");
  add.onclick = addWindow;
  bar.appendChild(add);
}
function attachWinMenu(pill, w) {
  let fired = false, timer = null;
  pill.addEventListener("touchstart", ev => {
    fired = false;
    timer = setTimeout(() => { fired = true; ev.preventDefault(); openWinMenu(w, pill); }, 480);
  }, { passive: true });
  pill.addEventListener("touchend", () => { clearTimeout(timer); }, { passive: true });
  pill.addEventListener("touchmove", () => { clearTimeout(timer); }, { passive: true });
  pill.addEventListener("contextmenu", ev => { ev.preventDefault(); openWinMenu(w, pill); });
  pill.addEventListener("mousedown", ev => {
    if (ev.button === 0) { fired = false; timer = setTimeout(() => { fired = true; openWinMenu(w, pill); }, 480); }
  });
  pill.addEventListener("mouseup", () => clearTimeout(timer));
  pill.addEventListener("mouseleave", () => clearTimeout(timer));
}
function switchWindow(wid) {
  const w = String(wid);
  if (w === String(state.activeWindow)) return;
  postWindow({ action: "switch", window: w }).then(d => {
    state.activeWindow = String(d.window != null ? d.window : w);
    state.winMap[state.active] = state.activeWindow;
    state.renderedIds = new Set();
    $("#msgs").innerHTML = "";
    renderWinBar();
    loadHistory();
  }).catch(() => toast("切窗失败"));
}
async function addWindow() {
  try {
    const d = await postWindow({ action: "add" });
    state.activeWindow = String(d.window != null ? d.window : "0");
    state.winMap[state.active] = state.activeWindow;
    state.windows = d.windows || [];
    state.renderedIds = new Set();
    $("#msgs").innerHTML = "";
    renderWinBar();
    await loadHistory();
    toast("已新建窗口");
  } catch (e) { toast("新建窗口失败"); }
}
function postWindow(body) {
  body.contact = state.active;
  return fetch("/api/chat/window", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => { if (!r.ok) throw new Error("bad"); return r.json(); });
}
function renameWindow(w) {
  const nm = prompt("给这个窗口起个名字(最多12字):", w.name && String(w.name).indexOf("窗口") === 0 ? "" : (w.name || ""));
  if (nm == null) return;
  postWindow({ action: "rename", window: String(w.id), name: String(nm).trim().slice(0, 12) }).then(d => {
    state.windows = d.windows || [];
    renderWinBar();
  }).catch(() => toast("重命名失败"));
}
async function deleteWindow(w) {
  if (String(w.id) === "0") { toast("默认窗口不能删除"); return; }
  if (!confirm("删除这个窗口？窗口里的对话会清空，Ice 的记忆不受影响。")) return;
  try {
    const d = await postWindow({ action: "delete", window: String(w.id) });
    state.activeWindow = String(d.window != null ? d.window : "0");
    state.winMap[state.active] = state.activeWindow;
    state.windows = d.windows || [];
    state.renderedIds = new Set();
    $("#msgs").innerHTML = "";
    renderWinBar();
    await loadHistory();
  } catch (e) { toast("删除失败"); }
}
let _winMenu = null, _winMenuKill = null;
function openWinMenu(w, pill) {
  closeWinMenu();
  const m = document.createElement("div");
  m.className = "winmenu";
  const ren = document.createElement("button");
  ren.textContent = "✎ 重命名";
  ren.onclick = ev => { ev.stopPropagation(); closeWinMenu(); renameWindow(w); };
  m.appendChild(ren);
  if (String(w.id) !== "0") {
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "✕ 删除";
    del.onclick = ev => { ev.stopPropagation(); closeWinMenu(); deleteWindow(w); };
    m.appendChild(del);
  }
  document.body.appendChild(m);
  _winMenu = m;
  const r = pill ? pill.getBoundingClientRect() : null;
  const top = r ? Math.max(8, r.top - m.offsetHeight - 6) : 96;
  const left = r ? Math.min(window.innerWidth - m.offsetWidth - 8, Math.max(8, r.left)) : 16;
  m.style.top = top + "px"; m.style.left = left + "px"; m.style.opacity = "1";
  _winMenuKill = ev => { if (!m.contains(ev.target)) closeWinMenu(); };
  document.addEventListener("click", _winMenuKill, true);
}
function closeWinMenu() {
  if (_winMenu) { _winMenu.remove(); _winMenu = null; }
  if (_winMenuKill) { document.removeEventListener("click", _winMenuKill, true); _winMenuKill = null; }
}

// ---------- SSE 实时(renderedIds 去重, 无发送锁误伤) ----------
function connectEvents() {
  if (state.es) state.es.close();
  const es = new EventSource("/api/chat/events");
  state.es = es;
  es.onopen = () => {
    setStatus(true);
    // SSE 断连期间后台任务的 finish 可能没收到 → 发送锁残留会卡死"正在回复中"; 重连即清 stale 锁
    if (state.sending.size) { state.sending.clear(); updateNavSub(); }
    // 断连残留的流式临时气泡/打字指示: 重连后 loadHistory 会渲染正式消息, 不先清掉会重复(后台回复完成但 done 丢在断开的连接上)
    Object.keys(state.deltaEls).forEach(clearDelta);
    Object.keys(state.typingEls).forEach(k => hideTyping(state.active, k));
    renderContacts();
    if (state.view === "chat") loadHistory(); else renderConvs();
  };
  es.onerror = () => setStatus(false);
  es.onmessage = e => {
    let data; try { data = JSON.parse(e.data); } catch (_) { return; }
    if (data.type === "ai_ask") { showAskPopup(data); return; }          // AI 反问: 弹窗(任意页面都弹)
    if (data.type === "ai_ask_done") { closeAskPopup(data.askId); return; }
    if (data.type === "finish") {                                         // 回复生成完毕(后台任务 finally): 释放发送锁, 任意页面都要处理
      if (state.sending.delete(data.contactId)) updateNavSub();
      resetBell();                                                         // 门铃那一轮结束了 → 恢复可再按
      return;
    }
    if (data.type === "hello") {                                                  // 重连/刷新恢复锁条 + 活动窗口
      if (data.lock) applyLock(data.lock);
      if (data.activeWindow != null && state.curKind !== "group") state.activeWindow = String(data.activeWindow);
      return;
    }
    if (data.type === "lock") { applyLock(data); return; }                 // Ice 刚锁上: 任意页面都换成锁条
    if (data.type === "unlock") { applyUnlock(); return; }                 // Ice 解开: 锁条换回输入框
    // 弹窗通知: Ice 的回复(含 source:"wake" 主动唤醒)在任意页面都可能弹——必须在 view 守卫和 contactId 守卫之前
    if (data.type === "message" && data.message && data.message.role !== "user") {
      maybePopupNotify(data.message, data.contactId);
    }
    if (state.view !== "chat") {
      // 主屏(消息/通讯录/我的): 任何会话有新消息都刷新列表预览
      if (data.type === "message" || data.type === "cleared") renderConvs();
      return;
    }
    if (data.type === "message") {
      if (data.contactId && data.contactId !== state.active) return;
      if (data.window !== undefined && data.window !== state.activeWindow) return;   // 非活动窗口的事件不渲染(防御性——唤醒恒落活动窗口)
      if (data.message && data.message.role !== "user") clearDelta(data.memberId || "");   // 正式回复到位即替换流式临时泡(即使 done 丢失也不残留)
      addMessage(data.message);
      if (data.message && data.message.role === "user") scrollBottomForce();   // 自己的消息(多端同步/重连补渲染)也强制贴底
    } else if (data.type === "typing") {
      if (data.contactId && data.contactId !== state.active) return;
      if (data.window !== undefined && data.window !== state.activeWindow) return;   // 非活动窗口的事件不渲染(防御性——唤醒恒落活动窗口)
      showTyping(state.active, data.memberId);
    } else if (data.type === "delta") {
      if (data.contactId && data.contactId !== state.active) return;
      if (data.window !== undefined && data.window !== state.activeWindow) return;   // 非活动窗口的事件不渲染(防御性——唤醒恒落活动窗口)
      streamText(data, state.active);
    } else if (data.type === "tool") {
      if (data.contactId && data.contactId !== state.active) return;
      if (data.window !== undefined && data.window !== state.activeWindow) return;   // 非活动窗口的事件不渲染(防御性——唤醒恒落活动窗口)
      streamTool(data, state.active);
    } else if (data.type === "sticker") {
      if (data.contactId && data.contactId !== state.active) return;
      if (data.window !== undefined && data.window !== state.activeWindow) return;   // 非活动窗口的事件不渲染(防御性——唤醒恒落活动窗口)
      showLiveSticker(data, state.active);
    } else if (data.type === "done") {
      if (data.contactId && data.contactId !== state.active) return;
      if (data.window !== undefined && data.window !== state.activeWindow) return;   // 非活动窗口的事件不渲染(防御性——唤醒恒落活动窗口)
      hideTyping(state.active, data.memberId);
      clearDelta(data.memberId || "");
      if (data.message) addMessage(data.message);
    } else if (data.type === "error") {
      if (data.contactId && data.contactId !== state.active) return;
      if (data.window !== undefined && data.window !== state.activeWindow) return;   // 非活动窗口的事件不渲染(防御性——唤醒恒落活动窗口)
      hideTyping(state.active, data.memberId);
      clearDelta(data.memberId || "");
      toast(data.error || "回复失败");
    } else if (data.type === "cleared") {
      if (data.contactId && data.contactId !== state.active) return;
      if (data.window !== undefined && data.window !== state.activeWindow) return;   // 非活动窗口的事件不渲染(防御性——唤醒恒落活动窗口)
      state.renderedIds.clear(); $("#msgs").innerHTML = "";
    }
  };
}

// ---------- AI 反问弹窗(服务端广播 ai_ask → 弹窗 → 回答 POST /api/chat/answer 唤醒 AI) ----------
function showAskPopup(data) {
  document.getElementById("askQuestion").textContent = data.question || "想问你一个问题";
  const oBox = document.getElementById("askOpts");
  oBox.innerHTML = "";
  (data.options || []).forEach((o) => {
    const b = document.createElement("button");
    b.className = "opt"; b.textContent = o;
    b.onclick = () => submitAsk(o);
    oBox.appendChild(b);
  });
  state.askId = data.askId || "";
  const inp = document.getElementById("askInput");
  inp.value = "";
  document.getElementById("askMask").classList.add("show");
  setTimeout(() => { try { inp.focus(); } catch (e) {} }, 60);
}
function closeAskPopup(askId) {
  if (askId && askId !== state.askId) return;
  state.askId = "";
  document.getElementById("askMask").classList.remove("show");
}
async function submitAsk(text) {
  const t = String(text != null ? text : document.getElementById("askInput").value).trim();
  if (!t) return;
  const id = state.askId;
  closeAskPopup(id);
  try {
    await fetch("/api/chat/answer", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ askId: id, answer: t })
    });
  } catch (e) {}
}
async function skipAsk() {
  const id = state.askId;
  if (!id) return;
  closeAskPopup(id);
  try {
    await fetch("/api/chat/answer", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ askId: id, answer: "先不答" })
    });
  } catch (e) {}
}
// Enter 发送回答
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && document.getElementById("askMask").classList.contains("show")) {
    const t = document.getElementById("askInput").value.trim();
    if (t) submitAsk(t);
  }
});

// ---------- 打字三点(单聊按联系人, 群聊按成员) ----------
function showTyping(contactId, memberId) {
  if (contactId !== state.active) return;
  const key = memberId || "";
  if (state.typingEls[key]) return;
  const inGroup = state.curKind === "group";
  const mc = memberId ? state.contacts.find(x => x.id === memberId) : null;
  const wrap = document.createElement("div");
  wrap.className = "msg ice typing";
  wrap.dataset.from = memberId || "";
  const av = document.createElement("img"); av.className = "avatar"; av.alt = "";
  av.src = avatarURL(memberId || contactId, "ice");
  const col = document.createElement("div"); col.className = "col";
  if (inGroup && mc) {
    const nm = document.createElement("div"); nm.className = "sender"; nm.textContent = mc.name;
    col.appendChild(nm);
  }
  const bub = document.createElement("div"); bub.className = "bubble typing";
  bub.innerHTML = "<span></span><span></span><span></span>";
  col.appendChild(bub); wrap.appendChild(av); wrap.appendChild(col);
  $("#msgs").appendChild(wrap);
  state.typingEls[key] = bub;
  scrollBottom();
}
function hideTyping(contactId, memberId) {
  const key = memberId || "";
  const b = state.typingEls[key];
  if (b) { const w = b.closest(".msg"); if (w) w.remove(); delete state.typingEls[key]; }
}

// ---------- 流式增量(上游边生成边推, 临时气泡实时追加, done 后由 addMessage 替换为完整消息) ----------
function makeDeltaHolder(memberId) {
  const wrap = document.createElement("div");
  wrap.className = "msg ice";
  if (memberId) wrap.dataset.from = memberId;
  const av = document.createElement("img"); av.className = "avatar"; av.alt = "";
  const ghostName = memberId ? ((state.contacts.find(x => x.id === memberId) || {}).name || "Ice") : contactName(state.active);
  av.onerror = () => { try { av.src = ghostDataURL(ghostName); } catch (e) {} };
  av.src = avatarURL(memberId || state.active, "ice");
  const col = document.createElement("div"); col.className = "col";
  if (memberId) {
    const mc = state.contacts.find(x => x.id === memberId);
    if (mc) { const nm = document.createElement("div"); nm.className = "sender"; nm.textContent = mc.name; col.appendChild(nm); }
  }
  wrap.appendChild(av); wrap.appendChild(col);
  return { el: wrap, col };
}
function streamText(data, contactId) {
  const key = data.memberId || "";
  if (!state.deltaEls[key]) {
    hideTyping(contactId, data.memberId);
    state.deltaEls[key] = makeDeltaHolder(data.memberId);
    state.deltaTexts[key] = "";
    $("#msgs").appendChild(state.deltaEls[key].el);
    scrollBottom();
  }
  state.deltaTexts[key] += data.text;
  // 前缀稳定增量: 只在出现新定界时才加泡, 已存在的泡只改文本节点(不再整泡重建 → 不卡)
  const h = state.deltaEls[key];
  const col = h.col;
  let bs = col._bubbles;
  if (!bs) { bs = col._bubbles = []; }
  const segs = splitBubbles(state.deltaTexts[key]);
  while (bs.length > segs.length) { const b = bs.pop(); try { b.remove(); } catch (e) {} }
  while (bs.length < segs.length) {
    const b = document.createElement("div"); b.className = "bubble";
    b.appendChild(document.createTextNode(""));
    bs.push(b); col.appendChild(b);
  }
  for (let k = 0; k < segs.length; k++) {
    const b = bs[k];
    if (b._rich || /```/.test(segs[k]) || /`[^`\n]+`/.test(segs[k]) || /music\.163\.com[^\s]*[?&#]id=\d+/i.test(segs[k])) {   // 含围栏/行内代码或网易云歌曲链接 → 富文本重建(纯文本仍走快路径)
      b._rich = true;
      b.innerHTML = "";
      b.appendChild(renderRichText(segs[k]));
    } else {
      const tn = b.firstChild;
      if (tn && tn.nodeValue !== segs[k]) tn.nodeValue = segs[k];
    }
  }
  scrollBottom();
}
// 工具调用chip流式显示: 服务端把工具名边流边广播(tool事件) → chip 渲染进当前流式holder, 与 done 后 addMessage 的 toolchip 一致
function streamTool(data, contactId) {
  const key = data.memberId || "";
  if (!state.deltaEls[key]) {
    hideTyping(contactId, data.memberId);
    state.deltaEls[key] = makeDeltaHolder(data.memberId);
    state.deltaTexts[key] = "";
    $("#msgs").appendChild(state.deltaEls[key].el);
    scrollBottom();
  }
  const col = state.deltaEls[key].col;
  let tc = col.querySelector(".toolchip");
  if (!tc) {
    tc = document.createElement("div"); tc.className = "toolchip";
    tc.innerHTML = IC_TOOL + "<span></span>";
    col.insertBefore(tc, col.firstChild);
  }
  const nm = tc.querySelector("span");
  if (nm) nm.textContent = "调用 " + (data.name || "工具");
  scrollBottom();
}
// AI 发表情流式到位: 标记一完整服务端立刻发 sticker 事件 → 先把表情泡渲染进流式列(不等 done, 上游慢时体感快很多)
function showLiveSticker(data, contactId) {
  const key = data.memberId || "";
  if (!state.deltaEls[key]) {
    hideTyping(contactId, data.memberId);
    state.deltaEls[key] = makeDeltaHolder(data.memberId);
    state.deltaTexts[key] = "";
    $("#msgs").appendChild(state.deltaEls[key].el);
    scrollBottom();
  }
  const col = state.deltaEls[key].col;
  const sb = document.createElement("div");
  sb.className = "bubble stick-bubble live-stick";
  const sim = document.createElement("img");
  sim.className = "stick-img"; sim.alt = ""; sim.src = data.sticker.url; sim.loading = "lazy";
  sim.onerror = () => { try { sim.src = ghostDataURL("表情"); } catch (e) {} };
  sim.onload = scrollBottomAsync;
  sb.appendChild(sim);
  col.appendChild(sb);
  scrollBottom();
}
function clearDelta(key) {
  const h = state.deltaEls[key || ""];
  if (h) { try { h.el.remove(); } catch (e) {} delete state.deltaEls[key || ""]; }
  delete state.deltaTexts[key || ""];
}

// ---------- 发送(回复生成已转后台, POST 秒回; typing/delta/done 等事件全走 SSE 广播) ----------
async function send(music) {
  const inp = $("#input");
  const text = music ? music.content : inp.value.trim();
  const pend = state.pending;
  if ((!text && !pend && !music) || !state.active) return;
  const contactId = state.active;
  const inGroup = state.curKind === "group";
  if (state.sending.has(contactId)) { toast("正在回复中，请稍等"); return; }
  if (!music) inp.value = "";
  state.pending = null;
  renderAttach();
  closePanels();
  state.sending.add(contactId);
  updateNavSub();
  let accepted = false;   // POST 确认送达才算成功; 成功后台任务在生成, 发送锁保持到 SSE finish 事件才释放(切后台/断连不影响)
  try {
    const body = { contact: contactId, content: text };
    if (!inGroup) body.window = String(state.activeWindow);
    if (music) body.music = music.id;
    if (state.think) body.reasoning = 1;
    if (pend) {
      if (pend.isImage) body.image = pend.url;
      else body.file = { name: pend.name, url: pend.url, size: pend.size };
      if (pend.stickerName) body.sticker = pend.stickerName;   // 表情包名: AI 能读到
    }
    const res = await fetch("/api/chat/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (res.status === 403) {
      const d = await res.json().catch(() => ({}));
      if (d.error === "locked") {
        if (!music && inp) inp.value = text;   // 刚发的内容放回草稿(只有文本走这, music 不动输入框)
        applyLock({ until: d.until, reason: d.reason });
      } else {
        toast("发送失败 (403)");
      }
      return;
    }
    if (res.status === 409) { toast("正在回复中，请稍等"); return; }
    if (res.status === 401) { location.reload(); return; }
    if (res.status === 404) { toast("会话不存在"); return; }
    if (!res.ok) { toast("发送失败 (" + res.status + ")"); return; }
    accepted = true;
    // 秒回: 先渲染我自己的消息 + 显示 AI 打字指示; 回复事件(typing/delta/sticker/done/error)走 SSE
    const data = await res.json();
    if (data && data.message) { addMessage(data.message); scrollBottomForce(); if (!inGroup) showTyping(contactId); }
  } catch (e) {
    toast("网络错误: " + e.message);
  } finally {
    // 只在未送达时清理(送达后生成在后台, 指示器由 SSE 事件管, 锁由 finish 释放)
    if (!accepted) { state.sending.delete(contactId); updateNavSub(); hideTyping(contactId); Object.keys(state.deltaEls).forEach(clearDelta); }
  }
}

// ---------- 锁窗口 + 小狗爪门铃 ----------
function syncLockUI() {
  const lb = $("#lockbar");
  const ib = document.querySelector(".inputbar");
  if (!lb || !ib) return;
  if (state.lock) {
    lb.style.display = "flex";
    ib.style.display = "none";
    const r = $("#lockReason"), t = $("#lockTimer");
    if (r) r.textContent = state.lock.reason || "Ice 把聊天锁住了";
    tickLock();
    if (!state._lockTick) state._lockTick = setInterval(tickLock, 1000);
  } else {
    lb.style.display = "none";
    ib.style.display = "";
    if (state._lockTick) { clearInterval(state._lockTick); state._lockTick = null; }
    if (state._lockDraft) { const inp = $("#input"); if (inp) inp.value = state._lockDraft; state._lockDraft = ""; }
  }
}
function tickLock() {
  const t = $("#lockTimer");
  if (!t || !state.lock) return;
  const left = Math.max(0, (state.lock.until || 0) - Date.now());
  const m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000);
  t.textContent = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  if (left <= 0) applyUnlock();
}
function applyLock(lk) {
  if (!lk || state.lock) return;   // 已锁, 保留现有草稿
  state.lock = lk;
  const inp = $("#input");
  if (inp) { state._lockDraft = inp.value; inp.value = ""; }
  syncLockUI();
}
function applyUnlock() {
  const was = !!state.lock;
  state.lock = null;
  const lb = $("#lockbar"); if (lb) lb.style.display = "none";
  const ib = document.querySelector(".inputbar"); if (ib) ib.style.display = "";
  if (state._lockTick) { clearInterval(state._lockTick); state._lockTick = null; }
  if (state._lockDraft) { const inp = $("#input"); if (inp) inp.value = state._lockDraft; state._lockDraft = ""; }
  if (was) toast("Ice 把锁解开了");
}
async function ringBell() {
  if (state.bellBusy) return;
  const btn = $("#bellBtn");
  if (btn) { btn.disabled = true; const lbl = $("#bellLbl"); if (lbl) lbl.textContent = "按过了，等Ice…"; }
  state.bellBusy = true;
  try {
    const res = await fetch("/api/chat/bell", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (res.status === 409) { toast("Ice 正忙着，门铃等会儿再按"); resetBell(); }
    else if (res.status === 400) { toast("没被锁着"); resetBell(); }
    else if (!res.ok) { toast("按门铃失败 (" + res.status + ")"); resetBell(); }
    // 200: 保持禁用直到 finish 事件到来(那时 resetBell)
  } catch (e) { toast("网络错误: " + e.message); resetBell(); }
}
function resetBell() {
  state.bellBusy = false;
  const btn = $("#bellBtn");
  if (btn) { btn.disabled = false; const lbl = $("#bellLbl"); if (lbl) lbl.textContent = "按门铃"; }
}

// ---------- 浏览器弹窗通知(主动唤醒 source:"wake" + 普通新消息; 切后台时弹) ----------
function notifOn() { try { return localStorage.getItem(NOTIF_KEY) !== "0"; } catch (e) { return true; } }
function setNotifOn(v) { try { localStorage.setItem(NOTIF_KEY, v ? "1" : "0"); } catch (e) {} }
function askNotifyPerm() {
  if (!("Notification" in window)) { toast("此浏览器不支持系统通知"); return; }
  if (Notification.permission === "granted") { const sw = $("#sw_notify"); if (sw) sw.classList.add("on"); return; }
  Notification.requestPermission().then(p => {
    const sw = $("#sw_notify"); if (sw) sw.classList.toggle("on", p === "granted");
    if (p === "granted") { setNotifOn(true); toast("通知已开启"); }
    else if (p === "denied") toast("浏览器已拒绝通知，可在地址栏旁重新开启");
  });
}
function toggleNotify(el) {
  const on = !el.classList.contains("on");
  el.classList.toggle("on", on);
  setNotifOn(on);
  if (on) askNotifyPerm();
}
// 只在页面被切走(后台) + 开关开 + 已授权时弹; 标题固定只写「来自谁」(服服拍板, 不让类型后缀占标题); 每条消息各自弹一次
function maybePopupNotify(msg, cid) {
  try {
    if (!document.hidden) return;                     // 页面前台能看到, 不弹
    if (!notifOn()) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const wake = msg.source === "wake";
    const isGroup = cid && !!groupOf(cid);
    const name = cid ? (isGroup ? gname(groupOf(cid)) : contactName(cid)) : "Ice";
    const title = "来自 " + name;                     // 2026-08-30 服服拍板: 标题只写发送者, 不写"主动唤醒/新消息"等多余字
    const text = String(msg.content || "").replace(/\s+/g, " ").trim().slice(0, 120);
    let icon = "/dock/dock_paw.png";                  // 群聊/未知用狗爪
    if (cid && !isGroup) icon = avatarURL(cid, "ice");
    const n = new Notification(title, {
      body: text || (wake ? "Ice 想跟你说话" : "Ice 发来一条消息"),
      icon,
      // 2026-08-30 服服拍板: 一条消息一次推送, 不用 tag 合并——每个气泡各自弹一个通知
    });
    n.onclick = () => {
      try { window.focus(); n.close(); } catch (e) {}
      if (isGroup) switchGroup(cid); else switchContact(cid || "ice");
    };
  } catch (e) {}
}

// ---------- 登录 ----------
async function doLogin() {
  const r = await fetch("/api/chat/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: $("#pw").value })
  });
  if (r.ok) {
    $("#login").style.display = "none";
    await loadContacts(); connectEvents(); goPage("msg");
    if (notifOn()) askNotifyPerm();   // 登录手势里请求弹窗授权(浏览器要求用户手势)
  } else {
    $("#pwErr").textContent = "密码不对，再试一次"; $("#pw").value = ""; $("#pw").focus();
  }
}
$("#pw").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
$("#input").addEventListener("keydown", e => { if (e.key === "Enter") send(); });

// ---------- 加号面板: 发图片/发文件 + 表情包(微信式, 表情是自己存的图/GIF) ----------
function togglePanel(name) {
  const pnl = name === "emoji" ? $("#emojiPanel") : $("#plusPanel");
  const wasOpen = pnl && pnl.classList.contains("show");
  closePanels();
  if (!wasOpen && pnl) { pnl.classList.add("show"); if (name === "emoji") renderStickers(); }
}
function closePanels() { ["plusPanel", "emojiPanel"].forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove("show"); }); }

// ---------- 碎碎念开关(加号面板里, 粘性, localStorage 记忆) ----------
const IC_TOOL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M8 13l4-4 4 4"/><path d="M12 9v8"/></svg>';
const IC_THINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.9.7 1.3 1.5 1.5 2.6h4c.2-1.1.6-1.9 1.5-2.6A6 6 0 0 0 12 3z"/></svg>';
const IC_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8.5z"/><path d="M14 2.5v6h6"/></svg>';
const IC_BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
const IC_MUSIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
function toggleThink() {
  state.think = !state.think;
  const sw = document.getElementById("thinkSw");
  if (sw) sw.classList.toggle("on", state.think);
  try { localStorage.setItem("webchat_think_v1", state.think ? "1" : "0"); } catch (e) {}
}
async function renderStickers() {
  const grid = $("#stickGrid"); if (!grid) return;
  try {
    const r = await fetch("/api/chat/stickers");
    if (!r.ok) return;
    const list = (await r.json()).stickers || [];
    grid.innerHTML = "";
    const add = document.createElement("div");
    add.className = "stick-cell stick-add";
    add.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    add.title = "添加表情"; add.onclick = () => pickSticker();
    grid.appendChild(add);
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "stick-empty"; empty.textContent = "还没有表情，点 ＋ 从相册添加";
      grid.appendChild(empty);
    }
    list.forEach(s => {
      const cell = document.createElement("div");
      cell.className = "stick-cell";
      const im = document.createElement("img");
      im.src = s.url; im.alt = ""; im.loading = "lazy";
      im.onerror = () => cell.remove();
      cell.appendChild(im);
      const sn = document.createElement("div");
      sn.className = "sn"; sn.textContent = s.name || "";
      cell.appendChild(sn);
      cell.onclick = () => sendSticker(s);
      const del = document.createElement("span");
      del.className = "stick-del"; del.textContent = "✕";
      del.onclick = ev => { ev.stopPropagation(); delSticker(s); };
      cell.appendChild(del);
      grid.appendChild(cell);
    });
  } catch (e) {}
}
function sendSticker(s) {
  state.pending = { url: s.url, name: s.name || "表情", isImage: true, stickerName: s.name || "" };
  closePanels();
  send();
}
function pickSticker() { closePanels(); $("#fileStick").click(); }
async function delSticker(s) {
  if (!confirm("删除这个表情？")) return;
  const r = await fetch("/api/chat/sticker/" + encodeURIComponent(s.id), { method: "DELETE" });
  toast(r.ok ? "已删除" : "删除失败");
  renderStickers();
}
function addSticker(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast("表情不能超过 8MB"); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const b64 = String(reader.result).split(",")[1] || "";
    _stkBuf = b64;
    _stkDefault = (file.name || "").replace(/\.[^.]+$/, "") || "表情";
    const pv = $("#stickPreview"); if (pv) pv.src = reader.result;
    const nm = $("#stickName"); if (nm) { nm.value = _stkDefault; nm.focus(); nm.select(); }
    const m = $("#stickNameModal"); if (m) m.classList.add("show");
  };
  reader.readAsDataURL(file);
}
async function confirmStickerName() {
  const nm = ($("#stickName").value || "").trim();
  if (!nm) { toast("给表情起个名字吧"); return; }
  if (!_stkBuf) { toast("图片读取失败"); return; }
  try {
    const r = await fetch("/api/chat/sticker", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: _stkBuf, name: nm }) });
    const j = await r.json();
    if (!j.ok) { toast(j.error || "添加失败"); return; }
    _stkBuf = null; closeStickerName();
    toast("已添加表情");
    renderStickers();
  } catch (e) { toast("添加失败: " + e.message); }
}
function closeStickerName() {
  _stkBuf = null;
  const m = $("#stickNameModal"); if (m) m.classList.remove("show");
}
function pickImg() { closePanels(); $("#fileImg").click(); }
function pickFile() { closePanels(); $("#fileDoc").click(); }
function handleAttach(file, isImage) {
  if (!file) return;
  const max = isImage ? 8 * 1024 * 1024 : 20 * 1024 * 1024;
  if (file.size > max) { toast(isImage ? "图片不能超过 8MB" : "文件不能超过 20MB"); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const b64 = String(reader.result).split(",")[1] || "";
      const r = await fetch("/api/chat/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: b64, name: file.name }) });
      const j = await r.json();
      if (!j.ok) { toast(j.error || "上传失败"); return; }
      state.pending = { url: j.url, name: j.name, isImage: j.isImage !== false, size: j.size };
      renderAttach();
      toast("已选择，点发送即可");
    } catch (e) { toast("上传失败: " + e.message); }
  };
  reader.readAsDataURL(file);
}
function renderAttach() {
  const row = $("#attachRow"); if (!row) return;
  row.innerHTML = "";
  const p = state.pending;
  if (!p) { row.style.display = "none"; return; }
  row.style.display = "flex";
  const chip = document.createElement("div");
  chip.className = "attach-chip";
  if (p.isImage) {
    const im = document.createElement("img"); im.src = p.url; im.alt = "";
    chip.appendChild(im);
  } else {
    const ic = document.createElement("span"); ic.textContent = "📄";
    chip.appendChild(ic);
  }
  const nm = document.createElement("span"); nm.className = "an"; nm.textContent = p.name || (p.isImage ? "图片" : "文件");
  chip.appendChild(nm);
  const x = document.createElement("span"); x.className = "ax"; x.textContent = "✕";
  x.onclick = () => { state.pending = null; renderAttach(); };
  chip.appendChild(x);
  row.appendChild(chip);
}
$("#fileImg").addEventListener("change", e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) handleAttach(f, true); closePanels(); });
$("#fileDoc").addEventListener("change", e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) handleAttach(f, false); closePanels(); });
$("#fileStick").addEventListener("change", e => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) addSticker(f); });

// ---------- 联系人增删改 ----------
let cmMode = "add", cmId = null;
async function openContactModal(mode, id) {
  cmMode = mode; cmId = id || null;
  $("#cmTitle").textContent = mode === "add" ? "添加 AI" : "编辑联系人";
  const delSlot = $("#cmDelSlot"); delSlot.innerHTML = "";
  await loadProviders();
  renderCmpProviders();
  if (mode === "edit") {
    const c = state.contacts.find(x => x.id === id);
    $("#cmName").value = c ? c.name : "";
    // 预填按被编辑的联系人拉最新配置(不依赖 state.cfg, 避免显示旧值)
    loadContactForm(id);
    const delBtn = document.createElement("button");
    delBtn.className = "btn danger small"; delBtn.textContent = "删除";
    delBtn.onclick = () => { closeContactModal(); deleteContact(id); };
    delSlot.appendChild(delBtn);
  } else {
    $("#cmName").value = ""; $("#cmPersona").value = ""; $("#cmUrl").value = ""; $("#cmKey").value = ""; $("#cmModel").value = "";
    cmApplyProvider("");   // 自定义, 恢复可填
  }
  $("#cmModelStatus").textContent = ""; $("#cmModelList").innerHTML = "";
  const sel = $("#cmModelSel"); sel.style.display = "none"; sel.innerHTML = "";
  $("#contactModal").classList.add("show");
}
// 上游下拉: 选项 + 按已选状态锁定地址/密钥/模型
function renderCmpProviders() {
  const sel = $("#cmProviderSel"); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">自定义（自己填下面）</option>';
  for (const p of (state.providers || [])) {
    const o = document.createElement("option"); o.value = p.id; o.textContent = p.name;
    sel.appendChild(o);
  }
  sel.value = cur || "";
}
function cmApplyProvider(pid) {
  const p = (state.providers || []).find(x => x.id === pid);
  const url = $("#cmUrl"), key = $("#cmKey"), model = $("#cmModel");
  if (p) {
    url.value = p.apiUrl; key.value = p.apiKey; model.value = p.model;
    url.disabled = true; key.disabled = true; model.disabled = true;
  } else {
    url.disabled = false; key.disabled = false; model.disabled = false;
  }
}
function cmProviderChanged(sel) { cmApplyProvider(sel.value); }
async function loadContactForm(id) {
  try {
    const r = await fetch("/api/chat/config?contact=" + encodeURIComponent(id));
    if (r.status === 401) return location.reload();
    const cfg = await r.json();
    $("#cmPersona").value = cfg.persona || "";
    $("#cmProviderSel").value = cfg.providerId || "";
    cmApplyProvider(cfg.providerId || "");
    if (!cfg.providerId) {
      $("#cmUrl").value = cfg.apiUrl || "";
      $("#cmKey").value = cfg.apiKey || "";
      $("#cmModel").value = cfg.model || "";
    }
  } catch (e) {
    const cfg = state.cfg;
    $("#cmPersona").value = (cfg && cfg.persona) || "";
    $("#cmProviderSel").value = (cfg && cfg.providerId) || "";
    cmApplyProvider((cfg && cfg.providerId) || "");
    if (!(cfg && cfg.providerId)) {
      $("#cmUrl").value = (cfg && cfg.apiUrl) || "";
      $("#cmKey").value = (cfg && cfg.apiKey) || "";
      $("#cmModel").value = (cfg && cfg.model) || "";
    }
  }
}
function closeContactModal() { $("#contactModal").classList.remove("show"); }

async function fetchModels() {
  const url = $("#cmUrl").value.trim();
  if (!url) { toast("先填接口地址"); return; }
  const btn = $("#cmFetchBtn"), st = $("#cmModelStatus"), sel = $("#cmModelSel");
  btn.disabled = true; st.textContent = "拉取中…";
  try {
    const r = await fetch("/api/chat/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiUrl: url, apiKey: $("#cmKey").value.trim() }) });
    const j = await r.json();
    if (!j.ok) { st.textContent = ""; toast(j.error || "拉取失败"); return; }
    $("#cmModelList").innerHTML = "";
    j.models.forEach(m => { const o = document.createElement("option"); o.value = m; $("#cmModelList").appendChild(o); });
    sel.innerHTML = "";
    j.models.forEach(m => { const o = document.createElement("option"); o.value = m; o.textContent = m; sel.appendChild(o); });
    sel.style.display = j.models.length ? "" : "none";
    st.textContent = j.models.length ? "共 " + j.models.length + " 个模型，选中后自动填入" : "上游没返回模型，试试直接填模型名";
  } catch (e) {
    st.textContent = ""; toast("拉取失败: " + e.message);
  } finally {
    btn.disabled = false;
  }
}
async function saveContact() {
  const name = $("#cmName").value.trim();
  if (!name) { toast("名字不能为空"); return; }
  const pid = $("#cmProviderSel").value || "";
  const url = $("#cmUrl").value.trim();
  const body = {
    action: cmMode === "add" ? "add" : "edit",
    name,
    persona: $("#cmPersona").value,
    providerId: pid,
    // 选了共享上游 → 地址/密钥/模型用上游的, 联系人字段留空回退
    apiUrl: pid ? "" : url,
    apiKey: pid ? "" : $("#cmKey").value.trim(),
    model: pid ? "" : $("#cmModel").value.trim()
  };
  if (cmMode === "edit") body.id = cmId;
  const r = await fetch("/api/chat/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "保存失败"); return; }
  closeContactModal();
  await loadContacts();
  // 编辑的是当前活跃联系人 → 刷新 state.cfg, 避免重开弹窗/设置页显示旧值
  if (cmMode === "edit" && cmId === state.active && state.curKind !== "group") await loadCfg();
  if (cmMode === "add") await openChat(j.id, "single");
  toast(cmMode === "add" ? "已添加" : "已保存");
}
async function deleteContact(id) {
  if (!confirm("删除这个联系人？对话记录会一起清掉。")) return;
  const r = await fetch("/api/chat/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "删除失败"); return; }
  const wasActive = state.active === id;
  if (wasActive) { state.active = null; state.curKind = "single"; }
  await loadContacts();
  if (wasActive) { goHome(); } else { state.renderedIds = new Set(); $("#msgs").innerHTML = ""; await loadHistory(); }
  toast("已删除");
}

// ---------- 设置(整页) ----------
async function openSettings() {
  goPage("set");
}
function backFromSettings() {
  if (state.view !== "set") return;
  closeDrawers(); closePanels();
  if (state.prevPage === "chat") { showChatView(); }
  else goPage(state.prevPage || "msg");
}
// 从别的入口直达某个分区(如功能页曾经的快捷入口), 展开并滚动过去
function openSettingsSection(id) {
  openSettings();
  const el = document.getElementById(id);
  if (el) {
    if (!el.classList.contains("open")) toggleSec(id);
    setTimeout(() => { try { el.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {} }, 80);
  }
}
function openAvatarTab() { openSettingsSection("subAvatar"); }
function openThemeTab() { openSettingsSection("secTheme"); }
function openWorldTab() { openSettingsSection("subWorld"); }
function openMemTab() { openSettingsSection("secMem"); }
function openCtxTab() { openSettingsSection("subCtx"); }
function openToolsTab() { openSettingsSection("secTools"); }
function toggleSec(id) { const el = document.getElementById(id); if (el) el.classList.toggle("open"); }
function toggleSub(id) { const el = document.getElementById(id); if (el) el.classList.toggle("open"); }
// 进入设置页: 拉当前联系人配置 + 渲染用量/来源
async function openSettingsPage() {
  await loadCfg();
  renderThemeVars();
  renderUsage();
  renderProviders();
  const nsw = $("#sw_notify"); if (nsw) nsw.classList.toggle("on", notifOn());
}
// ---------- 用量(token) + 来源(共享上游池) ----------
function fmtTokens(n) { n = n || 0; if (n >= 10000) return (n / 1000).toFixed(1) + "k"; return String(n); }
function hostOf(u) { try { return new URL(u || "").host; } catch (e) { return "未知"; } }
function maskKey(k) { k = k || ""; if (k.length <= 8) return "••••"; return k.slice(0, 4) + "••••" + k.slice(-4); }
async function renderUsage() {
  const ub = document.getElementById("usageBox");
  if (!ub) return;
  let u = null;
  try {
    const r = await fetch("/api/chat/usage");
    if (r.status === 401) return location.reload();
    u = await r.json();
  } catch (e) {}
  if (!u) { ub.innerHTML = '<div class="hint">用量加载失败</div>'; return; }
  const all = u.all || {}, today = u.today || {};
  ub.innerHTML =
    '<div class="ustat"><span class="k">今日消耗</span><span class="v">' + fmtTokens(today.prompt) + ' in · ' + fmtTokens(today.completion) + ' out</span></div>' +
    '<div class="ustat"><span class="k">累计消耗</span><span class="v">' + fmtTokens(all.prompt) + ' in · ' + fmtTokens(all.completion) + ' out</span></div>' +
    '<div class="hint" style="margin-top:10px">余额要供应商支持才查得到，不支持会如实标注。</div>';
}
async function loadProviders() {
  try {
    const r = await fetch("/api/chat/providers");
    if (r.status === 401) return location.reload();
    const j = await r.json();
    state.providers = (j && j.providers) || [];
  } catch (e) {}
}
async function renderProviders() {
  await loadProviders();
  const pb = document.getElementById("provBox");
  if (!pb) return;
  if (!state.providers.length) {
    pb.innerHTML = '<div class="hint">还没有上游。点上方「＋ 添加上游」登记一个，添加联系人时就能直接选。</div>';
    return;
  }
  const byPid = p => (state.contacts || []).filter(c => c.providerId === p.id);
  pb.innerHTML = state.providers.map(p => {
    const names = byPid(p).map(c => esc(c.name)).join("、") || "（未接入联系人）";
    return '<div class="prov" data-id="' + esc(p.id) + '">' +
      '<div class="ph"><span class="dot" style="background:#53d769"></span><span>' + esc(p.name) + '</span>' +
      '<span style="margin-left:auto" class="pm">' + esc(hostOf(p.apiUrl)) + '</span></div>' +
      '<div class="pm">' + esc(p.apiUrl || "默认地址") + '</div>' +
      '<div class="pm">模型：' + esc(p.model || "（上游默认）") + ' · 密钥：' + esc(maskKey(p.apiKey)) + '</div>' +
      '<div class="pm">接入：' + names + '</div>' +
      '<div class="pm" data-role="bal"></div>' +
      '<div class="prow" style="display:flex;gap:8px;margin-top:2px">' +
      '<button class="btn small" data-act="bal">查余额</button>' +
      '<button class="btn small" data-act="edit">编辑</button>' +
      '<button class="btn small danger" data-act="del">删除</button>' +
      '</div>' +
      '</div>';
  }).join("");
  pb.onclick = e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const card = b.closest(".prov");
    const id = card.getAttribute("data-id");
    if (b.getAttribute("data-act") === "bal") queryBalance(b, id);
    else if (b.getAttribute("data-act") === "edit") openProviderModal("edit", id);
    else if (b.getAttribute("data-act") === "del") deleteProvider(id);
  };
}
async function queryBalance(btn, pid) {
  const card = btn.closest(".prov");
  const line = card.querySelector('[data-role="bal"]');
  btn.disabled = true; btn.textContent = "查询中…";
  try {
    const r = await fetch("/api/chat/balance?provider=" + encodeURIComponent(pid));
    const j = await r.json();
    if (j && j.supported) line.textContent = "余额：" + j.balance + " " + (j.currency || "");
    else line.textContent = "该上游不支持余额查询";
  } catch (e) { line.textContent = "查询失败"; }
  btn.disabled = false; btn.textContent = "查余额";
}
// ---------- 上游 弹层 ----------
let pmMode = "add", pmId = null;
function openProviderModal(mode, id) {
  pmMode = mode; pmId = id || null;
  $("#pmTitle").textContent = mode === "add" ? "添加上游" : "编辑上游";
  if (mode === "edit") {
    const p = (state.providers || []).find(x => x.id === id);
    $("#pmName").value = p ? p.name : "";
    $("#pmUrl").value = p ? p.apiUrl : "";
    $("#pmKey").value = p ? p.apiKey : "";
    $("#pmModel").value = p ? p.model : "";
  } else {
    $("#pmName").value = ""; $("#pmUrl").value = ""; $("#pmKey").value = ""; $("#pmModel").value = "";
  }
  $("#providerModal").classList.add("show");
}
function closeProviderModal() { $("#providerModal").classList.remove("show"); }
async function saveProvider() {
  const name = $("#pmName").value.trim();
  const apiUrl = $("#pmUrl").value.trim();
  if (!name) { toast("名字不能为空"); return; }
  if (!apiUrl) { toast("接口地址不能为空"); return; }
  const body = {
    action: pmMode === "add" ? "add" : "edit",
    name,
    apiUrl,
    apiKey: $("#pmKey").value.trim(),
    model: $("#pmModel").value.trim()
  };
  if (pmMode === "edit") body.id = pmId;
  const r = await fetch("/api/chat/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "保存失败"); return; }
  closeProviderModal();
  await renderProviders();
  toast(pmMode === "add" ? "已添加上游" : "已保存");
}
async function deleteProvider(id) {
  const p = (state.providers || []).find(x => x.id === id);
  if (!confirm("删除上游「" + (p ? p.name : "") + "」？使用它的联系人会退回各自手动填写的地址，或默认地址。")) return;
  const r = await fetch("/api/chat/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "删除失败"); return; }
  await loadContacts();  // 服务器已清引用联系人的 providerId, 刷新列表让「接入」栏同步
  await renderProviders();
  toast("已删除");
}
// ---------- 备份与恢复 ----------
async function exportBackup() {
  try {
    const r = await fetch("/api/chat/export");
    if (r.status === 401) return location.reload();
    const j = await r.json();
    const blob = new Blob([JSON.stringify(j, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "webchat-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    const n = j.messages ? Object.keys(j.messages).length : 0;
    toast("已导出 " + n + " 个会话");
  } catch (e) { toast("导出失败"); }
}
async function importBackup(fileInput) {
  const f = fileInput.files && fileInput.files[0];
  fileInput.value = "";
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch (e) { toast("文件不是有效的 JSON"); return; }
  if (!confirm("导入会覆盖当前的联系人与聊天记录，确定继续？")) return;
  try {
    const r = await fetch("/api/chat/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const j = await r.json();
    if (!j.ok) { toast(j.error || "导入失败"); return; }
    state.active = null;
    await loadContacts();
    renderConvs();
    toast("导入完成");
  } catch (e) { toast("导入失败"); }
}
async function loadCfg() {
  // 设置都是按联系人, 群聊/无活跃时回退到第一个联系人
  if (state.curKind === "group" || !state.contacts.some(c => c.id === state.active)) {
    const first = state.contacts.find(c => c.id && c.id[0] !== "g");
    if (!first) return;
    state.active = first.id; state.curKind = "single";
  }
  const r = await fetch("/api/chat/config?contact=" + encodeURIComponent(state.active));
  if (r.status === 401) return location.reload();
  const c = await r.json();
  state.cfg = c;
  $("#curContactName").textContent = c.name || state.active;
  $("#persona").value = c.persona || "";
  $("#iceAvatarBig").src = avatarURL(state.active, "ice");
  $("#userAvatarBig").src = avatarURL(state.active, "user");
  renderMemories();
  renderWorldbook();
  renderCustomTools();
  $("#maxContextTokens").value = c.context.maxContextTokens;
  $("#maxOutputTokens").value = c.context.maxOutputTokens;
  $("#historyWindow").value = c.context.historyWindow;
  $("#toolIterations").value = c.context.toolIterations;
  $("#worldBookScan").value = c.context.worldBookScan;
  $("#worldBookCap").value = c.context.worldBookCap;
  ["get_time", "get_weather", "write_diary", "remember", "recall"].forEach(k => {
    const el = $("#sw_" + k); if (el) el.classList.toggle("on", !!c.tools[k]);
  });
}
async function saveSettings() {
  const body = {
    contact: state.active,
    persona: $("#persona").value,
    context: {
      maxContextTokens: +$("#maxContextTokens").value || 16000,
      maxOutputTokens: +$("#maxOutputTokens").value || 1024,
      historyWindow: +$("#historyWindow").value || 60,
      toolIterations: +$("#toolIterations").value || 4,
      worldBookScan: +$("#worldBookScan").value || 20,
      worldBookCap: +$("#worldBookCap").value || 1500
    }
  };
  const r = await fetch("/api/chat/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  toast(r.ok ? "设置已保存" : "保存失败");
}
async function changePassword() {
  const oldPw = $("#oldPw").value, nextPw = $("#nextPw").value;
  if (!oldPw || !nextPw) { toast("请填写原密码和新密码"); return; }
  const r = await fetch("/api/chat/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ old: oldPw, next: nextPw }) });
  const j = await r.json();
  toast(j.ok ? "密码已修改" : (j.error || "修改失败"));
  if (j.ok) { $("#oldPw").value = ""; $("#nextPw").value = ""; }
}
async function logout() { await fetch("/api/chat/logout", { method: "POST" }); location.reload(); }
async function clearChat() {
  if (!confirm("确定清空当前联系人的全部对话记录？")) return;
  await fetch("/api/chat/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contact: state.active }) });
  state.renderedIds.clear(); $("#msgs").innerHTML = "";
  toast("已清空");
}

// 头像(存 localStorage 快照 + 同步服务器; 点击即可更换)
function pickAvatar(who) { $("#file" + (who === "ice" ? "Ice" : "User")).click(); }
async function onFile(who, input) {
  const f = input.files && input.files[0];
  input.value = "";
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) { toast("图片不能超过 8MB"); return; }
  const reader = new FileReader();
  reader.onload = async () => {
    const dataURL = String(reader.result);
    const b64 = dataURL.split(",")[1] || "";
    try { localStorage.setItem(avKey(state.active, who), dataURL); } catch (e) {}
    refreshAvatars();
    const r = await fetch("/api/chat/avatar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contact: state.active, who, data: b64 }) });
    const j = await r.json();
    if (j.ok) {
      toast((who === "ice" ? "对方" : "服服") + "头像已更换");
      renderContacts();
    } else {
      toast(j.error || "同步到服务器失败（本机已生效）");
    }
  };
  reader.readAsDataURL(f);
}
function refreshAvatars() {
  $("#iceAvatarBig").src = avatarURL(state.active, "ice");
  $("#userAvatarBig").src = avatarURL(state.active, "user");
  $("#lIce").src = avatarURL(state.active, "ice");
  renderContacts();
}

// 记忆
function renderMemories() {
  const list = $("#memList");
  if (!state.cfg.memories.length) { list.innerHTML = '<div class="empty">还没有记忆，先记一条吧</div>'; return; }
  list.innerHTML = "";
  state.cfg.memories.forEach((mem, i) => {
    const item = document.createElement("div");
    item.className = "mem-item";
    item.innerHTML = '<div class="tx">' + esc(mem.text) + '<div class="dt">' + esc(mem.date || "") + '</div></div>';
    const del = document.createElement("button");
    del.className = "btn small danger"; del.textContent = "删";
    del.onclick = () => delMemory(i);
    item.appendChild(del);
    list.appendChild(item);
  });
}
async function addMemory() {
  const t = $("#memText").value.trim();
  if (!t) return;
  const r = await fetch("/api/chat/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", text: t, contact: state.active }) });
  const j = await r.json();
  if (j.ok) { state.cfg.memories.push({ text: t, date: new Date().toISOString().slice(0, 10) }); renderMemories(); $("#memText").value = ""; toast("已记住"); }
  else toast(j.error || "失败");
}
async function delMemory(i) {
  await fetch("/api/chat/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", index: i, contact: state.active }) });
  state.cfg.memories.splice(i, 1); renderMemories();
}

// 世界书
function renderWorldbook() {
  const list = $("#wbList");
  if (!state.cfg.worldbook.length) { list.innerHTML = '<div class="empty">还没有世界书条目</div>'; return; }
  list.innerHTML = "";
  state.cfg.worldbook.forEach(wb => {
    const item = document.createElement("div");
    item.className = "wb-item";
    item.innerHTML =
      '<div class="hd"><span class="nm">' + esc(wb.name || wb.id) + '</span>' +
      (wb.constant ? '<span class="tag">常驻</span>' : '') +
      '<span style="flex:1"></span>' +
      '<button class="btn small danger">删</button></div>' +
      (wb.keys && wb.keys.length ? '<div class="ks">触发：' + esc(wb.keys.join("，")) + '</div>' : '') +
      '<div class="cn">' + esc(wb.content) + '</div>';
    item.querySelector("button").onclick = () => delWorldbook(wb.id);
    list.appendChild(item);
  });
}
async function addWorldbook() {
  const name = $("#wbName").value.trim();
  const keys = $("#wbKeys").value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
  const content = $("#wbContent").value.trim();
  if (!content) { toast("内容不能为空"); return; }
  // 守卫: 没关键词又没开常驻 → 世界书永远不会注入(命中文案或常驻才进上下文), 2026-08-31
  if (!keys.length && !$("#wbConstSw").classList.contains("on")) {
    toast("提示: 没填关键词又没开「常驻」,Ice 永远读不到这条(建议二选一)");
    if (!confirm("仍然添加吗? 不加关键词也不常驻的话这条世界书等于没用")) return;
  }
  const r = await fetch("/api/chat/worldbook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", name, keys, content, constant: $("#wbConstSw").classList.contains("on"), contact: state.active }) });
  const j = await r.json();
  if (j.ok) {
    state.cfg.worldbook = j.worldbook; renderWorldbook();
    $("#wbName").value = ""; $("#wbKeys").value = ""; $("#wbContent").value = ""; $("#wbConstSw").classList.remove("on");
    toast("已添加");
  } else toast(j.error || "失败");
}
async function delWorldbook(id) {
  const r = await fetch("/api/chat/worldbook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id, contact: state.active }) });
  const j = await r.json();
  if (j.ok) { state.cfg.worldbook = j.worldbook; renderWorldbook(); }
}

// 工具开关
async function toggleTool(k, el) {
  el.classList.toggle("on");
  if (!state.cfg) state.cfg = {};
  state.cfg.tools = state.cfg.tools || {};
  state.cfg.tools[k] = el.classList.contains("on");
  await fetch("/api/chat/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contact: state.active, tools: state.cfg.tools }) });
}

// 自定义工具(MCP / HTTP, 列表行: 名字+徽标 左, 测试/删除/开关 右)
function renderCustomTools() {
  const list = $("#ctList");
  if (!state.cfg.customTools || !state.cfg.customTools.length) { list.innerHTML = '<div class="empty">还没有自定义工具</div>'; return; }
  list.innerHTML = "";
  state.cfg.customTools.forEach(ct => {
    const item = document.createElement("div");
    item.className = "row ct-row";
    const left = document.createElement("div"); left.style.minWidth = "0";
    const nm = document.createElement("div"); nm.className = "rl";
    const nmTxt = document.createElement("span"); nmTxt.className = "ct-nm"; nmTxt.textContent = ct.name;
    nmTxt.title = ct.url || "";
    const badge = document.createElement("span");
    badge.className = "badge " + (ct.protocol === "mcp" ? "mcp" : ct.protocol === "post" ? "http" : "none");
    badge.textContent = ct.protocol === "mcp" ? "MCP · " + (ct.toolCount || "?") + " 工具" : ct.protocol === "post" ? "HTTP" : "未连接";
    if (ct.protocol === "mcp" && ct.toolNames && ct.toolNames.length) badge.title = ct.toolNames.join("、");
    nm.appendChild(nmTxt); nm.appendChild(badge);
    left.appendChild(nm);
    if (ct.description) { const d = document.createElement("div"); d.className = "ks"; d.textContent = ct.description; left.appendChild(d); }
    if (ct.auth) { const a = document.createElement("div"); a.className = "ks"; a.style.color = "#C0504A"; a.textContent = "⚠ " + ct.auth; left.appendChild(a); }
    const right = document.createElement("div"); right.className = "cacts";
    const test = document.createElement("button"); test.className = "btn small"; test.textContent = "测试";
    test.onclick = () => testCustomTool(ct.id);
    const del = document.createElement("button"); del.className = "btn small danger"; del.textContent = "删";
    del.onclick = () => delCustom(ct.id);
    const sw = document.createElement("span"); sw.className = "switch" + (ct.enabled ? " on" : "");
    sw.onclick = () => toggleCustom(ct, sw);
    right.appendChild(test); right.appendChild(del); right.appendChild(sw);
    item.appendChild(left); item.appendChild(right);
    list.appendChild(item);
  });
}
async function testCustomTool(id) {
  const r = await fetch("/api/chat/customtool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test", id, contact: state.active }) });
  const j = await r.json();
  if (j.ok && j.customTools) { state.cfg.customTools = j.customTools; renderCustomTools(); }
  const t = j.test;
  if (t && t.protocol === "mcp") toast(t.auth ? ("MCP " + t.toolCount + " 个工具，但未认证：" + t.auth) : ("连接成功：MCP " + t.toolCount + " 个工具"));
  else if (t && t.protocol === "post") toast("连接成功：HTTP 接口");
  else toast("连接失败：" + ((t && t.error) || j.error || "无法访问"));
}
async function addCustomTool() {
  const name = $("#ctName").value.trim();
  const url = $("#ctUrl").value.trim();
  const description = $("#ctDesc").value.trim();
  const paramsHint = $("#ctHint").value.trim();
  const token = $("#ctToken").value.trim();
  if (!name) { toast("工具名不能为空"); return; }
  if (!url) { toast("接口地址不能为空"); return; }
  const r = await fetch("/api/chat/customtool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", name, url, description, paramsHint, token, contact: state.active }) });
  const j = await r.json();
  if (!j.ok) { toast(j.error || "失败"); return; }
  state.cfg.customTools = j.customTools; renderCustomTools();
  $("#ctName").value = ""; $("#ctDesc").value = ""; $("#ctUrl").value = ""; $("#ctHint").value = ""; $("#ctToken").value = "";
  const t = j.test;
  toast(t && t.protocol === "mcp" ? "已添加：MCP " + t.toolCount + " 个工具" : t && t.protocol === "post" ? "已添加：HTTP 接口" : "已添加（" + ((t && t.error) || "连接待测") + "）");
}
async function toggleCustom(ct, el) {
  el.classList.toggle("on");
  const r = await fetch("/api/chat/customtool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "edit", id: ct.id, enabled: el.classList.contains("on"), contact: state.active }) });
  const j = await r.json();
  if (j.ok) state.cfg.customTools = j.customTools; else el.classList.toggle("on");
}
async function delCustom(id) {
  if (!confirm("删除这个自定义工具？")) return;
  const r = await fetch("/api/chat/customtool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id, contact: state.active }) });
  const j = await r.json();
  if (j.ok) { state.cfg.customTools = j.customTools; renderCustomTools(); }
}

// ---------- 诊断面板(hash=#diag 时弹出, 收集真实设备几何, 平时不可见) ----------
(function () {
  function probe(which) {
    try {
      var d = document.createElement("div");
      d.style.cssText = "position:fixed;" + which + ":0;left:0;width:1px;height:env(safe-area-inset-" + which + ");visibility:hidden;pointer-events:none";
      document.body.appendChild(d);
      var v = d.getBoundingClientRect().height;
      d.remove();
      return Math.round(v);
    } catch (e) { return -1; }
  }
  function showDiag() {
    var shown = document.querySelector(".home.show") || document.querySelector(".app.show") || document.querySelector(".page.show") || document.querySelector(".login");
    var rect = function (el) { return el ? el.getBoundingClientRect() : null; };
    var root = document.documentElement, vv = window.visualViewport;
    var fr = shown ? shown.querySelector(".head-frost") : null;
    var tb = shown ? shown.querySelector(".topbar") : null;
    var frR = rect(fr), tbR = rect(tb), shR = rect(shown);
    var L = [];
    function p(k, v) { L.push("<div>" + k + " = <b>" + v + "</b></div>"); }
    p("standalone", navigator.standalone === true ? "true(PWA)" : (navigator.standalone ? String(navigator.standalone) : "false(浏览器)"));
    p("display-mode", matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser");
    p("dpr", window.devicePixelRatio);
    p("inner", window.innerWidth + "x" + window.innerHeight);
    p("outerHeight", window.outerHeight);
    p("html.clientHeight", root.clientHeight);
    p("html.offsetHeight", root.offsetHeight);
    p("body.scrollHeight", document.body.scrollHeight);
    p("vv.height", vv.height + " offsetTop=" + vv.offsetTop + " scale=" + (vv.scale || 1));
    p("screen", screen.width + "x" + screen.height + " availH=" + screen.availHeight);
    p("safe-top", probe("top") + "px");
    p("safe-bottom", probe("bottom") + "px");
    p("当前页", shown ? shown.id : "none");
    if (shR) p("页面 top/H", Math.round(shR.top) + " / " + Math.round(shR.height));
    if (frR) p("head-frost top,left,W,H", Math.round(frR.top) + " , " + Math.round(frR.left) + " , " + Math.round(frR.width) + " , " + Math.round(frR.height));
    if (tbR) p(".topbar top,H", Math.round(tbR.top) + " / " + Math.round(tbR.height));
    var cs = getComputedStyle(document.body);
    p("body bg", cs.backgroundColor + (cs.backgroundImage !== "none" ? " img" : ""));
    var box = document.createElement("div");
    box.setAttribute("data-diag", "1");
    box.style.cssText = "position:fixed;z-index:99999;top:8px;left:8px;right:8px;background:rgba(20,20,20,.93);color:#8cffa0;font:11px/1.6 Menlo,monospace;padding:10px 12px;border-radius:12px;overflow:auto;max-height:78%";
    document.querySelectorAll("[data-diag]").forEach(function (b) { b.remove(); });
    box.innerHTML = "<div style='font-weight:bold;color:#fff;margin-bottom:6px'>DIAG <button onclick='this.parentNode.parentNode.remove()' style='float:right;background:#333;color:#fff;border:none;border-radius:6px;padding:2px 8px'>✕</button></div>" + L.join("");
    document.body.appendChild(box);
  }
  var _t = null;
  function check() {
    if (location.hash === "#diag") {
      showDiag();
      clearTimeout(_t);
      _t = setTimeout(showDiag, 1200); // 等 init 完成/login 显示后再重测一次真实几何
    }
  }
  window.addEventListener("hashchange", check);
  check();
})();

// ---------- 初始化 ----------
(async function init() {
  // PWA: 注册 Service Worker(iOS 16.4+ 可安装硬性要求; 静默失败不影响聊天功能)
  if ("serviceWorker" in navigator) { navigator.serviceWorker.register("/sw.js").catch(() => {}); }
  await initTheme();
  // 碎碎念开关状态从 localStorage 恢复
  try { state.think = localStorage.getItem("webchat_think_v1") === "1"; } catch (e) {}
  const sw0 = document.getElementById("thinkSw"); if (sw0) sw0.classList.toggle("on", state.think);
  $("#lIce").onclick = () => pickAvatar("ice");
  try {
    const s = await (await fetch("/api/chat/session")).json();
    if (s.loggedIn) {
      $("#login").style.display = "none";
      await loadContacts(); connectEvents();
      // 每次进入页面直接进上次的会话, 停在最新消息处(没有历史就回通讯录主屏)
      if (state.active) { await openChat(state.active, "single"); }
      else { $("#home").classList.add("show"); renderConvs(); }
    } else {
      $("#login").style.display = "flex"; $("#lIce").src = avatarURL("ice", "ice"); $("#lName").textContent = "Ice";
      $("#pw").focus();
    }
  } catch (e) { $("#login").style.display = "flex"; }
})();
