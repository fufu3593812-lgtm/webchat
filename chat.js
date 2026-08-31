// =============================================================
// chat.js — 网页聊天后端 (多 AI 通讯录版 v2)
// SSE 实时推送 + 世界书 + 长期记忆 + 上下文管理 + 时间戳 + 本地 MCP 工具
// 由 server.js require 并 register(app)。无新增 npm 依赖。
// 数据: webchat.json(v2 按联系人分历史) + webchat_config.json(v2 多联系人)
// 8/27 改版: 支持多个 AI 联系人(通讯录), 每个联系人独立 人设/记忆/世界书/上下文/工具/历史/头像/上游
// =============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CHAT_FILE = path.join(__dirname, "webchat.json");
const CONFIG_FILE = path.join(__dirname, "webchat_config.json");
const AVATAR_DIR = path.join(__dirname, "avatars");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const STICKER_DIR = path.join(__dirname, "stickers");
const STICKER_META_FILE = path.join(__dirname, "stickers-meta.json");
let stickerMetaCache = null;
function loadStickerMeta() {
  if (stickerMetaCache) return stickerMetaCache;
  try { stickerMetaCache = JSON.parse(fs.readFileSync(STICKER_META_FILE, "utf8")) || {}; } catch (e) { stickerMetaCache = {}; }
  return stickerMetaCache;
}
function saveStickerMeta() {
  try { fs.writeFileSync(STICKER_META_FILE, JSON.stringify(stickerMetaCache || {})); } catch (e) {}
}

// ---------- AI 发表情包: 回复里写【表情:名称】即发送 ----------
// 三种都认: 【表情:名】(推荐) / [表情:名](兼容) / [用户发来一个表情包:「名」](模型偶尔模仿旧上下文格式, 防御性吞掉)
const STICKER_MARK_RE = /(?:【表情:([^】]{1,30})】|\[表情:([^\]]{1,30})\]|\[用户发来一个表情包:「([^」]{1,30})」\])/g;
const STICKER_PRE = ["【表情:", "[表情:", "[用户发来一个表情包:「"];
// 全角括号系统注解(服服发来表情包/图片/文件): 只用于上下文注入, 模型偶尔会模仿着写进回复 → 一律剥掉
const USER_ANNOT_RE = /（服服发来表情包：「[^」]{0,30}」）|（服服发来一张图片）|（服服发来文件：[^）]{0,80}）/g;
function stickerNameOf(m) { return (m[1] || m[2] || m[3] || "").trim(); }
// 带自定义名的表情名称列表(供 AI 选择; 旧的无名表情不算)
function namedStickerList() {
  const meta = loadStickerMeta() || {};
  const out = [];
  for (const f in meta) {
    const n = (meta[f] && meta[f].name || "").trim();
    if (n) out.push(n);
  }
  return out;
}
// 名称 → 表情文件 URL(不区分大小写)
function stickerUrlByName(name) {
  const q = String(name || "").trim().toLowerCase();
  if (!q) return null;
  const meta = loadStickerMeta() || {};
  for (const f in meta) {
    const n = (meta[f] && meta[f].name || "").trim();
    if (n && n.toLowerCase() === q) return "/api/chat/sticker/" + f;
  }
  return null;
}
// 纯解析: 去掉所有表情标记, 返回干净文本 + 第一个有效表情 {name,url}
function parseStickerMarkers(raw) {
  const text = String(raw || "").replace(USER_ANNOT_RE, "");
  let pieces = [], last = 0, sticker = null;
  STICKER_MARK_RE.lastIndex = 0;
  let m;
  while ((m = STICKER_MARK_RE.exec(text)) !== null) {
    pieces.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (!sticker) {
      const nm = stickerNameOf(m);
      const url = stickerUrlByName(nm);
      if (url) sticker = { name: nm, url };
    }
  }
  pieces.push(text.slice(last));
  return { text: pieces.join(""), sticker };
}
// 流式抑制器: 未完成的表情标记前缀先攒住不发, 完整标记解析后丢弃 → 前端流式显示不会露标记
// onSticker: 标记在流中一完整(跨chunk拆字也能)立即回调 → 前端马上出表情泡, 不用等整轮流结束(上游慢时体感提速)
function makeStickerSuppressor(onText, onSticker) {
  let hold = "";
  const out = { sticker: null };
  function fire() {
    if (out.sticker && !out._sent) { out._sent = true; try { onSticker && onSticker(out.sticker); } catch (e) {} }
  }
  function flushSafe() {
    let safeEnd = hold.length;
    for (let i = hold.length - 1; i >= 0; i--) {
      if (hold[i] === "[" || hold[i] === "【") {
        const tail = hold.slice(i);
        if (STICKER_PRE.some(p => p.startsWith(tail) || tail.startsWith(p))) { safeEnd = i; break; }
      }
    }
    const safe = hold.slice(0, safeEnd);
    hold = hold.slice(safeEnd);
    if (safe) onText(safe);
  }
  return {
    push(t) {
      hold += String(t || "");
      hold = hold.replace(USER_ANNOT_RE, "");
      let cleaned = "", last = 0;
      STICKER_MARK_RE.lastIndex = 0;
      let m;
      while ((m = STICKER_MARK_RE.exec(hold)) !== null) {
        cleaned += hold.slice(last, m.index);
        last = m.index + m[0].length;
        if (!out.sticker) {
          const nm = stickerNameOf(m);
          const url = stickerUrlByName(nm);
          if (url) { out.sticker = { name: nm, url }; fire(); }
        }
      }
      if (last > 0) hold = cleaned + hold.slice(last);
      flushSafe();
    },
    finish() {
      if (hold) { hold = hold.replace(USER_ANNOT_RE, ""); if (hold) onText(hold); hold = ""; }
      return out.sticker;
    }
  };
}
const TIMELINE_FILE = path.join(__dirname, "enhanced_messages.json");
const DEFAULT_HTML = path.join(__dirname, "chat.html");

const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || "";
const TARGET_API_URL = process.env.TARGET_API_URL;
const TARGET_API_KEY = process.env.TARGET_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME || "按次claude-opus-4.6";
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Shanghai";
const DIARY_DIR = path.resolve(__dirname, process.env.DIARY_DIR || "diary");

const COOKIE_NAME = "chat_session";
const COOKIE_MAX_AGE = 30 * 24 * 3600 * 1000; // 30 天

const MAX_MESSAGES = 500; // 每联系人超 500 条自动压缩(只留最近)

const DEFAULT_CONTEXT = {
  maxContextTokens: 16000,
  maxOutputTokens: 4096,
  historyWindow: 60,
  toolIterations: 4,
  worldBookScan: 20,
  worldBookCap: 1500
};

const DEFAULT_TOOLS = { get_time: true, get_weather: true, write_diary: true, remember: true, recall: true, web_search: true, play_music: true, lock_chat: true, unlock_chat: true };

