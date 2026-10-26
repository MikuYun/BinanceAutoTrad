/**
 * 入口：装配路由、启动 HTTP 服务、恢复运行中的机器人。
 *
 * 启动：node server.js
 * 环境变量：
 *   PORT                 默认 8787
 *   HOST                 默认 127.0.0.1（服务器部署需 HOST=0.0.0.0）
 *   BASE_PATH            子路径部署前缀，如 /biance_trae（留空=站点根路径）
 *   LIVE_TRADING         设为 1 才允许实盘下单（默认关闭，安全闸）
 *   BT_MASTER_KEY        32 字节 hex，用于加密 API Key（缺省则用 data/master.key）
 *   BINANCE_BASE_URL     默认 https://fapi.binance.com
 *   BINANCE_TIMEOUT_MS   默认 8000
 *   TICK_INTERVAL_MS     机器人 tick 间隔，默认 5000
 */
import { createServer, mount, app } from './src/http.js';
import { PORT, HOST, DATA_DIR, BASE_PATH, TRADING } from './src/config.js';
import { purgeExpiredSessions } from './src/db.js';
import registerAuthRoutes, { authMiddleware } from './src/routers/auth.js';
import registerRobotRoutes from './src/routers/robots.js';
import { getMarketFeed, startMarket, tickMarket } from './src/binance/index.js';
import { startTimeSync, stopTimeSync } from './src/binance/rest.js';

/** 尽力挂载可选路由（backend-exchange 交付的模块） */
async function mountOptional(registerFn, label) {
  try {
    mount(registerFn);
    console.log(`  [路由] ${label} 已挂载`);
    return true;
  } catch (e) {
    console.warn(`  [路由] ${label} 挂载失败：${e.message}`);
    return false;
  }
}

async function main() {
  console.log('══════════════════════════════════════');
  console.log('  币安量化终端 · U 本位永续');
  console.log('══════════════════════════════════════');
  console.log(`  数据目录：${DATA_DIR}`);
  console.log(`  监听地址：${HOST}:${PORT}`);
  console.log(`  部署前缀：${BASE_PATH || '（站点根路径）'}`);
  console.log(`  实盘下单：${TRADING.liveEnabled ? '已开启（LIVE_TRADING=1）' : '已关闭（安全闸，只读）'}`);

  // 认证中间件必须最先注册，为后续所有路由注入 ctx.user
  app.use(authMiddleware);

  // 认证与机器人（lead 自己的）
  mount(registerAuthRoutes);
  mount(registerRobotRoutes);

  // 行情 / 账户 / API Key（backend-exchange）
  for (const [file, label] of [
    ['./src/routers/market.js', '行情'],
    ['./src/routers/account.js', '账户'],
    ['./src/routers/apikeys.js', 'API Key'],
  ]) {
    try {
      const mod = await import(file);
      if (typeof mod.default === 'function') {
        await mountOptional(mod.default, label);
      } else {
        console.warn(`  [路由] ${label} 缺少 default 导出，跳过`);
      }
    } catch (e) {
      console.warn(`  [路由] ${label} 加载失败：${e.message}`);
    }
  }

  purgeExpiredSessions();

  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`\n  ✅ 平台已启动：http://${HOST}:${PORT}${BASE_PATH}/`);
    const feed = startMarket();
    console.log(`  [行情] 数据源：${feed.source === 'live' ? '币安实时行情（fapi.binance.com）' : '本地模拟行情'}`);
    console.log('  按 Ctrl+C 停止\n');

    // 周期校准本机与币安的时钟差（用户问题 #13）：
    // 经代理访问币安时单程可能几百毫秒到几秒，本地时钟也有漂移，
    // 超过 recvWindow 就会 -1021。这里每 BINANCE.timeSyncIntervalMs（默认 60s）校准一次，
    // 所有签名请求的 timestamp 都用「本机时间 + 偏移量」。
    startTimeSync();

    // 恢复机器人必须放在 listen 之后、且不能 await：
    // 币安不通时首次 tick 会卡在网络重试上（8s 超时 × 3 次重试 × 多个接口），
    // 如果在这里 await，网站几十秒内都打不开。
    import('./src/strategy/runner.js')
      .then((runner) => (typeof runner.bootAll === 'function' ? runner.bootAll() : 0))
      .then((n) => console.log(`  [策略] 已恢复运行中的机器人 ${n} 个`))
      .catch((e) => console.warn(`  [策略] 运行器未就绪：${(e && e.message) || e}`));
  });

  // 仅模拟行情需要手动推进价格（真实行情由 liveMarket 内部定时器拉取）
  const feed = getMarketFeed();
  let tickTimer = null;
  if (feed.source === 'mock') {
    tickTimer = setInterval(() => tickMarket(), 3000);
    if (tickTimer.unref) tickTimer.unref();
  }

  // 优雅退出
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n[${signal}] 正在停止机器人并关闭服务…`);
    try { stopTimeSync(); } catch { /* 忽略 */ }
    try {
      const runner = await import('./src/strategy/runner.js');
      if (typeof runner.shutdownAll === 'function') await runner.shutdownAll();
    } catch {
      /* 运行器未就绪 */
    }
    server.close(() => process.exit(0));
    // 兜底：3 秒后强制退出
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 兜底：任何遗漏的异常都不能让进程静默死掉
  process.on('unhandledRejection', (err) => {
    console.error('[进程] 未捕获的 Promise 异常:', (err && err.message) || err);
  });
  process.on('uncaughtException', (err) => {
    console.error('[进程] 未捕获异常:', (err && err.message) || err);
  });
}

main().catch((e) => {
  console.error('启动失败：', (e && e.stack) || e);
  process.exit(1);
});
