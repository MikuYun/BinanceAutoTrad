# 贡献指南

感谢你愿意改进这个项目。本文说明怎么把环境跑起来、代码怎么写、提交前要过哪些检查。

---

## 一、开发环境

| 项 | 要求 |
|---|---|
| Node.js | **>= 22.5**（`package.json` 的 `engines.node`），推荐 **24 LTS** |
| 包管理器 | **不需要**。零第三方依赖，`npm install` 可以完全跳过 |
| 操作系统 | Windows / macOS / Linux 均可 |
| 网络 | 实盘行情需能访问币安 `fapi.binance.com`；不通时自动降级本地模拟行情 |

为什么卡在 22.5：数据库用的是 Node 内置的 `node:sqlite`，这个模块从 22.5 才开始提供，低于这个版本启动会直接抛错。

> 项目没有 `dependencies` / `devDependencies`。**请不要为了让某个功能更省事而引入第三方包**，
> 零依赖是硬性设计约束，理由见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的「技术选型」。

---

## 二、本地怎么跑起来

```bash
git clone https://github.com/MikuYun/BinanceAutoTrad.git
cd BinanceAutoTrad
node server.js     # 打开 http://127.0.0.1:8787 注册账号即可用模拟盘
```

**Windows PowerShell：**

```powershell
node server.js                              # 普通启动（模拟盘，安全）
$env:PORT = 9000; node server.js            # 换端口
$env:BINANCE_FEED = "mock"; node server.js  # 网络访问不了币安时用本地模拟行情
$env:LIVE_TRADING = "1"; node server.js     # 打开实盘下单开关（危险，重启即失效）
```

macOS / Linux 同理：`PORT=9000 node server.js`、`BINANCE_FEED=mock node server.js`、
`LIVE_TRADING=1 node server.js`。首次运行会自动创建 `data/` 目录、`app.db` 与 `master.key`，**这个目录不要提交**。

---

## 三、代码规范

| 规则 | 说明 |
|---|---|
| 模块系统 | 全部 ESM（`"type": "module"`），用 `import` / `export`，不要 `require` |
| 内置模块前缀 | 一律写 `node:`：`import { readFileSync } from 'node:fs'`、`import test from 'node:test'` |
| 第三方依赖 | **不引入**，优先看 Node 内置模块有没有 |
| 注释 | 用 JSDoc 块注释说明「这个文件/函数为什么存在」，中文书写；数值计算要写清单位（USDT / 张 / 百分比） |
| 标识符 | 函数与变量名保持英文；错误码用大写下划线（`ROBOT_NOT_FOUND`）；用户可见文案写中文 |
| 错误处理 | 业务错误统一 `throw new HttpError(4xx, 'CODE', '中文提示')`；`runner.js` 里的副作用一律 `try/catch`，写日志失败不能中断交易 |
| SQL | 全部参数绑定（`?` 占位），**禁止字符串拼接** |
| 金额与精度 | 数量、价格一律经 `stepSize` / `tickSize` 规整，不要自己 `toFixed` 了事 |
| 前端 | 原生 ESM + 原生 DOM，不引入框架；图表用纯 SVG 手绘（`app.js` 的 `lineChart` / `candlesChart`） |
| 文件头注释 | 每个源文件开头写清职责与关键约束，范例见 `src/binance/live.js`、`src/strategy/liveBook.js` |

缩进与引号跟随现有文件：2 空格、单引号、行尾分号。

---

## 四、提交前自检清单

两条命令必须**全绿**，缺一不可：

```bash
node scripts/check.js        # 全部 JS 文件语法检查 + 关键文件存在性检查
node --test scripts/*.mjs    # 6 组单元测试，共 64 个用例
```

也可以 `npm run check` / `npm test`。`check.js` 会对仓库里每个 `.js` 跑一次 `node --check`，
最后打印 `检查 JS 文件 N 个，语法错误 M 个。`；任一文件语法错误，或 `server.js`、`package.json`、
`src/static/*` 的关键文件缺失，都以非零退出码结束。

- [ ] `node scripts/check.js` 通过
- [ ] `node --test scripts/*.mjs` 全绿
- [ ] 没有新增第三方依赖
- [ ] 没有提交 `data/`、`master.key`、`*.db`、任何 API Key（见第五节）
- [ ] 改动了策略数学的话，同时补了对应单元测试
- [ ] 中文错误文案读得懂，没有把内部报错原文直接抛给用户

---

## 五、安全红线（不要提交这些）