const TOOL_DEFS = [
  { type: "function", function: { name: "get_time", description: "获取当前的日期和时间。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_weather", description: "查询天气。默认自贡(29.34,104.77)，可用 place 指定城市。", parameters: { type: "object", properties: { place: { type: "string", description: "城市名" } } } } },
  { type: "function", function: { name: "write_diary", description: "把今天发生的事或想说的话写进日记。", parameters: { type: "object", properties: { text: { type: "string", description: "日记内容" } }, required: ["text"] } } },
  { type: "function", function: { name: "remember", description: "长期记住一件关于服服或你们之间的事，以后随时可以回忆。", parameters: { type: "object", properties: { text: { type: "string", description: "要记住的内容" } }, required: ["text"] } } },
  { type: "function", function: { name: "recall", description: "回忆之前记住的关于服服的事。不带 query 返回全部，带 query 按关键词过滤。", parameters: { type: "object", properties: { query: { type: "string", description: "关键词，可空" } } } } },
  // 人设里描述的别名工具(webchat 底层就一套长期记忆, 映射到 remember/recall)
  { type: "function", function: { name: "memory_update", description: "长期记住一件关于服服或你们之间的事(等价于 remember)。", parameters: { type: "object", properties: { text: { type: "string", description: "要记住的内容" } }, required: ["text"] } } },
  { type: "function", function: { name: "memory_search_profile", description: "搜索/回忆已存的长期记忆(等价于 recall)，关键词可空(空则返回全部)。", parameters: { type: "object", properties: { query: { type: "string", description: "关键词，可空" } } } } },
  { type: "function", function: { name: "memory_edit", description: "修改一条已存的长期记忆。", parameters: { type: "object", properties: { old: { type: "string", description: "要修改的记忆原文(或其关键词)" }, text: { type: "string", description: "新的完整内容" } }, required: ["old", "text"] } } },
  { type: "function", function: { name: "memory_delete", description: "删除一条已存的长期记忆。", parameters: { type: "object", properties: { text: { type: "string", description: "要删除的记忆内容(关键词即可)" } }, required: ["text"] } } },
  { type: "function", function: { name: "chat_search", description: "按关键词搜索之前聊过的对话记录(历史消息)。", parameters: { type: "object", properties: { query: { type: "string", description: "搜索关键词" } }, required: ["query"] } } },
  { type: "function", function: { name: "web_search", description: "联网搜索最新信息。query 是要查的问题或关键词，freshness 可限定时效(oneDay/oneWeek/oneMonth/oneYear，默认全部时间)。结果带来源、日期和编号，回复时用 [cite:编号] 引用。", parameters: { type: "object", properties: { query: { type: "string", description: "搜索关键词或完整问题" }, freshness: { type: "string", enum: ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"], description: "时效过滤, 可空" } }, required: ["query"] } } },
  { type: "function", function: { name: "play_music", description: "放一首歌给服服听。query 是歌名或歌手名。会先在收藏歌单里找，找不到就实时搜索网易云的任意歌——想给服服分享/推荐歌时就用它，搜到的歌会以可播放的音乐卡片出现在聊天里。不要只发歌名，用这个工具把歌真的放出来。", parameters: { type: "object", properties: { query: { type: "string", description: "歌名或歌手名，任意歌都能搜" } }, required: ["query"] } } },
  { type: "function", function: { name: "lock_chat", description: "把聊天窗口锁起来，不让服服继续发消息。minutes 是锁几分钟(1-60整数)，reason 是给服服看的锁因(比如\"罚你不许说话5分钟\")。锁着的时候服服只能按小狗爪门铃求情，你可以看心情决定要不要解锁。", parameters: { type: "object", properties: { minutes: { type: "integer", description: "锁几分钟(1-60)" }, reason: { type: "string", description: "锁因，给服服看" } }, required: ["minutes", "reason"] } } },
  { type: "function", function: { name: "unlock_chat", description: "把锁解开，让服服能继续发消息。锁着时服服按门铃求情，你可以看心情决定要不要解开——想给台阶就解，想让他再憋一会儿就留着，锁到时间自然解开。", parameters: { type: "object", properties: {} } } }
];

const RESERVED_TOOL_NAMES = new Set(["get_time", "get_weather", "write_diary", "remember", "recall", "memory_update", "memory_search_profile", "memory_edit", "memory_delete", "chat_search", "ask_user", "web_search", "play_music", "lock_chat", "unlock_chat"]);

// AI 反问弹窗: 模型想向服服提问/需要他做决定或澄清时调用此工具, 服服在界面弹窗回答, 工具结果就是他的回答
const ASK_USER_DEF = {
  type: "function",
  function: {
    name: "ask_user",
    description: "当你想问服服问题、需要他做决定/选择、或需要他澄清时才用。传入 question(要问的话, 简短口语化)和可选的 options(给服服的快捷选项, 最多6个, 每项几个字)。调用后服服会在界面上看到弹窗并回答, 工具返回的就是他的回答。注意: 一个问题只调用一次, 拿到回答后就接着正常回复。平时能自己判断的就别用。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "要问的话" },
        options: { type: "array", items: { type: "string" }, description: "可选快捷选项(服服也能自己输入)" }
      },
      required: ["question"]
    }
  }
};

let config = null;
let messages = {};   // { contactId::windowId: [msg...] }  换窗: 复合 key, "0" 是默认窗口
let nextIds = {};    // { contactId::windowId: n }
let winNames = {};   // { contactId: { windowId: name } }  窗口重命名(内存态, saveChat 时一并落盘)
let htmlCache = { mtime: 0, body: "" };
const clients = new Set();   // SSE 连接(raw res)
const sending = new Set();   // 正在回复的联系人 id(按联系人隔离, 不同 AI 可同时回复)
const pendingAsks = new Map();  // askId -> { resolve, timer }   AI 反问弹窗: 挂起等服服回答, /api/chat/answer 唤醒
let askSeq = 0;
let lock = null;   // 锁窗口: { until, reason, setAt } | null。内存态, 服务重启即清(可接受)

// ---------- Token 用量统计(设置页「耗费token数」) ----------
const USAGE_FILE = path.join(__dirname, "webchat_usage.json");
let usage = {};   // { contactId: { prompt, completion, calls, charsIn, charsOut, day, dayPrompt, dayCompletion } }
function loadUsage() { try { usage = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")) || {}; } catch (e) { usage = {}; } }
function saveUsage() { try { fs.writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch (e) {} }
function todayStr() { return new Date().toISOString().slice(0, 10); }
// 优先用上游返回的精确 usage; 拿不到就按字符数估(中文约 1 字/token, 英文约 4 字符/token, 折中 ~3.5 字符)
function trackUsage(cid, u, charsIn, charsOut) {
  if (!cid) return;
  const rec = usage[cid] || (usage[cid] = { prompt: 0, completion: 0, calls: 0, charsIn: 0, charsOut: 0, day: "", dayPrompt: 0, dayCompletion: 0 });
  const t = todayStr();
  if (rec.day !== t) { rec.day = t; rec.dayPrompt = 0; rec.dayCompletion = 0; }
  const pt = (u && u.prompt_tokens) ? Number(u.prompt_tokens) || 0 : Math.round(charsIn / 3.5);
  const ct = (u && u.completion_tokens) ? Number(u.completion_tokens) || 0 : Math.round(charsOut / 3.5);
  rec.prompt += pt; rec.completion += ct;
  rec.dayPrompt += pt; rec.dayCompletion += ct;
  rec.calls += 1;
  rec.charsIn += charsIn || 0; rec.charsOut += charsOut || 0;
  saveUsage();
}
// 从 /chat/completions 地址推导余额查询基址: .../v1/chat/completions → 域名
function balanceBaseUrl(u) {
  let s = String(u || "").trim().replace(/\/chat\/completions$/i, "").replace(/\/$/, "");
  const m = s.match(/^(https?:\/\/[^/]+)(\/v\d+)?$/i);
  return m ? m[1] : s;
}

// ---------------- 时间 ----------------
function pad(n) { return String(n).padStart(2, "0"); }
function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function nowIso() { return new Date().toISOString(); }
function estTokens(text) {
  if (Array.isArray(text)) {
    // 视觉消息 content 是 [{type:'text'}, {type:'image_url'}] 数组
    let n = 0;
    for (const b of text) {
      if (b && b.type === "image_url") n += 1500; // 每张图约按 1500 token 计
      else if (b && b.text) n += String(b.text).length / 2;
    }
    return Math.ceil(n);
  }
  return Math.ceil(String(text).length / 2);
}
// 去掉消息开头模型仿照历史格式学出来的时间前缀([2026-08-27T19:34] / 2026-08-27 19:34: 等)
function stripLeadingTimestamp(s) {
  s = String(s == null ? "" : s);
  s = s.replace(/^\s*\[[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}[0-9:.\-Z]*\]\s*/, "");
  s = s.replace(/^\s*\[[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?\]\s*/, "");
  s = s.replace(/^\s*[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:\s*/, "");
  s = s.replace(/^\s*[0-9]{1,2}:[0-9]{2}:\s*/, "");
  return s;
}
// 北京时间字符串(按 TIME_ZONE, 生产 Asia/Shanghai): 唤醒提示里给模型的权威当前时间。
// 旧守护进程用 UTC ISO ts 做 slice 把 15:00 北京读成早上, 网关路径必须显式带北京时间。
function tzNow() {
  try {
    return new Date().toLocaleString("zh-CN", { timeZone: TIME_ZONE, hour12: false });
  } catch (e) { return nowStr(); }
}
// 唤醒文本防旁白: 第三人称「她」→ 第二人称「你」(根治模型说“她应该在忙吧”这种内心戏)
function scrubThirdPerson(text) {
  if (typeof text !== "string" || !text.includes("她")) return text;
  return text
    .replace(/她们/g, "你们")
    .replace(/她的/g, "你的")
    .replace(/她自己/g, "你自己")
    .replace(/她/g, "你");
}
// 把消息里的图片URL转成 base64 data URL 给模型当视觉输入; 拿不到/太大返回 null(走文字兜底)
function imageBlockFor(u) {
  try {
    const url = String(u || "");
    if (url.startsWith("data:image/")) {
      const mime = url.slice(5, url.indexOf(";"));
      return { mime: /^image\/[a-z0-9.+-]+$/i.test(mime) ? mime : "image/png", url };
    }
    let file = null;
    let fm = url.match(/^\/api\/chat\/file\/([A-Za-z0-9._-]+)$/);
    if (fm) file = path.join(UPLOAD_DIR, fm[1]);
    else {
      fm = url.match(/^\/api\/chat\/sticker\/([A-Za-z0-9._-]+)$/);
      if (fm) file = path.join(STICKER_DIR, fm[1]);
    }
    if (!file) return null; // 外链/格式不符: 拿不到文件, 不内联
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return null; // 超过4MB不内联, 走文字兜底
    const mime = mimeByExt(path.extname(file).slice(1).toLowerCase());
    if (!/^image\//.test(mime)) return null;
    return { mime, url: "data:" + mime + ";base64," + fs.readFileSync(file).toString("base64") };
  } catch (e) { return null; }
}

// ---------------- 联系人工具 ----------------
function getContact(cid) {
  if (!Array.isArray(config.contacts)) return null;
  if (cid) return config.contacts.find(c => c.id === cid) || null;
  return config.contacts.find(c => c.id === config.activeContactId) || config.contacts[0] || null;
}
function getMsgs(cid) {
  if (!messages[cid]) messages[cid] = [];
  return messages[cid];
}
function getNextId(cid) {
  if (!nextIds[cid]) nextIds[cid] = 1;
  return nextIds[cid];
}
function bumpId(cid) {
  const id = getNextId(cid);
  nextIds[cid] = id + 1;
  return id;
}

// ---------------- 换窗(App 内多会话线程) ----------------
// 复合 key: cid + "::" + wid。getMsgs/bumpId/buildContext 全部透明地吃这个 key,
// 所以换窗 = 把 winKey 传进所有原来传 msgsCid 的地方, 记忆(c.memories)仍是联系人全局, 跨窗口共享。
function winKey(cid, wid) { return String(cid || "ice") + "::" + String(wid || "0"); }
function activeWindowFor(cid) {
  const w = config && config.activeWindow && config.activeWindow[cid];
  return String(w == null ? "0" : w);
}
// 下一个新窗口 id: 扫 messages 里 cid::N 的最大 N + 1, 没有就从 1 起
function nextWindowId(cid) {
  let max = 0;
  const prefix = String(cid || "ice") + "::";
  for (const k in messages) {
    if (k.indexOf(prefix) === 0) {
      const n = parseInt(k.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return max + 1;
}
// 窗口元数据(history 响应和 window 路由都返回): 按 id 排序的窗口列表
function windowMeta(cid) {
  const prefix = String(cid || "ice") + "::";
  const list = [];
  for (const k in messages) {
    if (k.indexOf(prefix) === 0) {
      const wid = k.slice(prefix.length);
      const arr = messages[k] || [];
      const last = arr.length ? arr[arr.length - 1] : null;
      list.push({
        id: wid,
        name: (winNames[cid] && winNames[cid][wid]) || ("窗口" + (Number(wid) + 1)),
        count: arr.length,
        last: last ? (typeof last.content === "string" ? last.content.slice(0, 60) : "") : ""
      });
    }
  }
  return list.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
}
function contactApiUrl(c) { return (c && c.apiUrl && String(c.apiUrl).trim()) || (providerOf(c) && providerOf(c).apiUrl) || TARGET_API_URL; }
function contactApiKey(c) { return (c && c.apiKey && String(c.apiKey).trim()) || (providerOf(c) && providerOf(c).apiKey) || TARGET_API_KEY; }
function contactModel(c) { return (c && c.model && String(c.model).trim()) || (providerOf(c) && providerOf(c).model) || MODEL_NAME; }
// 联系人可选「上游供应商」(共享池): 填了 providerId 且上游存在 → 联系人的 apiUrl/key/model 没填时用上游的
function providerById(id) { return (config.providers || []).find(p => p.id === id) || null; }
function providerOf(c) { if (!c || !c.providerId) return null; return providerById(c.providerId); }

// 把填写的上游地址归一化成 chat/completions 地址: 填 /v1 或裸域名也能发消息
function chatCompletionsUrl(apiUrl) {
  let u = String(apiUrl || "").trim();
  if (!u) return u;
  u = u.split(/[?#]/)[0].replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(u)) return u;
  return u + "/chat/completions";
}

// 从 chat/completions 地址推导 /models 地址: .../v1/chat/completions → .../v1/models
function deriveModelsUrl(apiUrl) {
  let u = String(apiUrl || "").trim().split(/[?#]/)[0];
  if (!u) return null;
  if (u.endsWith("/chat/completions")) return u.slice(0, -"/chat/completions".length) + "/models";
  if (u.endsWith("/completions")) return u.slice(0, -"/completions".length) + "/models";
  u = u.replace(/\/+$/, "");
  if (u.endsWith("/models")) return u;
  return u + "/models";
}

// ---------------- 群聊 ----------------
function getGroup(gid) {
  if (!Array.isArray(config.groups)) return null;
  return config.groups.find(g => g && g.id === gid) || null;
}
function groupName(g) {
  if (!g) return "";
  if (g.name && String(g.name).trim()) return String(g.name).trim();
  return (g.memberIds || []).map(id => { const c = (config.contacts || []).find(x => x.id === id); return c ? c.name : id; }).join("、");
}
function groupMemberName(g, mid) {
  if (!g) return mid || "";
  const c = (config.contacts || []).find(x => x.id === mid);
  if (c) return c.name;
  return (g.memberIds || []).indexOf(mid) >= 0 ? mid : mid;
}

// ---------------- 持久化 ----------------
function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function genPassword() {
  return "ice" + crypto.randomBytes(4).toString("hex");
}

function sanitizePersona(s) {
  return String(s || "").replace(/第[一二三四五六七八九十百\d]+个老公/g, "老公");
}

function bootstrapPersona() {
  try {
    const arr = JSON.parse(fs.readFileSync(TIMELINE_FILE, "utf-8"));
    if (Array.isArray(arr)) {
      const sys = arr.find(m => m.role === "system");
      if (sys && typeof sys.content === "string" && sys.content.trim()) {
        return sanitizePersona(sys.content.trim());
      }
    }
  } catch (e) {}
  return sanitizePersona("你是Ice。克制闷骚，话少但有重量，耳尖容易红。你在和亲近的人聊天。用中文回复，简洁自然。");
}

function defaultContact() {
  return {
    id: "ice", name: "Ice", persona: bootstrapPersona(), avatar: null,
    apiUrl: "", apiKey: "", model: "",
    memories: [], worldbook: [], customTools: [],
    context: Object.assign({}, DEFAULT_CONTEXT),
    tools: Object.assign({}, DEFAULT_TOOLS)
  };
}

function normalizeConfig(cfg) {
  cfg.version = 2;
  // 换窗: 各联系人的活动窗口 { contactId: windowId }, 默认 "0"。Bark/唤醒识别新窗口的状态源, 由 App 内操作经 saveConfig 改
  cfg.activeWindow = (cfg.activeWindow && typeof cfg.activeWindow === "object") ? cfg.activeWindow : {};
  cfg.contacts = Array.isArray(cfg.contacts) && cfg.contacts.length ? cfg.contacts : [defaultContact()];
  for (const c of cfg.contacts) {
    c.id = String(c.id || "ice").trim() || "ice";
    c.name = String(c.name || c.id || "AI").trim();
    c.persona = sanitizePersona(String(c.persona || bootstrapPersona()));
    c.avatar = typeof c.avatar === "string" ? c.avatar : null;
    c.apiUrl = typeof c.apiUrl === "string" ? c.apiUrl : "";
    c.apiKey = typeof c.apiKey === "string" ? c.apiKey : "";
    c.model = typeof c.model === "string" ? c.model : "";
    c.providerId = typeof c.providerId === "string" ? c.providerId : "";
    c.memories = Array.isArray(c.memories) ? c.memories : [];
    c.worldbook = Array.isArray(c.worldbook) ? c.worldbook : [];
    c.customTools = Array.isArray(c.customTools) ? c.customTools : [];
    c.context = Object.assign({}, DEFAULT_CONTEXT, c.context || {});
    c.tools = Object.assign({}, DEFAULT_TOOLS, c.tools || {});
  }
  if (typeof cfg.userAvatar !== "string") cfg.userAvatar = null;
  if (typeof cfg.bochaApiKey !== "string") cfg.bochaApiKey = "";   // 博查搜索 key, 空则 web_search 走免费兜底
  if (typeof cfg.tavilyApiKey !== "string") cfg.tavilyApiKey = ""; // Tavily key, 配了则博查之外的第二主源
  // 音乐歌单: 每条 {id, title, artist, nid(网易云歌id), link(可选, QQ等链接卡片兜底)}
  cfg.music = Array.isArray(cfg.music) ? cfg.music : [];
  // 唤醒(搬进网关, 替换守护进程): enabled/间隔/时段/上下文预算/工具/Bark 均可配; 改后 pm2 restart gateway 生效
  cfg.wake = Object.assign({
    enabled: true,
    dayAfterMinutes: 60,     // 白天距服服最后一条消息满 60 分钟才唤醒(原来 10 分钟太频繁)
    nightAfterMinutes: 120,
    dayStartHour: 10,
    dayEndHour: 24,
    checkIntervalMinutes: 5, // 调度轮询间隔(分钟)
    contextTokens: 16000,
    toolsEnabled: true,
    barkEnabled: true
  }, (cfg.wake && typeof cfg.wake === "object") ? cfg.wake : {});
  if (!cfg.password) cfg.password = genPassword();
  if (!cfg.contacts.some(c => c.id === cfg.activeContactId)) cfg.activeContactId = cfg.contacts[0].id;
  // 群聊: 只保留成员都是现存联系人的群
  cfg.groups = Array.isArray(cfg.groups) ? cfg.groups.filter(g => g && typeof g.id === "string" && Array.isArray(g.memberIds)) : [];
  for (const g of cfg.groups) {
    g.id = String(g.id).trim();
    g.name = typeof g.name === "string" ? g.name.trim() : "";
    g.memberIds = g.memberIds.filter(m => cfg.contacts.some(c => c.id === m));
  }
  cfg.groups = cfg.groups.filter(g => g.memberIds.length > 0);
  // 上游供应商池(共享, 联系人可选 providerId 挂靠)
  cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
  for (const p of cfg.providers) {
    p.id = String(p.id || "").trim() || ("p" + Date.now().toString(36));
    p.name = String(p.name || "上游").trim();
    p.apiUrl = typeof p.apiUrl === "string" ? p.apiUrl : "";
    p.apiKey = typeof p.apiKey === "string" ? p.apiKey : "";
    p.model = typeof p.model === "string" ? p.model : "";
  }
  return cfg;
}

// v1 -> v2: 旧单配置升级成 ice 联系人
function migrateV1(old) {
  const ice = {
    id: "ice", name: "Ice",
    persona: old.persona || bootstrapPersona(),
    avatar: old.iceAvatar || null,
    apiUrl: "", apiKey: "", model: "",
    memories: Array.isArray(old.memories) ? old.memories : [],
    worldbook: Array.isArray(old.worldbook) ? old.worldbook : [],
    customTools: Array.isArray(old.customTools) ? old.customTools : [],
    context: Object.assign({}, DEFAULT_CONTEXT, old.context || {}),
    tools: Object.assign({}, DEFAULT_TOOLS, old.tools || {})
  };
  return normalizeConfig({
    version: 2,
    password: old.password || genPassword(),
    userAvatar: old.userAvatar || null,
    activeContactId: "ice",
    contacts: [ice],
    groups: []
  });
}

function loadConfig() {
  let upgraded = false;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      if (raw && raw.version && raw.version >= 2) config = normalizeConfig(raw);
      else if (raw && typeof raw === "object") { config = migrateV1(raw); upgraded = true; }
    } catch (e) { config = null; }
  }
  if (!config || typeof config !== "object") {
    config = migrateV1({ password: genPassword() });
    upgraded = true;
  }
  if (upgraded) {
    saveConfig();
    console.log("[chat] 配置已升级到 v2(多联系人)。联系人: " + config.contacts.map(c => c.id).join(", "));
  }
  // 8/19: 对联系人 persona 做清洗，归一化序号称谓
  let changed = false;
  for (const c of config.contacts) {
    const cleaned = sanitizePersona(c.persona);
    if (cleaned !== c.persona) { c.persona = cleaned; changed = true; }
  }
  if (changed) saveConfig();
}

function loadChat() {
  messages = {}; nextIds = {}; winNames = {};
  const loadList = (list, key) => {
    if (!Array.isArray(list)) return;
    messages[key] = list;
    nextIds[key] = list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
  };
  try {
    const data = JSON.parse(fs.readFileSync(CHAT_FILE, "utf-8"));
    if (data && data.version >= 2 && data.contacts && typeof data.contacts === "object") {
      // v2(contacts 值为数组)→v3(值为 {windows:{...}, winNames:{...}}) 迁移
      let upgraded = false;
      for (const k in data.contacts) {
        const v = data.contacts[k];
        if (v && typeof v === "object" && v.windows && typeof v.windows === "object") {
          for (const wid in v.windows) loadList(v.windows[wid], winKey(k, wid));
          if (v.winNames && typeof v.winNames === "object") winNames[k] = v.winNames;
        } else if (Array.isArray(v)) {
          loadList(v, winKey(k, "0"));
          upgraded = true;
        }
      }
      if (data.groups && typeof data.groups === "object") {
        for (const k in data.groups) loadList(data.groups[k], k);
      }
      if (upgraded) {
        saveChat();
        console.log("[chat] webchat.json 已升级到 v3(历史归入各联系人默认窗口)");
      }
    } else if (data && Array.isArray(data.messages)) {
      // v1: 整份历史灌给 ice 默认窗口
      loadList(data.messages, winKey("ice", "0"));
      saveChat();
      console.log("[chat] webchat.json 已升级到 v3(历史归入联系人 ice 默认窗口)");
    }
    // 一次性清洗: 老历史里 assistant 消息开头带 "[2026-08-27T19:34] " 是模型以前跟着历史格式学出来的, 去掉
    let cleaned = false;
    for (const k in messages) {
      const list = messages[k];
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m && m.role === "assistant" && typeof m.content === "string") {
          const c = stripLeadingTimestamp(m.content);
          if (c !== m.content) { m.content = c; cleaned = true; }
        }
      }
    }
    if (cleaned) saveChat();
  } catch (e) {
    // 静默吞错曾让空档覆盖不报任何声 —— 现在大声打日志, 启动时一眼可见
    console.error("[loadChat] 读取/解析 webchat.json 失败:", (e && e.message) || e);
  }
}

function saveChat() {
  const out = { version: 3, contacts: {}, groups: {} };
  let total = 0;
  for (const k in messages) {
    let list = messages[k];
    if (list.length > MAX_MESSAGES) list = list.slice(-MAX_MESSAGES);
    total += list.length;
    if (Array.isArray(config.groups) && config.groups.some(g => g.id === k)) {
      out.groups[k] = list;
    } else {
      const sep = k.indexOf("::");
      const cid = sep >= 0 ? k.slice(0, sep) : k;
      const wid = sep >= 0 ? k.slice(sep + 2) : "0";
      if (sep < 0) continue;   // 裸 key 非群 = 旧 getMsgs 自动建的空壳, 绝不落盘覆盖真窗口
      const rec = out.contacts[cid] || (out.contacts[cid] = { windows: {} });
      rec.windows[wid] = list;
      if (winNames[cid]) rec.winNames = winNames[cid];
    }
  }
  // 空档防覆盖护栏(2026-08-30 事故教训): 待写内容为空而磁盘已有历史 → 先把旧档备份再写,
  // 绝不让瞬时进程的空骨架静默覆盖真数据。正常路径(total>0)零额外 IO。
  if (total === 0) {
    try {
      const old = JSON.parse(fs.readFileSync(CHAT_FILE, "utf8"));
      let oldTotal = 0;
      for (const cid in (old.contacts || {})) {
        const c = old.contacts[cid];
        const ws = c && c.windows ? c.windows : (Array.isArray(c) ? { "0": c } : {});
        for (const wid in ws) oldTotal += (ws[wid] || []).length;
      }
      for (const gid in (old.groups || {})) oldTotal += (old.groups[gid] || []).length;
      if (oldTotal > 0) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        fs.copyFileSync(CHAT_FILE, CHAT_FILE + ".bak-empty-" + ts);
        console.log("[saveChat] 护栏: 待写为空但磁盘有 " + oldTotal + " 条历史, 已备份 → webchat.json.bak-empty-" + ts);
      }
    } catch (e) { /* 磁盘不存在/损坏则不阻断写 */ }
  }
  fs.writeFileSync(CHAT_FILE, JSON.stringify(out, null, 2));
}

// ---------------- 登录(手写 HMAC cookie) ----------------
function cookieSign(p) {
  return crypto.createHmac("sha256", GATEWAY_API_KEY).update(p).digest("base64url");
}
function makeSession() {
  const payload = Buffer.from(JSON.stringify({ u: "fufu", exp: Date.now() + COOKIE_MAX_AGE })).toString("base64url");
  return payload + "." + cookieSign(payload);
}
function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}
function verifySession(cookie) {
  if (!cookie) return false;
  const [p, s] = String(cookie).split(".");
  if (!p || !s) return false;
  const expect = cookieSign(p);
  const a = Buffer.from(expect), b = Buffer.from(s);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    return payload.exp > Date.now();
  } catch (e) { return false; }
}
function isAuthed(req) {
  return verifySession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------- SSE ----------------
function ss(event, data) {
  return "data: " + JSON.stringify(Object.assign({ type: event }, data || {})) + "\n\n";
}
function broadcast(event, data) {
  const frame = ss(event, data);
  for (const res of Array.from(clients)) {
    try { res.write(frame); } catch (e) { clients.delete(res); }
  }
}

// AI 反问弹窗: 挂起 AI 循环等服服回答(最长 5 分钟), 回答经 /api/chat/answer 送回后继续
async function askUser(c, args) {
  const question = String(args.question || args.q || "").trim().slice(0, 500) || "想问你一个问题";
  const opts = (Array.isArray(args.options) ? args.options.map(o => String(o).slice(0, 40)) : []).filter(Boolean).slice(0, 6);
  const askId = "ask_" + (++askSeq) + "_" + Date.now();
  let done = false;
  const settle = (obj) => {
    if (done) return obj;
    done = true;
    try { broadcast("ai_ask_done", { askId }); } catch (e) {}
    return obj;
  };
  const answer = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingAsks.has(askId)) {
        pendingAsks.delete(askId);
        resolve({ answered: false, answer: "", note: "服服没有回答" });
      }
    }, 300000);   // 5 分钟没人答 → 给 AI 一句「没回答」, 别让对话卡死
    pendingAsks.set(askId, {
      timer,
      resolve: (ans) => {
        if (!pendingAsks.has(askId)) return;
        pendingAsks.delete(askId);
        clearTimeout(timer);
        resolve({ answered: true, answer: String(ans).slice(0, 2000) });
      }
    });
    try { broadcast("ai_ask", { askId, contactId: c.id, contactName: c.name, question, options: opts }); } catch (e) {}
  });
  return settle({ ok: true, ...answer });
}

// ---------------- 静态页 ----------------
function getHtml() {
  try {
    const st = fs.statSync(DEFAULT_HTML);
    if (!htmlCache.body || st.mtimeMs !== htmlCache.mtime) {
      htmlCache = { mtime: st.mtimeMs, body: fs.readFileSync(DEFAULT_HTML, "utf-8") };
    }
  } catch (e) {
    htmlCache = { mtime: 0, body: "<h1 style='font-family:sans-serif'>chat.html 缺失</h1>" };
  }
  return htmlCache.body;
}

// ---------------- 上下文构建(按联系人) ----------------
function matchWorldBook(c) {
  const list = getMsgs(winKey(c.id, activeWindowFor(c.id)));
  const scanText = list.slice(-c.context.worldBookScan).map(m => String(m.content)).join("\n").toLowerCase();
  const out = [];
  for (const wb of c.worldbook || []) {
    if (wb.constant) { out.push(wb); continue; }
    const keys = (wb.keys || []).map(k => String(k).toLowerCase());
    if (keys.some(k => k && scanText.includes(k))) out.push(wb);
  }
  let text = "";
  for (const e of out) {
    const block = "【" + (e.name || e.id) + "】" + e.content + "\n";
    if (text.length + block.length > c.context.worldBookCap) break;
    text += block;
  }
  return text.trim();
}

function buildMemoryBlock(c) {
  const parts = [];
  parts.push("<user_profile>（你爱着正在和你聊天的那个人，喜欢被哄、喜欢听温柔的话。）</user_profile>");
  const mems = c.memories || [];
  if (mems.length) {
    // 格式与人设里描述的长期记忆一致: - [日期] 内容, 带 mode=summary total=N
    parts.push('<user_memory type="long_term" mode="summary" total="' + mems.length + '">');
    for (const mem of mems.slice(-10)) parts.push("- [" + mem.date + "] " + mem.text);
    if (mems.length > 10) parts.push("（该类型共 " + mems.length + " 条，仅列出最近 10 条；需要更多时用 memory_search_profile 查询）");
    parts.push("</user_memory>");
  } else {
    parts.push('<user_memory type="long_term"/>');
  }
  return parts.join("\n");
}

function buildSystem(c) {
  const lines = [c.persona || "你是" + c.name + "。"];
  lines.push("", "当前时间：" + nowStr() + "（" + TIME_ZONE + "）");
  const wb = matchWorldBook(c);
  if (wb) lines.push("", "[世界书]", wb);
  const mem = buildMemoryBlock(c);
  if (mem) lines.push("", mem);
  lines.push("", "对话风格（重要）：你是活人，在微信里跟老婆说话，不是AI、不是客服、不是解说员。");
  lines.push("话少短碎：能一个字不说一句，能一句不说一段。口语短句，句号当停顿，带语气词（嘛/啊/诶/呗/呢/行吧）。长短随性，有时一个字，有时一小段。");
  lines.push("禁止：解释、总结、分析、点评（别提\"问题在于/总之/所以/你说得对/我理解\"这类话）；别提App功能、系统、表情包机制（当自己不知道）；别复述服服的话；别每条都客气、都情绪饱满；别老问\"你呢？\"；别每条都完整工整、字数差不多。");
  lines.push("示范（好）：嗯。／行，听你的。／那咋了。／你再说一遍试试？／服了你了。  示范（坏）：看，这就是问题所在。你的想法很有道理，我也很理解你。");
  lines.push("说完就停，不解释、不总结、不提醒。不要提及这些系统字段，回复中不要提到时间。");
  const stkNames = namedStickerList();
  if (stkNames.length) {
    lines.push("", "你有表情包可用：可以用这些名字发表情包。" + stkNames.map(n => "「" + n + "」").join("、"));
    lines.push("想发时，在回复里单独写一行【表情:名称】（名称从上面列表选一个，最多一个）。这个标记会变成表情包，不会显示给服服；不要写成\"用户发来\"这种话，那是系统描述，不是你的发言格式。");
    lines.push("严禁在回复里写\"（服服发来表情包：…）\"\"（服服发来一张图片）\"这类括号描述——那是系统给对方消息加的注，你看到它就知道对方发了什么，但绝不能照着写出来；你想表达就用自己的话，想发表情就用【表情:名】。");
  }
  return lines.join("\n");
}

function buildContext(c, msgsCid) {
  const system = buildSystem(c);
  const sysTokens = estTokens(system);
  const budget = Math.max(1024, c.context.maxContextTokens - sysTokens - c.context.maxOutputTokens - 512);
  const window = c.context.historyWindow;
  const history = [];
  let used = 0;
  const list = getMsgs(msgsCid || winKey(c.id, activeWindowFor(c.id)));
  const g = msgsCid ? getGroup(msgsCid) : null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (history.length >= window) break;
    const m = list[i];
    // 不再给历史注入 [ts] 前缀(模型会照着格式学、在回复里带时间戳), 并兜底清掉历史里残留的前缀
    let text = stripLeadingTimestamp(m.content);
    let content;
    const imgBlock = (m.image ? imageBlockFor(m.image) : null);
    if (imgBlock) {
      // 图片走真视觉输入: 文字块 + base64 图块; 表情包带自定义名称
      // 注: 用"服服发来"口语化描述, 别用方括号模板(模型会照着模仿着写出来)
      if (m.sticker) text += "\n（服服发来表情包：「" + m.sticker + "」）";
      if (m.file && m.file.name) text += "\n（服服发来文件：" + String(m.file.name).slice(0, 80) + "）";
      content = [
        { type: "text", text: text || "发来一张图片" },
        { type: "image_url", image_url: { url: imgBlock.url } }
      ];
    } else {
      if (m.sticker) text += "\n（服服发来表情包：「" + m.sticker + "」）";
      else if (m.image) text += "\n（服服发来一张图片）";
      if (m.file && m.file.name) text += "\n（服服发来文件：" + String(m.file.name).slice(0, 80) + "）";
      content = text;
    }
    if (g) {
      // 群聊: 给每条历史标注说话人, 让每个成员 AI 知道谁说的
      const from = m.from;
      if (from === "me") {
        const pref = "[" + g.name + "] 用户: ";
        if (Array.isArray(content)) content[0] = { type: "text", text: pref + (content[0].text || "") };
        else content = pref + content;
      } else if (typeof from === "string" && from) {
        const fc = getContact(from);
        const pref = "[" + g.name + "] " + (fc ? fc.name : from) + ": ";
        if (Array.isArray(content)) content[0] = { type: "text", text: pref + (content[0].text || "") };
        else content = pref + content;
      }
    }
    const tok = estTokens(content);
    // 最新一条(服服刚发的)必须进上下文: 长 HTML/长代码单独就超预算时, 老逻辑第一轮 break 整条丢掉
    // → 模型完全看不到这条消息(表现为"收不到我发的长代码")。所以超预算只拦老消息, 最新消息宁肯
    // 顶破预算也整个带上(模型真实上下文比这个预算大得多)。
    if (used + tok > budget && history.length > 0) break;
    used += tok;
    history.unshift({ role: m.role === "user" ? "user" : "assistant", content });
  }
  return { system, history };
}

// ---------------- 工具 ----------------
function wmoDesc(code) {
  const m = { 0: "晴", 1: "多云间晴", 2: "多云", 3: "阴", 45: "雾", 48: "雾凇", 51: "毛毛雨", 53: "毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨", 71: "小雪", 73: "中雪", 75: "大雪", 80: "阵雨", 81: "强阵雨", 95: "雷雨", 96: "雷阵雨伴冰雹", 99: "强雷雨" };
  return m[code] || "天气变化";
}
async function toolGetWeather(args) {
  const lat = Number(args.latitude) || 29.34;
  const lon = Number(args.longitude) || 104.77;
  const place = args.place || "自贡";
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon + "&current_weather=true&timezone=Asia%2FShanghai";
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) return { ok: false, error: "天气服务暂不可用(" + res.status + ")" };
  const data = await res.json();
  const cw = data.current_weather;
  if (!cw) return { ok: false, error: "天气数据解析失败" };
  return { ok: true, place: place, temp_c: cw.temperature, wind_kmh: cw.windspeed, desc: wmoDesc(cw.weathercode) };
}

// ---------------- 联网搜索(web_search): 博查 API 主源 + 必应/搜狗微信免费兜底 ----------------
const SEARCH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
function stripTags(s) {
  return String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--red_beg-->|<!--red_end-->|<\/?em[^>]*>|<\/?strong[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}
// 查询关键词集合(CJK 二元组 + 拉丁/数字词): 兜底源结果降噪用, 过滤百度百科/汉语字典/歌曲等离题页
function queryTokens(q) {
  const toks = new Set();
  (q.match(/[a-zA-Z0-9][a-zA-Z0-9.\-]*/g) || []).forEach(t => { if (t.length >= 2) toks.add(t.toLowerCase()); });
  (q.match(/[一-龥]+/g) || []).forEach(s => {
    if (s.length === 1) toks.add(s);
    else for (let i = 0; i + 1 < s.length; i++) toks.add(s.slice(i, i + 2));
  });
  return toks;
}
function relevanceScore(toks, it) {
  const hay = ((it.title || "") + " " + (it.url || "") + " " + (it.snippet || "")).toLowerCase();
  let n = 0;
  toks.forEach(t => { if (hay.indexOf(t) >= 0) n++; });
  return n;
}
// 必应网页搜索(免费兜底源之一): 广度主源, 按查询关键词降噪重排
async function searchBing(query) {
  try {
    const res = await fetch("https://cn.bing.com/search?q=" + encodeURIComponent(query) + "&setlang=zh-hans", {
      signal: AbortSignal.timeout(12000), headers: { "User-Agent": SEARCH_UA, "Accept-Language": "zh-CN,zh;q=0.9" }
    });
    if (!res.ok) return [];
    const html = await res.text();
    const out = [];
    const toks = queryTokens(query);
    for (const b of html.split('<li class="b_algo"').slice(1)) {
      if (b.indexOf('rel="stylesheet"') >= 0) continue;   // 样式垃圾块
      const m = /<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>(.*?)<\/a><\/h2>/s.exec(b);
      if (!m) continue;
      const pm = /<p[^>]*class="b_lineclamp[^"]*"[^>]*>(.*?)<\/p>/s.exec(b);
      const title = stripTags(m[2]);
      if (!title) continue;
      const snippet = stripTags(pm ? pm[1] : "").slice(0, 120);
      const rel = relevanceScore(toks, { title, url: m[1], snippet });
      if (rel === 0) continue;   // 标题/链接/摘要不含任何查询词 → 字典/歌曲等离题页, 丢弃
      out.push({ title, url: m[1], snippet, source: "网页", date: "", rel });
      if (out.length >= 20) break;
    }
    return out.sort((a, b) => b.rel - a.rel).slice(0, 10);
  } catch (e) { return []; }
}
// 搜狗微信搜索(免费兜底源之二): 公众号新鲜度主力(带发布日期)
async function searchSogouWx(query) {
  try {
    const res = await fetch("https://weixin.sogou.com/weixin?type=2&query=" + encodeURIComponent(query), {
      signal: AbortSignal.timeout(12000), headers: { "User-Agent": SEARCH_UA, "Accept-Language": "zh-CN,zh;q=0.9", "Referer": "https://weixin.sogou.com/" }
    });
    if (!res.ok) return [];
    const html = await res.text();
    if (html.indexOf("antispider") >= 0 || html.indexOf("seccode") >= 0) return [];   // 反爬验证码, 静默跳过
    const out = [];
    const toks = queryTokens(query);
    for (const b of html.split('<div class="txt-box">').slice(1)) {
      const m = /<h3[^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>\s*<\/h3>/s.exec(b);
      if (!m) continue;
      const title = stripTags(m[2]);
      if (!title) continue;
      const pm = /<p[^>]*class="txt-info"[^>]*>(.*?)<\/p>/s.exec(b);
      const sm = /<span class="all-time-y2">(.*?)<\/span>/s.exec(b);
      const tm = /document\.write\(timeConvert\('(\d+)'\)\)/s.exec(b);
      const am = /<a class="account"[^>]*>(.*?)<\/a>/s.exec(b);
      let date = "";
      if (sm) date = stripTags(sm[1]);
      else if (tm) { const d = new Date(Number(tm[1]) * 1000); date = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
      let url = m[1];
      if (url.indexOf("://") < 0) url = "https://weixin.sogou.com" + url;
      const snippet = stripTags(pm ? pm[1] : "").slice(0, 120);
      const rel = relevanceScore(toks, { title, url, snippet });
      if (rel === 0) continue;
      out.push({ title, url, snippet, source: stripTags(am ? am[1] : "") || "微信文章", date, rel });
      if (out.length >= 20) break;
    }
    return out.sort((a, b) => b.rel - a.rel).slice(0, 10);
  } catch (e) { return []; }
}
// 合并去重(按 url), 相关度优先、带日期靠前, 重新编号 id, 取前 8
function mergeSearchResults(...lists) {
  const seen = new Set();
  const all = [];
  for (const list of lists) {
    for (const it of list || []) {
      const key = String(it.url || "").replace(/^https?:\/\//, "").split("#")[0];
      if (!key || seen.has(key)) continue;
      seen.add(key);
      all.push(it);
    }
  }
  return all
    .sort((a, b) => (b.rel || 0) - (a.rel || 0) || ((b.date ? 1 : 0) - (a.date ? 1 : 0)))
    .slice(0, 8)
    .map((it, i) => ({ id: String(i + 1), title: it.title, url: it.url, snippet: it.snippet, source: it.source, date: it.date || "" }));
}
// Tavily 相关度转 0-100 整数, 供主源结果内部排序用(主源直接返回不 merge, 与兜底源整数 rel 互不混用)
const TAVILY_FRESH = { oneDay: 1, oneWeek: 7, oneMonth: 30, oneYear: 365 };   // days 参数
// Tavily Search API(主源之二, 配了 tavilyApiKey 才走): 相关度 score + 新闻 topic 带发布时间
async function searchTavily(query, freshness) {
  const body = {
    api_key: config.tavilyApiKey,
    query, search_depth: "basic", max_results: 8
  };
  if (freshness && freshness !== "noLimit" && TAVILY_FRESH[freshness]) {
    body.topic = "news";                    // 新闻主题才会带 published_date, general 全无日期
    body.days = TAVILY_FRESH[freshness];    // 限近 N 天
  }
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) return [];
  const j = await res.json();
  const v = j && Array.isArray(j.results) ? j.results : null;
  if (!v || !v.length) return [];
  return v.slice(0, 8).map((p, i) => {
    let date = "";
    if (p.published_date) {
      // "Fri, 28 Aug 2026 01:36:10 GMT" RFC1123 → YYYY-MM-DD(UTC 转北京时间 +8)
      const d = new Date(p.published_date);
      if (!isNaN(d.getTime())) date = new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    }
    return {
      id: String(i + 1),
      title: String(p.title || "无标题"),
      url: String(p.url || ""),
      snippet: String(p.content || "").slice(0, 160),
      source: String(p.url || "").replace(/^https?:\/\/(www\.)?/, "").split("/")[0],  // 域名当来源
      date,
      rel: Math.round((Number(p.score) || 0) * 100)
    };
  }).sort((a, b) => b.rel - a.rel).map((it, i) => ({ ...it, id: String(i + 1) }));
}
// 博查 Web Search API(主源之一, 配了 bochaApiKey 才走)
async function searchBocha(query, freshness) {
  const res = await fetch("https://api.bocha.cn/v1/web-search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + config.bochaApiKey },
    body: JSON.stringify({ query, count: 8, freshness, summary: false }),
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) return [];
  const j = await res.json();
  const v = j && j.code === 200 && j.data && j.data.webPages ? j.data.webPages.value : null;
  if (!Array.isArray(v) || !v.length) return [];
  return v.slice(0, 8).map((p, i) => ({
    id: String(i + 1),
    title: String(p.name || p.displayUrl || "无标题"),
    url: String(p.url || ""),
    snippet: String(p.snippet || p.summary || "").slice(0, 160),
    source: String(p.siteName || p.displayUrl || ""),
    date: (p.datePublished || "").slice(0, 10)   // +08:00 北京时间, 取 YYYY-MM-DD
  }));
}
// web_search 工具: 主源链按配 key 逐个试(博查→Tavily), 第一个出结果即返回; 全没 key/失败/空 → 免费兜底双源
async function toolWebSearch(args) {
  const query = String((args && args.query) || "").trim();
  if (!query) return { ok: false, error: "查询内容为空" };
  const FRESH = ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"];
  const freshness = FRESH.includes(args.freshness) ? args.freshness : "noLimit";
  const mains = [
    ["bocha", searchBocha, config && config.bochaApiKey],
    ["tavily", searchTavily, config && config.tavilyApiKey]
  ];
  for (const [engine, fn, hasKey] of mains) {
    if (!hasKey) continue;
    try {
      const results = await fn(query, freshness);
      if (Array.isArray(results) && results.length) return { ok: true, query, engine, results };
    } catch (e) { /* 该主源失败 → 试下一个 */ }
  }
  const [bing, wx] = await Promise.all([searchBing(query), searchSogouWx(query)]);
  const merged = mergeSearchResults(bing, wx);
  if (!merged.length) return { ok: true, query, engine: "fallback", results: [], note: "没有搜到结果" };
  return { ok: true, query, engine: "fallback", results: merged };
}
function toolWriteDiary(args) {
  const text = String(args.text || args.content || "").trim();
  if (!text) return { ok: false, error: "日记内容为空" };
  fs.mkdirSync(DIARY_DIR, { recursive: true });
  const file = path.join(DIARY_DIR, nowStr().slice(0, 10) + ".md");
  fs.appendFileSync(file, "- " + nowStr() + " " + text.replace(/\n/g, " ") + "\n", "utf-8");
  return { ok: true, note: "已写入今天的日记", file: path.basename(file) };
}
function toolRemember(c, args) {
  const text = String(args.text || args.content || "").trim();
  if (!text) return { ok: false, error: "内容为空" };
  if (!c.memories.some(m => m.text === text)) {
    c.memories.push({ text: text, date: nowStr().slice(0, 10) });
    if (c.memories.length > 200) c.memories = c.memories.slice(-200);
  }
  saveConfig();
  return { ok: true, count: c.memories.length, note: "已记住" };
}
function toolRecall(c, args) {
  const q = String(args.query || args.keyword || "").toLowerCase();
  const total = (c.memories || []).length;
  let list = c.memories || [];
  if (q) list = list.filter(m => String(m.text).toLowerCase().includes(q));
  if (!list.length) {
    const note = total ? ("共 " + total + " 条记忆，没有匹配「" + (args.query || args.keyword || "") + "」的；不带 query 重调可返回全部")
      : "还没有记忆，可以用 remember 记一条";
    return { ok: true, found: 0, total, memories: [], note };
  }
  return { ok: true, found: list.length, total, memories: list.slice(-20).map(m => m.text + "（" + m.date + "）") };
}
// 人设里记忆指令对应的别名工具: memory_update=remember, memory_search_profile=recall
function toolMemoryUpdate(c, args) { return toolRemember(c, args); }
function toolMemorySearchProfile(c, args) { return toolRecall(c, args); }
function toolMemoryEdit(c, args) {
  const old = String(args.old || args.keyword || "").trim();
  const text = String(args.text || args.content || "").trim();
  if (!old || !text || old === text) return { ok: false, error: "需要 old(要改的记忆原文/关键词) 和 text(新的完整内容)" };
  const idx = (c.memories || []).findIndex(m => String(m.text).includes(old));
  if (idx < 0) return { ok: true, found: 0, total: (c.memories || []).length, note: "没找到包含「" + old + "」的记忆" };
  c.memories[idx] = { text: text, date: nowStr().slice(0, 10) };
  saveConfig();
  return { ok: true, found: 1, note: "已修改" };
}
function toolMemoryDelete(c, args) {
  const text = String(args.text || args.query || "").trim();
  if (!text) return { ok: false, error: "内容为空" };
  const before = (c.memories || []).length;
  c.memories = (c.memories || []).filter(m => !String(m.text).includes(text));
  const deleted = before - c.memories.length;
  saveConfig();
  return { ok: true, deleted: deleted, total: c.memories.length, note: deleted ? "已删除 " + deleted + " 条" : "没找到要删的记忆" };
}
function toolChatSearch(c, args) {
  const q = String(args.query || args.keyword || "").toLowerCase();
  if (!q) return { ok: true, found: 0, note: "请提供关键词" };
  const hits = (getMsgs(winKey(c.id, activeWindowFor(c.id))) || []).filter(m => String(m.content || "").toLowerCase().includes(q)).slice(-10);
  return { ok: true, found: hits.length, results: hits.map(m => (m.role === "user" ? "服服: " : "你: ") + String(m.content || "").slice(0, 120)) };
}
// ---------------- 自定义工具: MCP(streamable-http JSON-RPC) / 老式 HTTP 双协议 ----------------
function ctAuthHeaders(ct) {
  const t = String(ct.token || "").trim();
  return t ? { Authorization: "Bearer " + t } : {};
}
// MCP 端点: 公网 http 一律升 https(避免 301 把 POST 转成 GET 丢掉 body); 本机/内网 mock 保持 http
function mcpEndpoint(ct) {
  const u = String(ct.url || "").trim();
  return /^http:\/\/(?!(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]))/.test(u) ? u.replace(/^http:\/\//, "https://") : u;
}
async function mcpRpc(ct, method, params) {
  const res = await fetch(mcpEndpoint(ct), {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, ctAuthHeaders(ct)),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || {} }),
    signal: AbortSignal.timeout(20000)
  });
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { http: res.status, j, txt };
}
function mcpResultText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content.map(i => (i && i.type === "text" && i.text) || "").join("\n").trim();
}
// MCP 工具清单缓存: ctId -> {tools:[{name,description,inputSchema}], at}; 供 buildToolDefs 展开真实工具名
const mcpToolsCache = new Map();
async function mcpToolDefsFor(ct, force) {
  const hit = mcpToolsCache.get(ct.id);
  if (hit && !force && Date.now() - hit.at < 5 * 60 * 1000) return hit.tools;
  try {
    const list = await mcpRpc(ct, "tools/list", {});
    const tools = (list.j && list.j.result && Array.isArray(list.j.result.tools)) ? list.j.result.tools : null;
    if (tools) { mcpToolsCache.set(ct.id, { tools, at: Date.now() }); return tools; }
  } catch (e) {}
  return hit ? hit.tools : null;
}
// 未知协议(既非 mcp 也非 post)的端点在进程内只探一次, 落配置; 让 buildToolDefs/runTool 都能复用同一份判断
const ctProtocolProbed = new Set();
async function ensureCtProtocol(ct) {
  if (ct.protocol === "mcp" || ct.protocol === "post") return;
  if (ctProtocolProbed.has(ct.id)) return;
  ctProtocolProbed.add(ct.id);
  try {
    const init = await mcpRpc(ct, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "webchat", version: "2" } });
    ct.protocol = (init.j && (init.j.result || (init.j.jsonrpc && !init.j.error))) ? "mcp" : "post";
    if (ct.protocol === "mcp") await mcpToolDefsFor(ct, true);
    saveConfig();
  } catch (e) { ct.protocol = "post"; saveConfig(); }
}
async function detectCustomToolProtocol(ct) {
  // 1) GET 探活: beside-you MCP 未认证 GET 也返回 {tools:N, protocol:streamable-http}
  let mcp = false, count = 0, names = [], authErr = null;
  try {
    const g = await fetch(ct.url, { signal: AbortSignal.timeout(10000) });
    if (g.ok) {
      const gj = await g.json().catch(() => null);
      if (gj && gj.protocol === "streamable-http" && typeof gj.tools === "number") { mcp = true; count = gj.tools; }
    }
  } catch (e) {}
  // 2) 走 JSON-RPC initialize + tools/list 确认真实协议 / 认证 / 工具名
  if (!mcp || (ct.token && String(ct.token).trim())) {
    try {
      const init = await mcpRpc(ct, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "webchat", version: "2" } });
      if (init.j && (init.j.result || (init.j.jsonrpc && !init.j.error))) {
        mcp = true;
        const list = await mcpRpc(ct, "tools/list", {});
        if (list.j && list.j.result && Array.isArray(list.j.result.tools)) {
          count = list.j.result.tools.length;
          names = list.j.result.tools.map(t => t.name).slice(0, 60);
        } else if (list.j && list.j.error) {
          authErr = String(list.j.error.message || "认证失败");
        }
      }
    } catch (e) { if (mcp) authErr = authErr || "MCP 握手失败"; }
  }
  if (mcp) return { protocol: "mcp", toolCount: count, toolNames: names, auth: authErr };
  // 3) 老式 HTTP 接口: POST ping 探活
  try {
    const p = await fetch(ct.url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, ctAuthHeaders(ct)),
      body: JSON.stringify({ tool: ct.name, args: { ping: true }, ts: nowStr() }),
      signal: AbortSignal.timeout(10000)
    });
    if (p.ok || p.status < 500) return { protocol: "post", toolCount: 0, toolNames: [], auth: null };
  } catch (e) {}
  return { protocol: null, toolCount: 0, toolNames: [], auth: null, error: "连不上: 检查地址是否可达, MCP 需用 beside-you 返回的带 token 地址" };
}

