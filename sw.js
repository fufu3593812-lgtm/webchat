// 最小 Service Worker —— 唯一目的: 让 iOS 16.4+ 认可这是"可安装 PWA"
// (iOS 要求注册 SW + fetch 监听才在"分享→添加到主屏幕"按可安装处理)
// 所有请求网络直通: 聊天页有 mtime 重读逻辑, 这里不缓存不拦截, 避免旧 HTML / 旧 token
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (e) => { /* 透传, 不缓存 */ });