| 不要提交 | 原因 |
|---|---|
| `data/` 整个目录 | 含数据库、加密主密钥、精度规则缓存 |
| `data/master.key` | API Key 的 AES-256-GCM 主密钥，泄露等于所有 Key 泄露 |
| `*.db` / `*.db-shm` / `*.db-wal` | 含账号、加密后的 Key、订单与持仓记录 |
| 任何 API Key / Secret 明文 | 包括测试用的、已作废的、截图里的 |
| 日志与备份包 | `*.log`、`*.tar.gz`，可能夹带密钥或账户信息 |

`.gitignore` 已覆盖上述路径。**如果误提交了密钥**：① 先去币安把那个 Key **删除**（改代码救不回来）→
② 再清理 git 历史（`git filter-repo` 或重建分支）→ ③ 在 Issue / PR 里说明，但**不要贴出密钥内容**。

---

## 六、怎么加一个新测试

测试放在 `scripts/` 下，文件名 `test-<主题>.mjs`，只用 Node 内置断言：
`import test from 'node:test'` + `import assert from 'node:assert/strict'`。
动手前先读 `scripts/test-minqty.mjs` 或 `scripts/test-capital.mjs` 确认写法，要点：

1. **每个文件一个主题**，文件头用块注释写清「这个测试防的是什么 bug」——现有测试的头注释都记了根因链；
2. **测纯函数**：`src/strategy/` 的 `solver.js`、`params.js`、`engine.js`、`liveBook.js`、`protect.js`
   与 `src/binance/protection.js` 都不碰 IO，可直接 import；
3. **不发真实网络请求**，需要交易所返回时自己构造同形假对象（`test-precision.mjs` 手写 `exchangeInfo` 结构就是范例）；
4. **断言带中文说明**，失败时一眼看出坏在哪；
5. 修 bug 时**先写一条会失败的测试再改代码**。

```js
test('requiredQtyUnits 按 minQty/stepSize 算最小台阶数', () => {
  assert.equal(requiredQtyUnits(SKHYNIX), 1, 'minQty 0.01 / step 0.01 → 1 个单位');
  assert.equal(requiredQtyUnits({}), 0, '没有规则时返回 0（不做额外约束）');
});
```

---

## 七、Commit message 约定

格式 `<类型>: <一句话说明>`，说明用中文、动宾结构，说清「改了什么」：

| 类型 | 用于 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `docs` | 只改文档 |
| `refactor` | 不改行为的重构 |
| `test` | 只加/改测试 |
| `chore` | 构建、忽略规则、杂项 |

```
fix: 止损价被算到强平价外侧时夹回入场价与强平价之间
test: 补 SKHYNIXUSDT 粗步长下的最小下单额回归
```

一个 commit 只做一件事。修 bug 时把根因写进正文（`git commit -m "标题" -m "正文"`）。

---

## 八、PR 流程

1. **先开 Issue 说明意图**（改 bug 可直接提 PR），避免大改动做完发现方向不对；
2. Fork 仓库，从 `main` 切语义化分支：`fix/stop-price-clamp`、`feat/layer-take-profit`；
3. 本地改完后跑完第四节的检查清单；
4. 提交 PR，描述包含：**改了什么 / 为什么改**（根因，不是现象）、复现步骤或截图、
   影响范围（动了策略数学要特别标出对已有机器人的影响）、自检结果；
5. 涉及策略计算、订单数量、精度规整的改动**必须附带单元测试**；
6. 涉及实盘下单路径会额外审查：是否保证幂等、是否会误平用户手动仓、是否有安全闸保护。

**不会被合并的改动**：引入第三方依赖、绕过 `LIVE_TRADING` 安全闸、
在日志里打印 API Key / Secret 明文、改动精度规整时去掉降精度兜底。

---

## 九、报告 Bug 时请提供

| 信息 | 为什么需要 |
|---|---|
| `node -v` 与操作系统版本 | 低于 22.5 会直接启动失败，是最常见的环境问题 |
| 启动命令与环境变量 | 是否设了 `PORT` / `HOST` / `BASE_PATH` / `LIVE_TRADING` / `BINANCE_FEED` |
| 完整报错原文 | 页面弹的中文提示 + 终端堆栈，**不要只截一半** |
| 复现步骤 | 从启动到出错的每一步：哪个页面、点了什么、参数填了多少 |
| 机器人参数 | 分配资金、第一笔占比、杠杆、加仓间距、层数、止盈止损幅度 |
| 事件日志 | 详情页事件流（`info`/`warn`/`error`/`trade`），记录了每次决策依据 |
| 模拟盘还是实盘 | 两者代码路径完全不同 |

**提交前务必脱敏**：贴日志或截图前删掉 API Key、账号、余额、订单 id、服务器地址与端口。
安全问题请**不要开公开 Issue**，走 [SECURITY.md](SECURITY.md) 里的方式私下报告。

---

## 十、许可

本项目以 [Apache License 2.0](LICENSE) 发布，提交 PR 即表示你同意你的贡献以同一协议授权。