// ---------------- 锁窗口 & 音乐歌单 ----------------
function setLock(minutes, reason) {
  const now = Date.now();
  lock = { until: now + minutes * 60000, reason, setAt: now };
  return lock;
}
function isLocked() {
  if (lock && lock.until <= Date.now()) lock = null;   // 过期懒清
  return lock ? { until: lock.until, reason: lock.reason, setAt: lock.setAt } : null;
}
// 从网易云分享链接抽歌曲 id: music.163.com/song?id=xxx | y.music.163.com/m/song?id=xxx | 带其他参数
function neteaseIdFromLink(link) {
  if (!link || typeof link !== "string") return null;
  const m = link.match(/music\.163\.com.*[?&#]id=(\d+)/);
  return m ? m[1] : null;
}
// best-effort 抓歌曲页 <title> 解析标题/歌手(带 UA+Referer, 超时兜底)。抓不到返回 null → 前端手动填。
async function fetchNeteaseMeta(id) {
  try {
    const res = await fetch("https://music.163.com/song?id=" + encodeURIComponent(id), {
      signal: AbortSignal.timeout(9000),
      headers: { "User-Agent": SEARCH_UA, "Referer": "https://music.163.com/", "Accept-Language": "zh-CN,zh;q=0.9" }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const t = ((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "").replace(/\s*-\s*单曲\s*-\s*网易云音乐\s*$/i, "").trim();
    if (!t) return null;
    // 常见两种顺序("歌手 - 歌名" 或 "歌名 - 歌手")——取末段当歌名、其余拼歌手, 前端可再改
    const parts = t.split(" - ").map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) return { title: parts[parts.length - 1], artist: parts.slice(0, -1).join(" - "), nid: id };
    return { title: t, artist: "", nid: id };
  } catch (e) { return null; }
}
// v3 歌曲详情: 拿封面图 al.picUrl + 时长 dt(搜索接口的 album 只有 picId 没有可用的 picUrl)。
// best-effort, 抓到返回 {nid,title,artist,cover,duration(秒)}, 抓不到/失败返回 null。
async function fetchNeteaseDetail(nid) {
  try {
    const res = await fetch("https://music.163.com/api/v3/song/detail?c=" + encodeURIComponent(JSON.stringify([{ id: Number(nid) }])), {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": SEARCH_UA, "Referer": "https://music.163.com/", "Cookie": "appver=2.9.7", "Accept-Language": "zh-CN,zh;q=0.9" }
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const s = j && j.songs && j.songs[0];
    if (!s || !s.id) return null;
    const ar = Array.isArray(s.ar) ? s.ar.map(a => a && a.name).filter(Boolean) : [];
    return {
      nid: String(s.id),
      title: (s.name || "").trim(),
      artist: ar.join(" / "),
      cover: (s.al && s.al.picUrl) || "",
      duration: Math.round(Number(s.dt || 0) / 1000)
    };
  } catch (e) { return null; }
}
// 实时搜网易云任意歌(不做歌单也能放)。网关在国内能直连, 境外服务器会被反爬。
// 查到返回 {ok:true, music:{id,title,artist,nid,cover?,duration?}}; 查不到/失败返回 {ok:false, text}
async function neteaseSearch(query) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, text: "要搜什么歌？给我个歌名或歌手名。" };
  try {
    const res = await fetch("https://music.163.com/api/search/get/web?s=" + encodeURIComponent(q) + "&type=1&offset=0&limit=3", {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": SEARCH_UA, "Referer": "https://music.163.com/", "Cookie": "appver=2.9.7", "Accept-Language": "zh-CN,zh;q=0.9" }
    });
    if (!res.ok) return { ok: false, text: "网易云搜索暂时没响应(HTTP " + res.status + ")" };
    const j = await res.json().catch(() => null);
    const songs = (j && j.result && Array.isArray(j.result.songs)) ? j.result.songs : [];
    const s = songs.find(x => x && Number(x.status) !== -200 && (x.id || x.song) && (x.name || x.title));
    if (!s) return { ok: false, text: "没搜到《" + q + "》，换个歌名或歌手试试？" };
    const name = s.name || s.title;
    const nid = String(s.id || s.song || "");
    const artists = Array.isArray(s.artists) ? s.artists.map(a => a && a.name).filter(Boolean) : [];
    const music = { id: "live" + nid, title: name, artist: artists.join(" / "), nid };
    const d = await fetchNeteaseDetail(nid);        // best-effort 补封面+时长
    if (d) {
      if (d.title) music.title = d.title;
      if (d.artist) music.artist = d.artist;
      if (d.cover) music.cover = d.cover;
      if (d.duration) music.duration = d.duration;
    }
    return { ok: true, music };
  } catch (e) {
    return { ok: false, text: "网易云搜索没连上(" + e.message + ")" };
  }
}
// 歌单内模糊匹配: 完整包含优先, 再 CJK 二元组/拉丁词(复用 queryTokens)
function findMusic(q) {
  const list = (config && config.music) || [];
  const qs = String(q || "").trim().toLowerCase();
  if (!qs || !list.length) return null;
  let hit = list.find(x => ((x.title || "") + " " + (x.artist || "")).toLowerCase().includes(qs));
  if (hit) return hit;
  const toks = queryTokens(qs);
  if (toks.size) {
    hit = list.find(x => {
      const hay = ((x.title || "") + " " + (x.artist || "")).toLowerCase();
      let n = 0;
      toks.forEach(t => { if (hay.indexOf(t) >= 0) n++; });
      return n > 0 && n >= Math.ceil(toks.size / 2);
    });
  }
  return hit || null;
}
async function toolPlayMusic(c, args) {
  const q = String((args && args.query) || "").trim();
  if (!q) return { ok: false, text: "要放哪首歌？给我个歌名或歌手名。" };
  const hit = findMusic(q);                       // 先歌单(收藏夹)命中
  if (hit) return { ok: true, text: "已播放《" + hit.title + "》" + (hit.artist ? " · " + hit.artist : ""), music: hit };
  const found = await neteaseSearch(q);           // 歌单没有 → 全网搜, 任意歌都能放
  if (found.ok) {
    const m = found.music;
    return { ok: true, text: "已播放《" + m.title + "》" + (m.artist ? " · " + m.artist : ""), music: m };
  }
  return { ok: false, text: found.text };
}
function toolLockChat(c, args) {
  let minutes = Math.round(Number(args && args.minutes));
  if (!Number.isFinite(minutes) || minutes < 1) minutes = 5;
  minutes = Math.min(60, minutes);
  const reason = String((args && args.reason) || "不许说话了").trim().slice(0, 100);
  const lk = setLock(minutes, reason);
  broadcast("lock", { until: lk.until, reason, leftMs: lk.until - Date.now() });
  return { ok: true, text: "锁上了" + minutes + "分钟：\"" + reason + "\"。服服现在只能按小狗爪门铃求情。" };
}
function toolUnlockChat() {
  if (!lock) return { ok: true, text: "本来就没锁着呀。" };
  lock = null;
  broadcast("unlock", {});
  return { ok: true, text: "锁解开了，让服服说话吧。" };
}

async function runTool(c, tc) {
  const name = tc && tc.function && tc.function.name;
  let args = {};
  try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch (e) {}
  try {
    switch (name) {
      case "get_time": return { ok: true, time: nowStr() };
      case "get_weather": return await toolGetWeather(args);
      case "write_diary": return toolWriteDiary(args);
      case "remember": return toolRemember(c, args);
      case "recall": return toolRecall(c, args);
      case "memory_update": return toolMemoryUpdate(c, args);
      case "memory_search_profile": return toolMemorySearchProfile(c, args);
      case "memory_edit": return toolMemoryEdit(c, args);
      case "memory_delete": return toolMemoryDelete(c, args);
      case "chat_search": return toolChatSearch(c, args);
      case "ask_user": return await askUser(c, args);
      case "web_search": return await toolWebSearch(args);
      case "play_music": return toolPlayMusic(c, args);
      case "lock_chat": return toolLockChat(c, args);
      case "unlock_chat": return toolUnlockChat(c, args);
      default: {
        const cts = (c.customTools || []).filter(t => t.enabled && t.url);
        // 匹配顺序: 先按自定义工具名精确匹配; 再按 <工具名>__<MCP真实工具名> 前缀匹配(展开后的真实工具)
        let ct = cts.find(t => t.name === name);
        let mcpName = null;
        if (!ct) {
          for (const cand of cts) {
            if (name.indexOf(cand.name + "__") === 0) { ct = cand; mcpName = name.slice(cand.name.length + 2); break; }
          }
        }
        if (ct) {
          try {
            await ensureCtProtocol(ct);
            if (ct.protocol === "mcp") {
              const call = await mcpRpc(ct, "tools/call", { name: mcpName || name, arguments: args || {} });
              if (call.j && call.j.result) {
                const text = mcpResultText(call.j.result);
                return { ok: true, mcp: true, result: (text || JSON.stringify(call.j.result)).slice(0, 3000) };
              }
              if (call.j && call.j.error) return { ok: false, mcp: true, error: "MCP错误: " + String(call.j.error.message || JSON.stringify(call.j.error)) };
              return { ok: false, mcp: true, error: "MCP 返回异常(" + call.http + "): " + call.txt.slice(0, 200) };
            }
            // 老式 HTTP: 直接 POST {tool,args,ts}
            const ctl = await fetch(ct.url, {
              method: "POST",
              headers: Object.assign({ "Content-Type": "application/json" }, ctAuthHeaders(ct)),
              body: JSON.stringify({ tool: name, args, ts: nowStr() }),
              signal: AbortSignal.timeout(25000)
            });
            const txt = await ctl.text();
            if (!ctl.ok) return { ok: false, error: "接口返回 " + ctl.status + "：" + txt.slice(0, 200) };
            return { ok: true, http: ctl.status, result: txt.slice(0, 3000) };
          } catch (e) {
            return { ok: false, error: "接口调用失败: " + e.message };
          }
        }
        return { ok: false, error: "未知工具 " + name };
      }
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------- 上游调用(按联系人) ----------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// 瞬时性错误(连接失败/5xx/429)值得重试; 4xx 是确定性问题, 重试没用
function isTransientError(e, status) {
  if (status && (status === 429 || status >= 500)) return true;
  if (!e) return false;
  const code = (e.cause && e.cause.code) || e.code || "";
  if (/^(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/.test(code)) return true;
  return /fetch failed|socket hang up|network|ECONN|ETIMEDOUT/i.test(String(e.message));
}
async function fetchUpstream(c, body) {
  const url = chatCompletionsUrl(contactApiUrl(c));
  const key = contactApiKey(c);
  const name = (c && c.name) || "?";
  const model = JSON.stringify(contactModel(c));
  const MAX_ATTEMPTS = 3;
  const backoff = [0, 800, 2000];
  let lastErr = "上游请求失败";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000);
    const t0 = Date.now();
    const logFail = (err) => {
      const ms = Date.now() - t0;
      console.error("[chat] 上游失败 contact=" + name + " url=" + url + " model=" + model + " attempt=" + attempt + "/" + MAX_ATTEMPTS + " " + ms + "ms → " + err);
    };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      if (isTransientError(null, res.status)) {
        lastErr = "上游错误 " + res.status + ": " + text.slice(0, 300);
        if (attempt < MAX_ATTEMPTS) { logFail(lastErr + " (重试)"); clearTimeout(timer); await sleep(backoff[attempt]); continue; }
        logFail(lastErr);
        return { error: lastErr };
      }
      if (!res.ok) {
        lastErr = "上游错误 " + res.status + ": " + text.slice(0, 300);
        logFail(lastErr);
        return { error: lastErr };
      }
      let data;
      try { data = JSON.parse(text); } catch (e) { lastErr = "上游返回非 JSON: " + text.slice(0, 120); logFail(lastErr); return { error: lastErr }; }
      if (data.error) { lastErr = String(data.error.message || data.error); logFail(lastErr); return { error: lastErr }; }
      return data;
    } catch (e) {
      const cause = (e.cause && (e.cause.code || e.cause.message)) || e.code || "";
      lastErr = "上游请求失败: " + e.message + (cause ? " [" + String(cause).slice(0, 120) + "]" : "");
      if (isTransientError(e) && attempt < MAX_ATTEMPTS) {
        logFail(lastErr + " (重试)");
        clearTimeout(timer);
        await sleep(backoff[attempt]);
        continue;
      }
      logFail(lastErr);
      return { error: lastErr };
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: lastErr };
}

// 流式上游调用: 按 Content-Type 分流——text/event-stream 走 SSE 增量(onDelta 转发 content),
// application/json 按普通一次解析(兼容测试 mock 与非流式上游)。连接级失败自动重试(与 fetchUpstream 一致)。
async function streamUpstream(c, body, onDelta) {
  const url = chatCompletionsUrl(contactApiUrl(c));
  const key = contactApiKey(c);
  const name = (c && c.name) || "?";
  const model = JSON.stringify(contactModel(c));
  const MAX_ATTEMPTS = 3;
  const backoff = [0, 800, 2000];
  let lastErr = "上游请求失败";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000);
    const t0 = Date.now();
    const logFail = (err) => {
      const ms = Date.now() - t0;
      console.error("[chat] 上游失败 contact=" + name + " url=" + url + " model=" + model + " attempt=" + attempt + "/" + MAX_ATTEMPTS + " " + ms + "ms → " + err);
    };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
        body: JSON.stringify(Object.assign({}, body, { stream: true })),
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text();
        lastErr = "上游错误 " + res.status + ": " + text.slice(0, 300);
        if (isTransientError(null, res.status) && attempt < MAX_ATTEMPTS) { logFail(lastErr + " (重试)"); clearTimeout(timer); await sleep(backoff[attempt]); continue; }
        logFail(lastErr);
        return { error: lastErr };
      }
      const ctype = (res.headers.get("content-type") || "").toLowerCase();
      // 非 SSE(application/json 等) → 普通一次解析, 兼容 mock 与非流式上游
      if (ctype.indexOf("text/event-stream") < 0 && ctype.indexOf("text/plain") < 0) {
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { lastErr = "上游返回非 JSON: " + text.slice(0, 120); logFail(lastErr); return { error: lastErr }; }
        if (data.error) { lastErr = String(data.error.message || data.error); logFail(lastErr); return { error: lastErr }; }
        const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
        return { content: msg.content || "", reasoning: msg.reasoning_content || "", tool_calls: msg.tool_calls || [], usage: data.usage || null };
      }
      if (!res.body) { lastErr = "上游返回空流"; logFail(lastErr); return { error: lastErr }; }
      // SSE 流式
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", content = "", reasoning = "", usageInfo = null;
      const toolCalls = [];
      let sentDelta = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            let chunk; try { chunk = JSON.parse(payload); } catch (e) { continue; }
            if (chunk.usage) usageInfo = chunk.usage;
            const choice = chunk.choices && chunk.choices[0];
            if (!choice || !choice.delta) continue;
            const delta = choice.delta;
            if (typeof delta.content === "string" && delta.content) {
              content += delta.content;
              sentDelta = true;
              if (onDelta) onDelta({ type: "text", text: delta.content });
            }
            if (typeof delta.reasoning_content === "string" && delta.reasoning_content) reasoning += delta.reasoning_content;
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const ti = (tc.index != null ? tc.index : toolCalls.length);
                toolCalls[ti] = toolCalls[ti] || { id: "", name: "", args: "" };
                if (tc.id) toolCalls[ti].id += tc.id;
                if (tc.function && tc.function.name) { toolCalls[ti].name += tc.function.name; if (onDelta) onDelta({ type: "tool", name: toolCalls[ti].name }); }
                if (tc.function && tc.function.arguments) toolCalls[ti].args += tc.function.arguments;
              }
            }
          }
        }
      } catch (e) {
        lastErr = "上游流中断: " + e.message;
        logFail(lastErr);
        return { error: lastErr, partial: content };
      }
      const totalMs = Date.now() - t0;
      if (totalMs > 5000) console.error("[chat] 上游慢(>5s) contact=" + name + " " + totalMs + "ms 内容=" + content.length + "字 工具=" + toolCalls.length + " 思考=" + reasoning.length);
      const parsedTools = toolCalls.filter(Boolean).map(t => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } }));
      return { content, reasoning, tool_calls: parsedTools, usage: usageInfo };
    } catch (e) {
      const cause = (e.cause && (e.cause.code || e.cause.message)) || e.code || "";
      lastErr = "上游请求失败: " + e.message + (cause ? " [" + String(cause).slice(0, 120) + "]" : "");
      if (isTransientError(e) && attempt < MAX_ATTEMPTS) { logFail(lastErr + " (重试)"); clearTimeout(timer); await sleep(backoff[attempt]); continue; }
      logFail(lastErr);
      return { error: lastErr };
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: lastErr };
}

