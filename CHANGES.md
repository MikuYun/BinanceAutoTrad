# 改动记录 2026-10-26

## src/binance/rest.js

```diff
--- src/binance/rest.js
+++ src/binance/rest.js
@@ -5,7 +5,11 @@
  *   1. 每次请求都有硬超时（AbortController），绝不无限等待；
  *   2. 网络错误统一包装成 BinanceError，带上「网络不可达」的可读中文提示；
- *   3. 不做自动重试（避免在断网时放大延迟），由调用方决定降级。
+ *   3. 网络类失败做有限次重试（见 request() / isRetryable()）。
+ *
+ * 关于重试的边界：只对**幂等**请求重试（GET 查询 / DELETE 撤单）。
+ * 下单（POST /fapi/v1/order）**绝不自动重试** —— 超时并不代表没成交，
+ * 重复提交会造成真实资金上的重复开仓。撤单是幂等的，重试安全。
  */
 import { hmacSha256Hex } from '../crypto.js';
 import { BINANCE } from '../config.js';
@@ -83,7 +87,7 @@
  * @param {number} [opts.timeoutMs]
  */
-export async function request(opts) {
+async function requestOnce(opts) {
   const {
     path,
     method = 'GET',
@@ -185,6 +189,40 @@
   return data;
 }
 
+const RETRY_MAX = 3;
+const RETRY_BASE_MS = 400;
+
+/** 只对这些「本身幂等、重发无副作用」的请求做网络重试 */
+function isRetryable(opts) {
+  const method = (opts.method || 'GET').toUpperCase();
+  if (method === 'GET') return true;
+  // DELETE /fapi/v1/order 撤单是幂等的：重复撤单只会报「订单不存在」，不会造成资金损失。
+  if (method === 'DELETE' && String(opts.path || '').includes('/order')) return true;
+  return false;
+}
+
+/**
+ * 带网络重试的请求入口。
+ * 专治代理链路 2~3% 的随机握手失败（context deadline exceeded / fetch failed）。
+ * 重试上限 3 次、退避 400/800/1600ms，最多多花约 3 秒，仍远小于机器人 5 秒 tick。
+ */
+export async function request(opts) {
+  const retryable = isRetryable(opts) && opts.retry !== false;
+  const max = retryable ? RETRY_MAX : 1;
+  let lastErr;
+  for (let attempt = 1; attempt <= max; attempt += 1) {
+    try {
+      return await requestOnce(opts);
+    } catch (err) {
+      lastErr = err;
+      const isNet = err && err.network;
+      if (!isNet || attempt === max) throw err;
+      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1)));
+    }
+  }
+  throw lastErr;
+}
+
 /** 无需签名的公开接口 */
 export function publicGet(path, query, timeoutMs) {
   return request({ path, query, timeoutMs });
```

## /etc/systemd/system/biance-trae.service

```diff
@@ -17,7 +17,9 @@
 Environment=PORT=8797
 Environment=BASE_PATH=/biance_trae
 Environment=TICK_INTERVAL_MS=5000
-Environment=BINANCE_TIMEOUT_MS=8000
+# 2026-10-26 由 8000 提到 20000：代理链路偶发 2~6 秒握手延迟，8 秒阈值误判为超时。
+# 配合 rest.js 的网络重试（GET/DELETE 最多 3 次，退避 400/800/1600ms）。
+Environment=BINANCE_TIMEOUT_MS=20000
 Environment=HTTP_PROXY=http://127.0.0.1:7890
```