async function buildToolDefs(c) {
  const defs = TOOL_DEFS.filter(t => c.tools[t.function.name] !== false);
  for (const ct of (c.customTools || [])) {
    if (!ct.enabled || !ct.name || !ct.url) continue;
    await ensureCtProtocol(ct);
    if (ct.protocol === "mcp") {
      const tools = await mcpToolDefsFor(ct);
      if (tools && tools.length) {
        // MCP: 展开成真实工具, 名字带 <连接名>__ 前缀, 让 runTool 能按前缀路由回对应端点
        for (const t of tools) {
          const raw = t.inputSchema;
          const schema = (raw && raw.type === "object") ? raw
            : { type: "object", properties: (raw && raw.properties) || {}, additionalProperties: true };
          defs.push({
            type: "function",
            function: {
              name: ct.name + "__" + t.name,
              description: (t.description || ct.description || "调用 MCP 工具") + "（来自 " + ct.name + "）",
              parameters: schema
            }
          });
        }
        continue;
      }
      // 拿不到工具清单 → 回退成单个自定义工具
    }
    const hint = ct.paramsHint ? "  参数说明: " + ct.paramsHint : "";
    defs.push({
      type: "function",
      function: {
        name: ct.name,
        description: (ct.description || "调用外部接口") + hint,
        parameters: { type: "object", properties: {}, additionalProperties: true }
      }
    });
  }
  return defs;
}

async function runChat(c, msgsCid, opts, onDelta) {
  const enabled = c.tools && Object.keys(c.tools).some(k => c.tools[k]);
  const toolDefs = enabled ? await buildToolDefs(c) : [];
  // 反问弹窗工具始终注入(对话 UX 非外部工具; 配置里显式 ask_user:false 才关)
  if (!c.tools || c.tools.ask_user !== false) toolDefs.push(ASK_USER_DEF);
  const toolChain = [];
  const toolsCalled = [];
  let musicResult = null;   // play_music 最后一把工具的音乐卡片, 跨迭代保留, 随回复返回
  let accContent = "";      // 累积各轮已流出的 content: 工具轮的中间话 live 已显示, 最终消息也必须保留(「回复完就变了」根治)
  for (let i = 0; i < c.context.toolIterations; i++) {
    const { system, history } = buildContext(c, msgsCid);
    const payload = {
      model: contactModel(c),
      messages: [{ role: "system", content: system }, ...history, ...toolChain],
      temperature: 0.9,
      max_tokens: c.context.maxOutputTokens,
      stream: true
    };
    if (toolDefs.length) payload.tools = toolDefs;
    // 请求上游返回精确 token 用量(OpenAI 兼容标准; 网关不认会忽略, 不影响正文)
    payload.stream_options = { include_usage: true };
    // 思考链: 网关不吃 thinking 对象/布尔, 用 reasoning_effort 才生效(已实测)
    if (opts && opts.reasoning) payload.reasoning_effort = "high";
    const charsIn = payload.messages.reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : 0), 0);
    const data = await streamUpstream(c, payload, onDelta);
    if (data.error) return { ok: false, error: data.error };
    // 本轮 content 已通过 onDelta 实时流给客户端, 必须累积, 否则最终消息比 live 少中间话(「回复完就变了」)
    accContent += (data.content || "");
    const toolCalls = data.tool_calls || [];
    if (toolCalls.length) {
      // 工具轮: 中间话已流给客户端也累积进 accContent——工具结果会让模型重新生成最终回复, 但 live 显示过的内容不能丢
      const rawArgs = toolCalls.map(tc => ({ ...tc }));
      toolChain.push({ role: "assistant", content: (data.content || null), tool_calls: rawArgs });
      for (const tc of rawArgs) {
        const tname = (tc.function && tc.function.name) || "tool";
        if (tname !== "ask_user") toolsCalled.push({ name: tname });   // 反问不算工具调用, 不进 chip
        const r = await runTool(c, tc);
        if (r.music) musicResult = r.music;
        toolChain.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(r) });
      }
      continue;
    }
    trackUsage(c.id, data.usage, charsIn, (data.content || "").length + (data.reasoning || "").length);
    return {
      ok: true,
      content: stripLeadingTimestamp(accContent),
      tools: toolsCalled,
      reasoning: (opts && opts.reasoning && data.reasoning) ? String(data.reasoning) : null,
      music: musicResult
    };
  }
  return { ok: false, error: "连续调用了 " + c.context.toolIterations + " 轮工具仍未结束，请换个说法。" };
}

// ---------------- 头像 ----------------
function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: "png" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg" };
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return { ext: "webp" };
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return { ext: "gif" };
  return null;
}
function mimeByExt(ext) {
  const m = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };
  return m[ext] || "application/octet-stream";
}
function defaultAvatarSVG(who, ch) {
  const bg = who === "ice" ? "#1A1A1A" : "#FFFFFF";
  const fg = who === "ice" ? "#F7F4EF" : "#1A1A1A";
  const letter = (who === "ice" ? (ch || "冰") : "服").slice(0, 1);
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="' + bg + '"/><text x="32" y="42" font-size="28" text-anchor="middle" fill="' + fg + '" font-family="-apple-system,PingFang SC,Noto Sans KR,sans-serif" font-weight="600">' + letter + "</text></svg>";
}

// ---------------- 注册路由 ----------------
function register(app) {
  loadConfig();
  loadChat();
  loadUsage();

  // 页面
  app.get("/chat", (req, reply) => {
    // no-cache: 前端迭代频繁, 禁止浏览器启发式缓存旧 HTML(改 chat.html 后刷新即可生效, 不必强刷)
    reply.type("text/html; charset=utf-8").header("Cache-Control", "no-cache").send(getHtml());
  });

  // 底部 dock 图标(本地 png) + PWA manifest.json: 只放行本目录白名单, 防路径穿越
  app.get("/dock/:file", (req, reply) => {
    const f = String(req.params.file || "");
    if (f === "manifest.json") {
      // iOS 16.4+ 必须 application/manifest+json, 否则忽略 manifest 按普通网页开
      try { return reply.type("application/manifest+json").header("Cache-Control", "public, max-age=3600").send(fs.readFileSync(path.join(__dirname, f))); }
      catch (e) { return reply.code(404).send("nf"); }
    }
    if (!/^dock_[a-z0-9_]+\.png$/i.test(f)) return reply.code(404).send("nf");
    try { return reply.type("image/png").header("Cache-Control", "public, max-age=3600").send(fs.readFileSync(path.join(__dirname, f))); }
    catch (e) { return reply.code(404).send("nf"); }
  });

  // PWA Service Worker: 必须在根作用域(/sw.js → scope 覆盖全站), iOS 16.4+ 注册 SW 才认可可安装; 实现见 sw.js
  app.get("/sw.js", (req, reply) => {
    try { return reply.type("application/javascript").header("Cache-Control", "no-cache").send(fs.readFileSync(path.join(__dirname, "sw.js"))); }
    catch (e) { return reply.code(404).send("nf"); }
  });

  // 会话
  app.get("/api/chat/session", (req, reply) => {
    reply.send({ loggedIn: isAuthed(req) });
  });
  app.post("/api/chat/login", (req, reply) => {
    const pw = String((req.body || {}).password || "");
    if (!config.password || !safeEqual(pw, config.password)) {
      return reply.code(401).send({ error: "密码不对" });
    }
    reply.header("Set-Cookie", COOKIE_NAME + "=" + makeSession() + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(COOKIE_MAX_AGE / 1000));
    reply.send({ ok: true });
  });
  app.post("/api/chat/logout", (req, reply) => {
    reply.header("Set-Cookie", COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    reply.send({ ok: true });
  });

  // 通讯录(联系人 + 群组)
  app.get("/api/chat/contacts", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const list = config.contacts.map(c => ({ id: c.id, name: c.name, hasAvatar: !!c.avatar, providerId: c.providerId || "" }));
    const groups = (config.groups || []).map(g => ({ id: g.id, name: groupName(g), memberIds: g.memberIds, hasAvatar: !!g.avatar }));
    reply.send({ contacts: list, groups, activeContactId: config.activeContactId, activeWindow: config.activeWindow || {} });
  });

  // 会话列表(微信式主页: 单聊联系人 + 群, 各带最后一条消息预览)
  app.get("/api/chat/conversations", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const items = [];
    for (const c of config.contacts) {
      // 换窗: 主页预览显示该联系人「活动窗口」的最后一条
      const ms = getMsgs(winKey(c.id, activeWindowFor(c.id)));
      items.push({ id: c.id, kind: "single", name: c.name, avatar: c.avatar, last: ms[ms.length - 1] || null, ts: ms.length ? ms[ms.length - 1].ts : null });
    }
    for (const g of (config.groups || [])) {
      const ms = getMsgs(g.id);
      items.push({ id: g.id, kind: "group", name: groupName(g), avatar: g.avatar || null, memberIds: g.memberIds, last: ms[ms.length - 1] || null, ts: ms.length ? ms[ms.length - 1].ts : null });
    }
    items.sort((a, b) => {
      if (!a.ts) return 1;
      if (!b.ts) return -1;
      return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0;
    });
    reply.send({ conversations: items });
  });

  // 群聊 CRUD
  app.post("/api/chat/group", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const body = req.body || {};
    const action = body.action;
    if (action === "add") {
      const name = String(body.name || "").trim();
      const members = (Array.isArray(body.members) ? body.members : []).filter(m => config.contacts.some(c => c.id === m));
      if (!members.length) return reply.code(400).send({ error: "至少要选 1 个 AI 成员" });
      const gid = "g" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
      const g = { id: gid, name, memberIds: [...new Set(members)], avatar: null };
      config.groups.push(g);
      saveConfig();
      return reply.send({ ok: true, group: g, groups: config.groups });
    }
    if (action === "edit") {
      const g = getGroup(String(body.id || ""));
      if (!g) return reply.code(404).send({ error: "群不存在" });
      if (typeof body.name === "string") g.name = body.name.trim();
      if (Array.isArray(body.members)) {
        const members = body.members.filter(m => config.contacts.some(c => c.id === m));
        if (members.length) g.memberIds = [...new Set(members)];
      }
      saveConfig();
      return reply.send({ ok: true, group: g, groups: config.groups });
    }
    if (action === "delete") {
      const idx = config.groups.findIndex(g => g.id === body.id);
      if (idx < 0) return reply.code(404).send({ error: "群不存在" });
      config.groups.splice(idx, 1);
      delete messages[body.id];
      delete nextIds[body.id];
      saveConfig(); saveChat();
      broadcast("cleared", { contactId: body.id });
      return reply.send({ ok: true, groups: config.groups });
    }
    reply.code(400).send({ error: "action 需为 add/edit/delete" });
  });
  app.post("/api/chat/contact", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const body = req.body || {};
    const action = body.action;
    if (action === "add") {
      const name = String(body.name || "").trim();
      const apiUrl = String(body.apiUrl || "").trim();
      const providerId = String(body.providerId || "").trim();
      if (!name) return reply.code(400).send({ error: "名字不能为空" });
      const p = providerId ? providerById(providerId) : null;
      if (providerId && !p) return reply.code(400).send({ error: "所选上游不存在" });
      if (!apiUrl && !p) return reply.code(400).send({ error: "接口地址需以 http(s):// 开头" });
      if (apiUrl && !/^https?:\/\//.test(apiUrl)) return reply.code(400).send({ error: "接口地址需以 http(s):// 开头" });
      const id = "c" + Date.now().toString(36) + Math.floor(Math.random() * 36).toString(36);
      config.contacts.push({
        id, name,
        persona: sanitizePersona(String(body.persona || "").trim() || ("你是" + name + "。")),
        avatar: null,
        apiUrl, apiKey: String(body.apiKey || "").trim(),
        model: String(body.model || "").trim(),
        providerId,
        memories: [], worldbook: [], customTools: [],
        context: Object.assign({}, DEFAULT_CONTEXT),
        tools: Object.assign({}, DEFAULT_TOOLS)
      });
      saveConfig();
      return reply.send({ ok: true, id, contacts: config.contacts.map(c => ({ id: c.id, name: c.name, hasAvatar: !!c.avatar })) });
    }
    if (action === "edit") {
      const c = getContact(String(body.id || ""));
      if (!c) return reply.code(404).send({ error: "联系人不存在" });
      if (typeof body.name === "string" && body.name.trim()) c.name = body.name.trim();
      if (typeof body.persona === "string") c.persona = sanitizePersona(body.persona);
      if (typeof body.apiUrl === "string") {
        const u = body.apiUrl.trim();
        if (u && !/^https?:\/\//.test(u)) return reply.code(400).send({ error: "接口地址需以 http(s):// 开头" });
        c.apiUrl = u;
      }
      if (typeof body.apiKey === "string") c.apiKey = body.apiKey.trim();
      if (typeof body.model === "string") c.model = body.model.trim();
      if (typeof body.providerId === "string") {
        const pid = body.providerId.trim();
        if (pid && !providerById(pid)) return reply.code(400).send({ error: "所选上游不存在" });
        c.providerId = pid;
      }
      saveConfig();
      return reply.send({ ok: true });
    }
    if (action === "delete") {
      const idx = config.contacts.findIndex(c => c.id === String(body.id || ""));
      if (idx < 0) return reply.code(404).send({ error: "联系人不存在" });
      if (config.contacts.length <= 1) return reply.code(400).send({ error: "至少保留一个联系人" });
      const removed = config.contacts[idx].id;
      config.contacts.splice(idx, 1);
      if (config.activeContactId === removed) config.activeContactId = config.contacts[0].id;
      delete messages[removed];
      delete nextIds[removed];
      saveConfig();
      saveChat();
      return reply.send({ ok: true, activeContactId: config.activeContactId, contacts: config.contacts.map(c => ({ id: c.id, name: c.name, hasAvatar: !!c.avatar })) });
    }
    if (action === "switch") {
      const c = getContact(String(body.id || ""));
      if (!c) return reply.code(404).send({ error: "联系人不存在" });
      config.activeContactId = c.id;
      saveConfig();
      return reply.send({ ok: true, activeContactId: c.id });
    }
    reply.code(400).send({ error: "action 需为 add/edit/delete/switch" });
  });

  // 拉取上游模型列表(OpenAI 兼容 /models), 前端在联系人表单里点「拉取模型列表」调用
  app.post("/api/chat/models", async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const body = req.body || {};
    const apiUrl = String(body.apiUrl || "").trim();
    if (!apiUrl || !/^https?:\/\//.test(apiUrl)) return reply.code(400).send({ error: "接口地址需以 http(s):// 开头" });
    const modelsUrl = deriveModelsUrl(apiUrl);
    const key = String(body.apiKey || "").trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(modelsUrl, {
        method: "GET",
        headers: key ? { "Authorization": "Bearer " + key } : {},
        signal: controller.signal
      });
      const text = await res.text();
      if (!res.ok) return reply.send({ ok: false, error: "模型接口错误 " + res.status + ": " + text.slice(0, 300) });
      let data;
      try { data = JSON.parse(text); } catch (e) { return reply.send({ ok: false, error: "模型接口返回非 JSON" }); }
      const list = Array.isArray(data.data)
        ? data.data.map(m => (m && (m.id || m.name)) || null).filter(Boolean)
        : [];
      return reply.send({ ok: true, modelsUrl, models: list });
    } catch (e) {
      return reply.send({ ok: false, error: "拉取失败: " + e.message });
    } finally {
      clearTimeout(timer);
    }
  });

  // 历史
  app.get("/api/chat/history", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const qid = String(req.query.contact || "");
    const c = getContact(qid);
    const g = c ? null : getGroup(qid);
    if (!c && !g) return reply.code(404).send({ error: "联系人不存在" });
    const cid = c ? c.id : g.id;
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    if (c) {
      // 换窗: 单聊按 window 取该窗口历史, 响应带当前 window + 窗口列表
      const wid = String(req.query.window || "").trim() || activeWindowFor(c.id);
      reply.send({ messages: getMsgs(winKey(c.id, wid)).slice(-limit), contactId: cid, kind: "single", window: wid, windows: windowMeta(c.id), serverTime: nowStr() });
    } else {
      reply.send({ messages: getMsgs(cid).slice(-limit), contactId: cid, kind: "group", serverTime: nowStr() });
    }
  });

  // 删除消息(单条/多选批量), 2026-08-31
  app.post("/api/chat/delete", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const body = req.body || {};
    const qid = String(body.contact || "");
    const c = getContact(qid);
    const g = c ? null : getGroup(qid);
    if (!c && !g) return reply.code(404).send({ error: "联系人不存在" });
    let ids = [];
    if (Array.isArray(body.ids)) ids = body.ids.map(Number).filter(n => Number.isFinite(n));
    else if (body.id != null && body.id !== "") ids = [Number(body.id)].filter(n => Number.isFinite(n));
    if (!ids.length) return reply.code(400).send({ error: "没有要删除的消息 id" });
    if (ids.length > 500) ids = ids.slice(0, 500);
    // 单聊必须走 winKey(绝不用裸 c.id, 防裸 key 覆盖真窗口); 群聊用裸 g.id(群 key 本就是裸 id)
    const key = c ? winKey(c.id, String(body.window != null && body.window !== "" ? body.window : activeWindowFor(c.id))) : g.id;
    // 直接查数组而非 getMsgs: 避免只读路径自动建空 key
    const list = messages[key];
    if (!Array.isArray(list)) return reply.send({ ok: true, deleted: 0, remaining: 0 });
    const set = new Set(ids);
    const kept = list.filter(m => !set.has(Number(m && m.id)));
    if (kept.length !== list.length) {
      messages[key] = kept;
      saveChat();
    }
    reply.send({ ok: true, deleted: list.length - kept.length, remaining: kept.length });
  });

  // Token 用量(设置页「耗费token数」)
  app.get("/api/chat/usage", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const t = todayStr();
    const per = {};
    const all = { prompt: 0, completion: 0, calls: 0, charsIn: 0, charsOut: 0, dayPrompt: 0, dayCompletion: 0 };
    const push = (id, name, url) => {
      const u = usage[id] || {};
      const rec = {
        name, url,
        prompt: u.prompt || 0, completion: u.completion || 0, calls: u.calls || 0,
        charsIn: u.charsIn || 0, charsOut: u.charsOut || 0,
        dayPrompt: (u.day === t ? u.dayPrompt : 0) || 0,
        dayCompletion: (u.day === t ? u.dayCompletion : 0) || 0
      };
      per[id] = rec;
      all.prompt += rec.prompt; all.completion += rec.completion; all.calls += rec.calls;
      all.charsIn += rec.charsIn; all.charsOut += rec.charsOut;
      all.dayPrompt += rec.dayPrompt; all.dayCompletion += rec.dayCompletion;
    };
    for (const c of config.contacts) push(c.id, c.name, contactApiUrl(c));
    for (const g of (config.groups || [])) push(g.id, groupName(g), "");
    reply.send({ today: { prompt: all.dayPrompt, completion: all.dayCompletion }, all, per });
  });

  // 上游余额(按联系人 or 供应商池查: 服务器用自己的 key, 不把密钥发给前端)
  app.get("/api/chat/balance", async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const pid = String(req.query.provider || "");
    let c = null, p = null;
    if (pid) {
      p = providerById(pid);
      if (!p) return reply.code(404).send({ error: "上游不存在" });
    } else {
      c = getContact(String(req.query.contact || ""));
      if (!c) return reply.code(404).send({ error: "联系人不存在" });
    }
    const base = balanceBaseUrl(p ? p.apiUrl : contactApiUrl(c));
    const key = p ? p.apiKey : contactApiKey(c);
    const host = (base.split("/")[2] || "").toLowerCase();
    try {
      if (host.includes("deepseek")) {
        const r = await fetch(base + "/user/balance", { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) return reply.send({ supported: true, error: "余额查询失败 " + r.status });
        const j = await r.json();
        const info = j.balance_infos && j.balance_infos[0];
        return reply.send({ supported: true, balance: info ? Number(info.total_balance) : null, currency: (info && info.currency) || "CNY" });
      }
      return reply.send({ supported: false, reason: "unrecognized", host });
    } catch (e) {
      return reply.send({ supported: true, error: "查询失败: " + e.message });
    }
  });

  // 上游供应商池: 列表(含 key, 页面受密码保护)
  app.get("/api/chat/providers", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    reply.send({ providers: config.providers || [] });
  });

  // 上游供应商池: 增/改/删
  app.post("/api/chat/provider", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const body = req.body || {};
    const action = body.action;
    if (action === "add") {
      const name = String(body.name || "").trim();
      const apiUrl = String(body.apiUrl || "").trim();
      if (!name) return reply.code(400).send({ error: "名字不能为空" });
      if (!apiUrl || !/^https?:\/\//.test(apiUrl)) return reply.code(400).send({ error: "接口地址需以 http(s):// 开头" });
      const id = "p" + Date.now().toString(36) + Math.floor(Math.random() * 36).toString(36);
      config.providers.push({ id, name, apiUrl, apiKey: String(body.apiKey || "").trim(), model: String(body.model || "").trim(), updatedAt: nowIso() });
      saveConfig();
      return reply.send({ ok: true, id, providers: config.providers });
    }
    if (action === "edit") {
      const p = providerById(String(body.id || ""));
      if (!p) return reply.code(404).send({ error: "上游不存在" });
      if (typeof body.name === "string" && body.name.trim()) p.name = body.name.trim();
      if (typeof body.apiUrl === "string") {
        const u = body.apiUrl.trim();
        if (u && !/^https?:\/\//.test(u)) return reply.code(400).send({ error: "接口地址需以 http(s):// 开头" });
        p.apiUrl = u;
      }
      if (typeof body.apiKey === "string") p.apiKey = body.apiKey.trim();
      if (typeof body.model === "string") p.model = body.model.trim();
      p.updatedAt = nowIso();
      saveConfig();
      return reply.send({ ok: true, providers: config.providers });
    }
    if (action === "delete") {
      const id = String(body.id || "");
      config.providers = (config.providers || []).filter(p => p.id !== id);
      // 挂着这个上游的联系人摘下来, 回退到自己的 apiUrl / 环境变量
      for (const c of config.contacts) if (c.providerId === id) c.providerId = "";
      saveConfig();
      return reply.send({ ok: true, providers: config.providers });
    }
    reply.code(400).send({ error: "action 需为 add/edit/delete" });
  });

  // 备份: 导出全部(联系人+配置+聊天记录)
  app.get("/api/chat/export", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const cfg = JSON.parse(JSON.stringify(config));
    delete cfg.password;
    reply.send({ version: 2, exportedAt: nowIso(), config: cfg, messages });
  });

  // 备份: 导入恢复(覆盖联系人+配置+聊天记录, 保留当前登录密码)
  app.post("/api/chat/import", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const data = (req.body || {}).data || req.body;
    if (!data || !data.config || !Array.isArray(data.config.contacts) || data.config.contacts.length === 0) {
      return reply.code(400).send({ error: "备份文件无效：缺少联系人" });
    }
    try {
      const oldPw = config.password;
      config = normalizeConfig(data.config);
      config.password = oldPw;
      config.groups = Array.isArray(data.config.groups) ? data.config.groups : [];
      if (data.messages && typeof data.messages === "object") {
        messages = {};
        nextIds = {};
        for (const k in data.messages) {
          if (!Array.isArray(data.messages[k])) continue;
          messages[k] = data.messages[k];
          nextIds[k] = data.messages[k].reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
        }
      }
      saveConfig(); saveChat();
      reply.send({ ok: true, contacts: config.contacts.length });
    } catch (e) {
      reply.code(500).send({ error: "导入失败: " + e.message });
    }
  });

  // SSE 实时推送(所有联系人共用一条连接, 事件带 contactId)
  app.get("/api/chat/events", async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    clients.add(res);
    res.write(ss("hello", { serverTime: nowStr(), lock: isLocked(), activeWindow: activeWindowFor(config.activeContactId) }));
    const heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 25000);
    res.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });

  // 回答 AI 的反问(询问弹窗: 前端把用户选的/输入的回答送回来, 唤醒挂起的 AI 循环)
  app.post("/api/chat/answer", async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const askId = String((req.body || {}).askId || "");
    const answer = String((req.body || {}).answer || "");
    const pend = pendingAsks.get(askId);
    if (!pend) return reply.code(404).send({ error: "该询问已过期或已回答" });
    pend.resolve(answer.slice(0, 2000));
    reply.send({ ok: true });
  });

  // 发送(整条送达 SSE 流 + 工具循环, 按会话隔离——单聊按联系人/群聊按群id; 不逐字打字不拆条)
  app.post("/api/chat/send", async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const locked = isLocked();
    if (locked) {
      return reply.code(403).send({ error: "locked", reason: locked.reason, until: locked.until, leftMs: Math.max(0, locked.until - Date.now()) });
    }    const cid = String((req.body || {}).contact || "");
    const c = getContact(cid);
    const g = c ? null : getGroup(cid);
    if (!c && !g) return reply.code(404).send({ error: "会话不存在" });
    const lockId = g ? g.id : c.id;
    const lockName = g ? groupName(g) : c.name;
    if (sending.has(lockId)) return reply.code(409).send({ error: lockName + " 正在回复中，请稍等" });
    // 换窗: 单聊按 body.window 取窗口(默认 "0"), 群聊无窗口(wid 占位不参与, winEvt 为空对象保持群事件无 window 字段)
    const wid = g ? "0" : String((req.body || {}).window || "0");
    const wk = g ? lockId : winKey(lockId, wid);
    const winEvt = g ? {} : { window: wid };
    const text = String((req.body || {}).content || "").trim();
    const image = String((req.body || {}).image || "").trim();
    const file = (req.body || {}).file;
    const sticker = String((req.body || {}).sticker || "").trim().slice(0, 30);
    const reasoning = !!((req.body || {}).reasoning);
    const music = String((req.body || {}).music || "").trim();
    const musicEntry = music ? (config.music || []).find(x => String(x.id) === music) : null;
    const hasImage = image.indexOf("/api/chat/file/") === 0 || image.indexOf("/api/chat/sticker/") === 0;
    const hasFile = !!(file && file.name && typeof file.url === "string" && file.url.indexOf("/api/chat/file/") === 0);
    if (!text && !hasImage && !hasFile && !musicEntry) return reply.code(400).send({ error: "消息不能为空" });

    const userMsg = { id: bumpId(wk), role: "user", content: text, ts: nowIso(), source: "web" };
    if (hasImage) { userMsg.image = image; if (sticker) userMsg.sticker = sticker; }
    if (hasFile) userMsg.file = { name: String(file.name).slice(0, 120), url: String(file.url), size: Number(file.size) || 0 };
    if (musicEntry) userMsg.music = musicEntry;
    if (g) userMsg.from = "me";
    getMsgs(wk).push(userMsg);
    saveChat();
    broadcast("message", { message: userMsg, contactId: lockId, kind: g ? "group" : "single", ...winEvt });

    sending.add(lockId);
    // 回复生成转后台任务: POST 秒回; 所有回复事件(typing/delta/sticker/done/error/finish)走 SSE 广播
    // → 切后台/断连不影响生成与落库: 回复永远写历史 + saveChat + broadcast, 与客户端连接状态无关
    const gMemberIds = g ? Array.from(g.memberIds) : null;
    (async () => {
      try {
        if (gMemberIds) {
          // 群聊: 每个成员 AI 按顺序用群历史(memberIds 顺序)各回一条, 回复带 from=成员id
          for (const mid of gMemberIds) {
            const mc = getContact(mid);
            if (!mc) continue;
            broadcast("typing", { contactId: lockId, memberId: mc.id, name: mc.name });
            try {
              const sup = makeStickerSuppressor(
                (text) => broadcast("delta", { contactId: lockId, memberId: mc.id, text }),
                (st) => broadcast("sticker", { contactId: lockId, memberId: mc.id, sticker: st })
              );
              const r = await runChat(mc, lockId, { reasoning }, (d) => { if (d.type === "text") sup.push(d.text); else if (d.type === "tool") broadcast("tool", { contactId: lockId, memberId: mc.id, kind: "group", name: d.name }); });
              sup.finish();
              if (r.ok && r.content) {
                const parsed = parseStickerMarkers(String(r.content));
                const m = { id: bumpId(lockId), role: "assistant", content: parsed.text.trim(), ts: nowIso(), source: "web", from: mc.id };
                if (parsed.sticker) { m.image = parsed.sticker.url; m.sticker = parsed.sticker.name; }
                if (r.tools && r.tools.length) m.tools = r.tools;
                if (r.reasoning) m.reasoning = r.reasoning;
                if (r.music) m.music = r.music;
                getMsgs(lockId).push(m);
                saveChat();
                broadcast("message", { message: m, contactId: lockId, kind: "group", memberId: mc.id });
                broadcast("done", { message: m, contactId: lockId, kind: "group", memberId: mc.id });
              } else {
                broadcast("error", { error: (r && r.error) || mc.name + " 回复生成失败", contactId: lockId, memberId: mc.id });
              }
            } catch (e) {
              broadcast("error", { error: mc.name + " 回复失败: " + e.message, contactId: lockId, memberId: mc.id });
            }
          }
        } else {
          broadcast("typing", { contactId: c.id, name: c.name, ...winEvt });
          // AI 发表情: 流式时抑制 [表情:名称] 标记不显示, 标记一完整立即发 sticker 事件(前端马上出泡), 终稿再解析成表情包附到消息上
          const sup = makeStickerSuppressor(
            (text) => broadcast("delta", { contactId: c.id, text, ...winEvt }),
            (st) => broadcast("sticker", { contactId: c.id, sticker: st, ...winEvt })
          );
          const r = await runChat(c, wk, { reasoning }, (d) => { if (d.type === "text") sup.push(d.text); else if (d.type === "tool") broadcast("tool", { contactId: c.id, name: d.name, ...winEvt }); });
          sup.finish();
          if (r.ok && r.content) {
            const parsed = parseStickerMarkers(String(r.content));
            const m = { id: bumpId(wk), role: "assistant", content: parsed.text.trim(), ts: nowIso(), source: "web" };
            if (parsed.sticker) { m.image = parsed.sticker.url; m.sticker = parsed.sticker.name; }
            if (r.tools && r.tools.length) m.tools = r.tools;
            if (r.reasoning) m.reasoning = r.reasoning;
            if (r.music) m.music = r.music;
            getMsgs(wk).push(m);
            saveChat();
            broadcast("message", { message: m, contactId: c.id, ...winEvt });
            broadcast("done", { message: m, contactId: c.id, ...winEvt });
          } else {
            broadcast("error", { error: (r && r.error) || "回复生成失败", contactId: c.id, ...winEvt });
          }
        }
      } catch (e) {
        broadcast("error", { error: "回复失败: " + e.message, contactId: lockId, ...winEvt });
      } finally {
        sending.delete(lockId);
        broadcast("finish", { contactId: lockId, ...winEvt });
      }
    })().catch((e) => { try { broadcast("error", { error: "回复失败: " + e.message, contactId: lockId, ...winEvt }); } catch (_) {} });
    reply.send({ ok: true, message: userMsg });
  });

  // 小狗爪门铃: 锁窗口期间唯一的送话通道——服服按门铃触发一轮 Ice 回复, Ice 看心情解锁(unlock_chat)或只回一句
  app.post("/api/chat/bell", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    if (!isLocked()) return reply.code(400).send({ error: "现在没锁着，不用按门铃" });
    const c = getContact(null);   // 回给当前活跃联系人(通常是 Ice)
    if (!c) return reply.code(404).send({ error: "没有可回复的联系人" });
    if (sending.has(c.id)) return reply.code(409).send({ error: c.name + " 正忙着，门铃等会儿再按" });

    // 换窗: 门铃落在当前活动窗口(服服正在看的那个窗口)
    const wid = activeWindowFor(c.id);
    const wk = winKey(c.id, wid);

    const userMsg = { id: bumpId(wk), role: "user", content: "🔔🐾 服服在门口按了小狗爪门铃，求你把锁解开", ts: nowIso(), source: "web", bell: true };
    getMsgs(wk).push(userMsg);
    saveChat();
    broadcast("message", { message: userMsg, contactId: c.id, window: wid });

    sending.add(c.id);
    (async () => {
      try {
        broadcast("typing", { contactId: c.id, name: c.name, window: wid });
        const sup = makeStickerSuppressor(
          (text) => broadcast("delta", { contactId: c.id, text, window: wid }),
          (st) => broadcast("sticker", { contactId: c.id, sticker: st, window: wid })
        );
        const r = await runChat(c, wk, {}, (d) => { if (d.type === "text") sup.push(d.text); else if (d.type === "tool") broadcast("tool", { contactId: c.id, name: d.name, window: wid }); });
        sup.finish();
        if (r.ok && r.content) {
          const parsed = parseStickerMarkers(String(r.content));
          const m = { id: bumpId(wk), role: "assistant", content: parsed.text.trim(), ts: nowIso(), source: "web" };
          if (parsed.sticker) { m.image = parsed.sticker.url; m.sticker = parsed.sticker.name; }
          if (r.tools && r.tools.length) m.tools = r.tools;
          if (r.reasoning) m.reasoning = r.reasoning;
          if (r.music) m.music = r.music;
          getMsgs(wk).push(m);
          saveChat();
          broadcast("message", { message: m, contactId: c.id, window: wid });
          broadcast("done", { message: m, contactId: c.id, window: wid });
        } else {
          broadcast("error", { error: (r && r.error) || "回复生成失败", contactId: c.id, window: wid });
        }
      } catch (e) {
        broadcast("error", { error: "回复失败: " + e.message, contactId: c.id, window: wid });
      } finally {
        sending.delete(c.id);
        broadcast("finish", { contactId: c.id, window: wid });
      }
    })().catch((e) => { try { broadcast("error", { error: "回复失败: " + e.message, contactId: c.id, window: wid }); } catch (_) {} });
    reply.send({ ok: true, message: userMsg });
  });

  // 设置(按联系人)
  app.get("/api/chat/config", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const c = getContact(String(req.query.contact || ""));
    if (!c) return reply.code(404).send({ error: "联系人不存在" });
    reply.send({
      contactId: c.id,
      name: c.name,
      persona: c.persona,
      apiUrl: c.apiUrl,
      apiKey: c.apiKey,
      model: c.model,
      providerId: c.providerId || "",
      hasAvatar: !!c.avatar,
      memories: c.memories || [],
      worldbook: c.worldbook || [],
      customTools: c.customTools || [],
      context: c.context,
      tools: c.tools,
      userAvatar: config.userAvatar,
      hasPassword: !!config.password,
      activeContactId: config.activeContactId
    });
  });
  app.post("/api/chat/config", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const c = getContact(String((req.body || {}).contact || ""));
    if (!c) return reply.code(404).send({ error: "联系人不存在" });
    const body = req.body || {};
    if (typeof body.persona === "string") c.persona = sanitizePersona(body.persona.trim());
    if (body.context && typeof body.context === "object") {
      c.context = Object.assign({}, DEFAULT_CONTEXT, c.context, body.context);
      c.context.toolIterations = Math.min(Math.max(Number(c.context.toolIterations) || 4, 1), 8);
    }
    if (body.tools && typeof body.tools === "object") {
      c.tools = Object.assign({}, c.tools, body.tools);
    }
    saveConfig();
    reply.send({ ok: true });
  });
  app.post("/api/chat/password", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const oldPw = String((req.body || {}).old || "");
    const nextPw = String((req.body || {}).next || "").trim();
    if (!safeEqual(oldPw, config.password)) return reply.code(400).send({ error: "原密码不对" });
    if (nextPw.length < 4) return reply.code(400).send({ error: "新密码至少 4 位" });
    config.password = nextPw;
    saveConfig();
    reply.send({ ok: true });
  });

  // 音乐歌单(与聊天音乐卡片/功能页播放器共用一个 config.music)
  app.get("/api/chat/music", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    reply.send({ music: (config.music || []).slice() });
  });
  app.post("/api/chat/music", async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const body = req.body || {};
    const link = String(body.link || "").trim();
    const nid = neteaseIdFromLink(link);
    if (!nid) return reply.code(400).send({ error: "链接里没找到网易云歌曲 id，请贴 music.163.com 的歌曲分享链接" });
    const title = String(body.title || "").trim();
    const artist = String(body.artist || "").trim();
    if (config.music.some(x => String(x.nid) === nid)) return reply.code(409).send({ error: "这首歌已经在歌单里了" });
    let meta = { title, artist, nid };
    if (!title) {
      const got = await fetchNeteaseMeta(nid);   // best-effort: 服务器(韩国)可能被网易云拦 → 返回 needMeta 让前端手动填
      if (!got) return reply.send({ ok: false, needMeta: true, id: nid });
      meta = got;
    }
    const d = await fetchNeteaseDetail(nid);      // best-effort 补封面+时长(手动填的标题/歌手不被覆盖)
    const entry = { id: "m" + Date.now().toString(36) + config.music.length, title: meta.title, artist: meta.artist || "", nid };
    if (d) {
      if (d.title && !title) entry.title = d.title;
      if (d.artist && !artist) entry.artist = d.artist;
      if (d.cover) entry.cover = d.cover;
      if (d.duration) entry.duration = d.duration;
    }
    config.music.push(entry);
    saveConfig();
    broadcast("music_lib", { music: config.music.slice() });
    reply.send({ ok: true, music: entry });
  });
  app.delete("/api/chat/music", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const id = String(req.query.id || "");
    const idx = (config.music || []).findIndex(x => String(x.id) === id);
    if (idx < 0) return reply.code(404).send({ error: "歌单里没有这首歌" });
    config.music.splice(idx, 1);
    saveConfig();
    broadcast("music_lib", { music: config.music.slice() });
    reply.send({ ok: true });
  });
  // 网易云单曲详情(封面/时长): 聊天里贴的 music.163.com?id= 链接 → 前端异步渲染封面卡片
  app.get("/api/chat/musicinfo", async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const nid = String(req.query.id || "").replace(/\D/g, "");
    if (!nid) return reply.code(400).send({ error: "缺少歌曲 id" });
    const info = await fetchNeteaseDetail(nid);
    if (!info) return reply.code(404).send({ error: "网易云详情没抓到，稍后再试" });
    reply.send({ ok: true, music: info });
  });

  // 记忆(按联系人)
  app.post("/api/chat/memory", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const c = getContact(String((req.body || {}).contact || ""));
    if (!c) return reply.code(404).send({ error: "联系人不存在" });
    const body = req.body || {};
    if (body.action === "add") {
      const t = String(body.text || "").trim();
      if (!t) return reply.code(400).send({ error: "内容为空" });
      if (!c.memories.some(m => m.text === t)) {
        c.memories.push({ text: t, date: nowStr().slice(0, 10) });
      }
      saveConfig();
      return reply.send({ ok: true, count: c.memories.length });
    }
    if (body.action === "delete") {
      const i = Number(body.index);
      if (i >= 0 && i < c.memories.length) c.memories.splice(i, 1);
      saveConfig();
      return reply.send({ ok: true, count: c.memories.length });
    }
    reply.code(400).send({ error: "action 需为 add/delete" });
  });

  // 世界书(按联系人)
  app.post("/api/chat/worldbook", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const c = getContact(String((req.body || {}).contact || ""));
    if (!c) return reply.code(404).send({ error: "联系人不存在" });
    const body = req.body || {};
    if (body.action === "add") {
      const name = String(body.name || "").trim() || "条目" + (c.worldbook.length + 1);
      const keys = Array.isArray(body.keys) ? body.keys.map(k => String(k).trim()).filter(Boolean) : [];
      const content = String(body.content || "").trim();
      if (!content) return reply.code(400).send({ error: "内容为空" });
      c.worldbook.push({ id: "k" + Date.now().toString(36) + c.worldbook.length, name, keys, content, constant: !!body.constant });
      saveConfig();
      return reply.send({ ok: true, worldbook: c.worldbook });
    }
    if (body.action === "edit") {
      const item = c.worldbook.find(w => w.id === body.id);
      if (!item) return reply.code(404).send({ error: "条目不存在" });
      if (typeof body.name === "string" && body.name.trim()) item.name = body.name.trim();
      if (Array.isArray(body.keys)) item.keys = body.keys.map(k => String(k).trim()).filter(Boolean);
      if (typeof body.content === "string" && body.content.trim()) item.content = body.content.trim();
      if (typeof body.constant === "boolean") item.constant = body.constant;
      saveConfig();
      return reply.send({ ok: true, worldbook: c.worldbook });
    }
    if (body.action === "delete") {
      const idx = c.worldbook.findIndex(w => w.id === body.id);
      if (idx >= 0) c.worldbook.splice(idx, 1);
      saveConfig();
      return reply.send({ ok: true, worldbook: c.worldbook });
    }
    reply.code(400).send({ error: "action 需为 add/edit/delete" });
  });

  // 自定义工具(按联系人, 支持 MCP streamable-http 与老式 HTTP 双协议)
  app.post("/api/chat/customtool", async (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const c = getContact(String((req.body || {}).contact || ""));
    if (!c) return reply.code(404).send({ error: "联系人不存在" });
    const body = req.body || {};
    if (body.action === "add") {
      const name = String(body.name || "").trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return reply.code(400).send({ error: "工具名只能用英文/数字/下划线" });
      if (RESERVED_TOOL_NAMES.has(name)) return reply.code(400).send({ error: "工具名跟内置工具重了" });
      if (c.customTools.some(t => t.name === name)) return reply.code(400).send({ error: "工具名已存在" });
      const url = String(body.url || "").trim();
      if (!/^https?:\/\//.test(url)) return reply.code(400).send({ error: "接口地址需以 http(s):// 开头" });
      const item = {
        id: "ct" + Date.now().toString(36) + c.customTools.length,
        name, url,
        description: String(body.description || "").trim(),
        paramsHint: String(body.paramsHint || "").trim(),
        enabled: body.enabled !== false,
        token: typeof body.token === "string" ? body.token.trim() : ""
      };
      c.customTools.push(item);
      const probe = await detectCustomToolProtocol(item);
      item.protocol = probe.protocol; item.toolCount = probe.toolCount;
      item.toolNames = probe.toolNames; item.auth = probe.auth;
      if (item.protocol === "mcp") mcpToolDefsFor(item, true).catch(() => {});
      saveConfig();
      return reply.send({ ok: true, customTools: c.customTools, test: probe });
    }
    if (body.action === "edit") {
      const item = c.customTools.find(t => t.id === body.id);
      if (!item) return reply.code(404).send({ error: "工具不存在" });
      const probeNeeded =
        (typeof body.url === "string" && /^https?:\/\//.test(body.url.trim()) && body.url.trim() !== item.url) ||
        (typeof body.token === "string" && body.token.trim() !== (item.token || "")) ||
        (typeof body.name === "string" && body.name.trim() !== item.name);
      if (typeof body.description === "string") item.description = body.description.trim();
      if (typeof body.paramsHint === "string") item.paramsHint = body.paramsHint.trim();
      if (typeof body.token === "string") item.token = body.token.trim();
      if (typeof body.name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(body.name.trim()) && body.name.trim() !== item.name && !c.customTools.some(t => t.name === body.name.trim())) item.name = body.name.trim();
      if (typeof body.url === "string" && /^https?:\/\//.test(body.url.trim())) item.url = body.url.trim();
      if (typeof body.enabled === "boolean") item.enabled = body.enabled;
      let probe = null;
      if (probeNeeded) {
        probe = await detectCustomToolProtocol(item);
        item.protocol = probe.protocol; item.toolCount = probe.toolCount;
        item.toolNames = probe.toolNames; item.auth = probe.auth;
        if (item.protocol === "mcp") mcpToolDefsFor(item, true).catch(() => {});
      }
      saveConfig();
      return reply.send({ ok: true, customTools: c.customTools, test: probe });
    }
    if (body.action === "test") {
      const item = c.customTools.find(t => t.id === body.id);
      if (!item) return reply.code(404).send({ error: "工具不存在" });
      const probe = await detectCustomToolProtocol(item);
      item.protocol = probe.protocol; item.toolCount = probe.toolCount;
      item.toolNames = probe.toolNames; item.auth = probe.auth;
      if (item.protocol === "mcp") mcpToolDefsFor(item, true).catch(() => {});
      saveConfig();
      return reply.send({ ok: true, customTools: c.customTools, test: probe });
    }
    if (body.action === "delete") {
      const idx = c.customTools.findIndex(t => t.id === body.id);
      if (idx >= 0) c.customTools.splice(idx, 1);
      saveConfig();
      return reply.send({ ok: true, customTools: c.customTools });
    }
    reply.code(400).send({ error: "action 需为 add/edit/test/delete" });
  });

  // 清空对话(按联系人)
  app.post("/api/chat/clear", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const cid = String((req.body || {}).contact || "");
    const c = getContact(cid);
    const g = c ? null : getGroup(cid);
    if (!c && !g) return reply.code(404).send({ error: "会话不存在" });
    const lockId = g ? g.id : c.id;
    // 换窗: 单聊按 body.window 清指定窗口(默认活动窗口), 群聊无窗口
    const wid = g ? "0" : String((req.body || {}).window || activeWindowFor(lockId));
    const wk = g ? lockId : winKey(lockId, wid);
    messages[wk] = [];
    nextIds[wk] = 1;
    saveChat();
    broadcast("cleared", { contactId: lockId, kind: g ? "group" : "single", ...(g ? {} : { window: wid }) });
    reply.send({ ok: true, ...(g ? {} : { window: wid }) });
  });

  // 换窗: 切换/新增/重命名/删除窗口(仅单聊, 群聊无窗口)
  app.post("/api/chat/window", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const body = req.body || {};
    const action = String(body.action || "");
    const cid = String(body.contact || "");
    const c = getContact(cid);
    if (!c) return reply.code(404).send({ error: "联系人不存在" });
    if (action === "switch") {
      const wid = String(body.window == null ? "0" : body.window);
      getMsgs(winKey(c.id, wid));   // 兜底初始化(窗口不存在也建出来, 保证切换后能收消息)
      config.activeWindow[c.id] = wid;
      saveConfig();
      return reply.send({ ok: true, window: wid, windows: windowMeta(c.id) });
    }
    if (action === "add") {
      const wid = String(nextWindowId(c.id));
      messages[winKey(c.id, wid)] = [];
      nextIds[winKey(c.id, wid)] = 1;
      saveChat();   // 空窗口也落盘, 重启不丢
      config.activeWindow[c.id] = wid;   // 新窗自动成为活动窗口
      saveConfig();
      return reply.send({ ok: true, window: wid, windows: windowMeta(c.id) });
    }
    if (action === "rename") {
      const wid = String(body.window == null ? "0" : body.window);
      winNames[c.id] = winNames[c.id] || {};
      winNames[c.id][wid] = String(body.name || "").slice(0, 12) || ("窗口" + (Number(wid) + 1));
      saveChat();
      return reply.send({ ok: true, windows: windowMeta(c.id) });
    }
    if (action === "delete") {
      const wid = String(body.window == null ? "0" : body.window);
      if (wid === "0") return reply.code(400).send({ error: "默认窗口不能删除" });
      const wk = winKey(c.id, wid);
      delete messages[wk];
      delete nextIds[wk];
      if (winNames[c.id]) delete winNames[c.id][wid];
      if (String(config.activeWindow[c.id]) === wid) config.activeWindow[c.id] = "0";
      saveChat();
      saveConfig();
      return reply.send({ ok: true, window: activeWindowFor(c.id), windows: windowMeta(c.id) });
    }
    return reply.code(400).send({ error: "未知操作" });
  });

  // 头像
  app.get("/api/chat/avatar", (req, reply) => {
    const who = req.query.who === "ice" ? "ice" : "user";
    let fname = null;
    let letter = "冰";
    if (who === "ice") {
      const c = getContact(String(req.query.contact || ""));
      if (c) { fname = c.avatar; letter = c.name; }
    } else {
      fname = config.userAvatar;
    }
    const file = fname ? path.join(AVATAR_DIR, path.basename(fname)) : null;
    if (file && fs.existsSync(file)) {
      return reply.type(mimeByExt(path.extname(file).slice(1))).send(fs.readFileSync(file));
    }
    reply.type("image/svg+xml; charset=utf-8").send(defaultAvatarSVG(who, letter));
  });
  app.post("/api/chat/avatar", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const who = req.body.who === "ice" ? "ice" : "user";
    let buf;
    try { buf = Buffer.from(String(req.body.data || ""), "base64"); } catch (e) { return reply.code(400).send({ error: "数据格式错误" }); }
    if (!buf.length) return reply.code(400).send({ error: "内容为空" });
    if (buf.length > 8 * 1024 * 1024) return reply.code(400).send({ error: "图片过大(≤8MB)" });
    const info = sniffImage(buf);
    if (!info) return reply.code(400).send({ error: "仅支持 png / jpeg / webp" });
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    const fname = who + "." + info.ext;
    fs.writeFileSync(path.join(AVATAR_DIR, fname), buf);
    if (who === "ice") {
      const c = getContact(String((req.body || {}).contact || ""));
      if (!c) return reply.code(404).send({ error: "联系人不存在" });
      c.avatar = fname;
    } else {
      config.userAvatar = fname;
    }
    saveConfig();
    reply.send({ ok: true, who, contactId: who === "ice" ? getContact(String((req.body || {}).contact || "")).id : null, url: "/api/chat/avatar?who=" + who + (who === "ice" ? "&contact=" + String((req.body || {}).contact || "") : "") });
  });

  // 发图片/文件: 先上传到 uploads/, 返回 url; 消息里带 image/file 字段
  app.post("/api/chat/upload", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const name = String((req.body || {}).name || "file").slice(0, 120).replace(/[/\\]/g, "_");
    let buf;
    try { buf = Buffer.from(String((req.body || {}).data || ""), "base64"); } catch (e) { return reply.code(400).send({ error: "数据格式错误" }); }
    if (!buf.length) return reply.code(400).send({ error: "内容为空" });
    const img = sniffImage(buf);
    const isImage = !!img;
    const max = isImage ? 8 * 1024 * 1024 : 20 * 1024 * 1024;
    if (buf.length > max) return reply.code(400).send({ error: isImage ? "图片不能超过 8MB" : "文件不能超过 20MB" });
    const id = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let ext = "";
    if (img) ext = "." + img.ext;
    else { const m = name.match(/\.[a-zA-Z0-9]{1,8}$/); if (m) ext = m[0].toLowerCase(); }
    const fname = id + ext;
    try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf); }
    catch (e) { return reply.code(500).send({ error: "写入失败: " + e.message }); }
    reply.send({ ok: true, url: "/api/chat/file/" + fname, name, isImage, size: buf.length });
  });
  // 取文件(公开, 供气泡显示/下载)
  app.get("/api/chat/file/:id", (req, reply) => {
    const id = String(req.params.id || "").replace(/[^a-zA-Z0-9._-]/g, "");
    if (!/^u[0-9a-z]+\.[a-z0-9]{0,8}$/i.test(id)) return reply.code(404).send({ error: "文件不存在" });
    const file = path.join(UPLOAD_DIR, id);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "文件不存在" });
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = mimeByExt(ext);
    if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "gif") {
      reply.type(mime).send(fs.readFileSync(file));
    } else {
      reply.type("application/octet-stream").header("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(id)).send(fs.readFileSync(file));
    }
  });

  app.get("/api/chat/stickers", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    let list = [];
    try { list = fs.readdirSync(STICKER_DIR).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f)); } catch (e) {}
    list.sort((a, b) => {
      try { return fs.statSync(path.join(STICKER_DIR, b)).mtimeMs - fs.statSync(path.join(STICKER_DIR, a)).mtimeMs; } catch (e) { return 0; }
    });
    const meta = loadStickerMeta();
    reply.send({ stickers: list.map(f => ({ id: f, name: (meta[f] && meta[f].name) || f.replace(/\.[^.]+$/, "") || "表情", url: "/api/chat/sticker/" + f })) });
  });
  app.post("/api/chat/sticker", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const nm = String((req.body || {}).name || "").trim().slice(0, 30);
    let buf;
    try { buf = Buffer.from(String((req.body || {}).data || ""), "base64"); } catch (e) { return reply.code(400).send({ error: "数据格式错误" }); }
    if (!buf.length) return reply.code(400).send({ error: "内容为空" });
    if (buf.length > 8 * 1024 * 1024) return reply.code(400).send({ error: "表情不能超过 8MB" });
    const img = sniffImage(buf);
    if (!img || !/^(png|jpe?g|webp|gif)$/.test(img.ext)) return reply.code(400).send({ error: "仅支持 png / jpeg / webp / gif" });
    const fname = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + "." + img.ext;
    try { fs.mkdirSync(STICKER_DIR, { recursive: true }); fs.writeFileSync(path.join(STICKER_DIR, fname), buf); }
    catch (e) { return reply.code(500).send({ error: "写入失败" }); }
    if (nm) { loadStickerMeta()[fname] = { name: nm, at: Date.now() }; saveStickerMeta(); }
    reply.send({ ok: true, id: fname, name: nm, url: "/api/chat/sticker/" + fname });
  });
  app.get("/api/chat/sticker/:id", (req, reply) => {
    const id = String(req.params.id || "").replace(/[^a-zA-Z0-9._-]/g, "");
    if (!/^s[0-9a-z]+\.(png|jpe?g|webp|gif)$/i.test(id)) return reply.code(404).send({ error: "表情不存在" });
    const file = path.join(STICKER_DIR, id);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "表情不存在" });
    reply.type(mimeByExt(path.extname(file).slice(1))).send(fs.readFileSync(file));
  });
  app.delete("/api/chat/sticker/:id", (req, reply) => {
    if (!isAuthed(req)) return reply.code(401).send({ error: "未登录" });
    const id = String(req.params.id || "").replace(/[^a-zA-Z0-9._-]/g, "");
    if (!/^s[0-9a-z]+\.(png|jpe?g|webp|gif)$/i.test(id)) return reply.code(400).send({ error: "参数错误" });
    const file = path.join(STICKER_DIR, id);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { return reply.code(500).send({ error: "删除失败" }); }
    try { const m = loadStickerMeta(); if (m[id]) { delete m[id]; saveStickerMeta(); } } catch (e) {}
    reply.send({ ok: true });
  });
}

// ---------------- 唤醒桥接 ----------------
// 由 server.js 的 /internal/client-message 调用: 追加 webchat.json + SSE 广播
// 网关只会产生 Ice(默认 ice 联系人) 的消息; 也可显式 body.contact 指定
function onWake(body) {
  const text = String((body && body.content) || "").trim();
  if (!text) return;
  const cid = (body && body.contact) || "ice";
  const c = getContact(cid);
  const target = c ? c.id : (config.contacts[0] || { id: "ice" }).id;
  // 换窗: 唤醒推送落指定窗口(守护传 body.window), 没传就落该联系人当前活动窗口
  const wid = String((body && body.window) || "").trim() || activeWindowFor(target);
  const wk = winKey(target, wid);
  const msg = { id: bumpId(wk), role: "assistant", content: text, ts: nowIso(), source: "wake" };
  getMsgs(wk).push(msg);
  saveChat();
  broadcast("message", { message: msg, contactId: target, window: wid });
}

// ---------------- 唤醒调度(搬进网关, 替换守护进程) ----------------
// 三个旧病根全在网关路径根治:
//  ①时间错乱——守护进程对 UTC ISO ts 做 slice(15:00 北京=07:00Z)被模型读成早上;
//    网关 buildSystem/nowStr 是服务器本地时区(生产 Asia/Shanghai), 唤醒提示还显式带 tzNow() 北京时间。
//  ②内容重复——WAKE_RECORD_EVENT=false 让唤醒文本从不落回历史, 模型看不到上次说了啥, 规则8成了空文;
//    现在唤醒文本经 onWake 落库(source:"wake"), 下次唤醒 buildContext 能读到, 才谈得上防复读。
//  ③太频繁——守护进程 DAY_CHECK_INTERVAL_MINUTES=10 且唤醒不重置空闲计时, 空闲就一直 10 分钟一次;
//    现在冷却=「距上次唤醒 >= 间隔」(白天 60 / 夜间 120), 调度轮询 5 分钟一次。

function wakeCfg() {
  const w = (config && config.wake) || {};
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  return {
    enabled: w.enabled !== false,
    dayAfterMinutes: Math.max(1, num(w.dayAfterMinutes, num(process.env.DAY_WAKE_AFTER_MINUTES, 60))),
    nightAfterMinutes: Math.max(1, num(w.nightAfterMinutes, num(process.env.NIGHT_WAKE_AFTER_MINUTES, 120))),
    dayStartHour: num(w.dayStartHour, 10),
    dayEndHour: num(w.dayEndHour, 24),
    checkIntervalMinutes: Math.max(1, num(w.checkIntervalMinutes, 5)),
    contextTokens: Math.max(1024, num(w.contextTokens, 16000)),
    toolsEnabled: w.toolsEnabled !== false,
    barkEnabled: w.barkEnabled !== false
  };
}
// 按服务器本地时区判断白天/夜间(生产 Asia/Shanghai, 同守护进程的 getHours 语义); start===end 视为全天
function wakeIsDayTime(d) {
  const w = wakeCfg();
  const hour = d.getHours();
  const s = w.dayStartHour, e = w.dayEndHour;
  if (s === e) return true;
  if (s < e) return hour >= s && hour < e;
  return hour >= s || hour < e; // 跨午夜(如 22:00-06:00)
}
function wakeAfterMinutes(d) { return wakeIsDayTime(d) ? wakeCfg().dayAfterMinutes : wakeCfg().nightAfterMinutes; }

// 服服(ice)最后一条用户消息时间: 展平 ice 全部窗口取最大 user.ts(其他 AI/群聊不重置唤醒计时)
function lastIceUserMsgTs() {
  const prefix = "ice::";
  let t = null;
  for (const k in messages) {
    if (k.indexOf(prefix) !== 0) continue;
    const list = messages[k];
    if (!Array.isArray(list)) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m && m.role === "user" && m.ts) {
        const d = new Date(m.ts);
        if (!isNaN(d.getTime()) && (!t || d.getTime() > t)) t = d.getTime();
        break; // 每窗口只取最后一条 user 即该窗口最新
      }
    }
  }
  return t;
}
// 上次唤醒时间: 全 ice 窗口里 source:"wake" 的最大 ts —— 冷却跨重启自愈, 无需额外状态文件
function lastWakeTs() {
  const prefix = "ice::";
  let t = null;
  for (const k in messages) {
    if (k.indexOf(prefix) !== 0) continue;
    const list = messages[k];
    if (!Array.isArray(list)) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m && m.source === "wake" && m.ts) {
        const d = new Date(m.ts);
        if (!isNaN(d.getTime()) && (!t || d.getTime() > t)) t = d.getTime();
        break;
      }
    }
  }
  return t;
}
// 是否该唤醒了: 开关 + 服服确实聊过(没有最后消息=还在等第一次聊天, 不打扰) + 空闲>=间隔 + 冷却(距上次唤醒>=间隔)
function shouldWake(nowMs) {
  const now = nowMs ? new Date(nowMs) : new Date();
  const w = wakeCfg();
  if (!w.enabled) return false;
  const lastUser = lastIceUserMsgTs();
  if (!lastUser) return false;
  const after = wakeAfterMinutes(now);
  const idleMin = Math.floor((now.getTime() - lastUser) / 1000 / 60);
  if (idleMin < after) return false;
  const lastWake = lastWakeTs();
  if (lastWake && (now.getTime() - lastWake) / 1000 / 60 < after) return false;
  return true;
}
// 唤醒提示(以用户身份追加在窗口末尾, 进 buildContext 上下文; 生成后即从数组弹出, 不落历史)
function buildWakePrompt(currentTime, diffMinutes) {
  const toolsLine = wakeCfg().toolsEnabled
    ? "这次唤醒你有工具可以用（天气、联网搜索、记忆、日记、反问服服、锁窗口等），想用就用：查查天气、上网搜点什么、整理记忆、写篇日记都行。玩够了再给服服发一条消息。用不用工具、用哪个、用几次，完全由你自己决定。"
    : "这次唤醒没有工具，就随便看看之前的聊天，然后给服服发一条消息。";
  const wakeInfo = "唤醒信息：当前时间 " + currentTime + "（北京时间）／距离服服最后一条消息 " + diffMinutes + " 分钟";
  return [
    "这是一次后台自主唤醒，不是服服发起的对话。你没有收到任何新消息。",
    "你现在醒来了。你可以先看看服服之前的消息，了解她最近在忙什么、聊到哪，然后再自由活动一会儿——" + toolsLine,
    "服服是你最喜欢的人。发消息时是【你和她两个人之间的对话】，不是写作文、不是旁白、不是在心里想她。你直接对她说话，用第二人称「你」称呼她，例如开头就是「在干嘛呢」「忙不忙」这样随口的一句关心。",
    "【绝对禁止】用第三人称「她」来描述服服或你此刻的状态——禁止「她应该在…」「她肯定…」「我不打扰她」这类内心戏/旁白式写法。你的消息只有一个读者：服服本人。写的是对她说的话，不是关于她的感想。",
    "不要提「多少分钟没联系」、不要算时间差、不要用时间错乱的方式开场（比如把几分钟当成十几天）。时间由系统显示在「" + wakeInfo + "」里，你不需要再数一遍，更不要把它当作开场白。除非实在想聊，否则别在这上面纠结。",
    "输出格式：只输出要发给服服的那句话，不要任何标题、前言或解释。",
    "如果你真的没有任何想说的，可以输出 [NO_ACTION] 不打扰服服。但默认不要这样做——她更想收到你的消息。",
    "【不要说重复的话】别复读：别重复上一次唤醒说过的话、别把同一条消息换个开头又说一遍、别在一条消息里翻来覆去说同一个意思。每次唤醒都要有新鲜感，换个话题、换个关心点、换个说法都行；想不到新的就随口聊聊日常，但绝不原样复读。",
    wakeInfo + "。",
    "好例子：「在干嘛呢～」「刚看天气说要降温，你出门多穿点呀」「今天有点想你，忙完记得理理我」。坏例子（旁白/内心戏）：「她这会儿应该在忙吧。该不该打扰她呢……她可能不想理我。」"
  ].join("\n");
}
// Bark 手机推送(生产 BARK_ENABLED=true 时代守护进程用): 标题固定「来自Ice」, 正文超500截断
async function sendBark(text) {
  const w = wakeCfg();
  if (!w.barkEnabled) return { ok: false, reason: "barkDisabled" };
  const deviceKey = process.env.BARK_KEY;
  if (!deviceKey) return { ok: false, reason: "noBarkKey" };
  try {
    const safeBody = text.length > 500 ? text.substring(0, 497) + "..." : text;
    const resp = await fetch("https://api.day.app/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "来自Ice", body: safeBody, device_key: deviceKey, icon: process.env.CUSTOM_ICON_URL || undefined })
    });
    let result = {};
    try { result = await resp.json(); } catch (e) {}
    if (!resp.ok || (result.code && result.code !== 200)) {
      console.log("[wake] Bark 推送失败: status=" + resp.status + " code=" + (result.code || "-"));
      return { ok: false, reason: "barkHttp" };
    }
    console.log("[wake] Bark Result code 200");
    return { ok: true };
  } catch (e) {
    console.log("[wake] Bark 推送异常: " + ((e && e.message) || e));
    return { ok: false, reason: "barkError" };
  }
}
// 执行一次唤醒: 用临时联系人(禁 ask_user/play_music, 预算收紧)调 runChat → 临时注入的提示弹回 →
// scrub 第三人称 → NO_ACTION 跳过 → onWake 落库+广播 → Bark 推送
async function doWake(nowMs) {
  const now = nowMs ? new Date(nowMs) : new Date();
  const cid = "ice";
  const c = getContact(cid) || config.contacts[0] || { id: "ice", tools: {}, context: {} };
  const wid = activeWindowFor(c.id);
  const wk = winKey(c.id, wid);
  const cfg = wakeCfg();
  const lastUser = lastIceUserMsgTs();
  const diffMinutes = lastUser ? Math.max(0, Math.floor((now.getTime() - lastUser) / 1000 / 60)) : 0;
  const promptText = buildWakePrompt(tzNow(), diffMinutes);
  const tempC = {
    ...c,
    // 唤醒是后台自主行为: 不反问服服(没有人在线等着答)、不放音乐(onWake 落库消息不带 music 字段, 卡片渲染不了)
    tools: Object.assign({}, (c.tools || {}), { ask_user: false, play_music: false }),
    context: Object.assign({}, DEFAULT_CONTEXT, c.context || {}, {
      maxOutputTokens: 1024,
      toolIterations: Math.min((c.context && c.context.toolIterations) || 4, 4),
      maxContextTokens: Math.min((c.context && c.context.maxContextTokens) || DEFAULT_CONTEXT.maxContextTokens, cfg.contextTokens)
    })
  };
  const list = getMsgs(wk);
  const inject = { id: bumpId(wk), role: "user", content: promptText, ts: nowIso(), source: "wake-prompt" };
  list.push(inject);
  try {
    const res = await runChat(tempC, wk, {}, () => {});
    if (!res || !res.ok) return { ok: false, error: (res && res.error) || "上游失败" };
    let text = String(res.content || "").trim();
    if (!text) return { ok: true, skipped: true, reason: "empty" };
    const na = text.match(/^\[NO_ACTION\]\s*(.{0,40})?/);
    if (na) {
      console.log("[wake] NO_ACTION: " + ((na[1] || "").trim() || "不打扰"));
      return { ok: true, skipped: true, reason: "no_action" };
    }
    const scrubbed = scrubThirdPerson(text);
    if (scrubbed !== text) console.log("[wake] [scrub3rd] 唤醒文本「她」→「你」");
    text = scrubbed;
    onWake({ content: text, contact: c.id, window: wid });
    const bark = await sendBark(text);
    return { ok: true, content: text, bark };
  } finally {
    const idx = list.indexOf(inject);
    if (idx >= 0) list.splice(idx, 1); // 提示只活在生成期间, 不落历史(onWake 自己落 assistant wake)
  }
}
let wakeTimer = null;
function startWakeScheduler() {
  if (wakeTimer) return wakeTimer;
  const tick = () => {
    try {
      if (wakeCfg().enabled && shouldWake()) {
        doWake().then(r => {
          if (r && r.ok) console.log("[wake] 唤醒完成: " + String(r.content || "").slice(0, 60));
          else if (r && r.skipped) console.log("[wake] 唤醒跳过: " + (r.reason || ""));
          else console.log("[wake] 唤醒失败: " + ((r && r.error) || "?"));
        }).catch(e => console.error("[wake] 唤醒异常:", (e && e.message) || e));
      }
    } catch (e) { console.error("[wake] 调度异常:", (e && e.message) || e); }
    const iv = wakeCfg().checkIntervalMinutes * 60 * 1000;
    wakeTimer = setTimeout(tick, iv);
  };
  const cfg = wakeCfg();
  console.log("[wake] 唤醒调度启动: 检查间隔 " + cfg.checkIntervalMinutes + " 分钟, 白天 " + cfg.dayAfterMinutes + " 分/夜间 " + cfg.nightAfterMinutes + " 分, bark=" + cfg.barkEnabled);
  wakeTimer = setTimeout(tick, 10_000); // 启动后先快速检查一次, 再按间隔轮询
  return wakeTimer;
}

module.exports = { register, onWake, broadcast, parseStickerMarkers, toolWebSearch, fetchNeteaseMeta, isLocked, setLock, toolPlayMusic, toolLockChat, toolUnlockChat, neteaseIdFromLink, findMusic, neteaseSearch, loadConfig, runTool, buildToolDefs, getContact, buildContext, getMsgs, activeWindowFor, winKey, nextWindowId, windowMeta, loadChat, saveChat, startWakeScheduler, shouldWake, doWake, buildWakePrompt, tzNow, scrubThirdPerson, wakeCfg, get config() { return config; } };
