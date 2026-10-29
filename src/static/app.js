/* 币安量化终端 — 纯原生 ESM 前端 */
// 支持部署在子路径（如 /biance_trae/）下：从模块自身 URL 推导前缀，本地直连时为空串。
const BASE = (() => {
  try {
    const p = new URL('.', import.meta.url).pathname.replace(/\/+$/, '');
    return p === '/' ? '' : p;
  } catch (e) { return ''; }
})();
const apiUrl = (p) => (/^https?:/i.test(p) ? p : BASE + p);

const S = { user: null, pollId: 0, pollFn: null, pollMs: 3000 };
const app = document.getElementById('app');
const modalRoot = document.getElementById('modalRoot');
const nav = document.getElementById('nav');
let routeSeq = 0;

/* ---------- 工具 ---------- */
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 2) => (v == null || v === '' || !isFinite(Number(v)) ? '—' : Number(v).toFixed(d));
const money = (v, d = 2) => (v == null || !isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 2) => (v == null || !isFinite(Number(v)) ? '—' : (Number(v) * 100).toFixed(d) + '%');
const pctRaw = (v, d = 2) => (v == null || !isFinite(Number(v)) ? '—' : Number(v).toFixed(d) + '%');
const signCls = (v) => (Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : '');
const signed = (v, d = 2) => (Number(v) > 0 ? '+' : '') + num(v, d);
const fmtTime = (ts) => {
  if (!ts) return '—';
  const d = new Date(typeof ts === 'number' ? ts : ts);
  if (isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const ago = (ts) => {
  if (!ts) return '从未';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (!isFinite(s)) return '—';
  if (s < 5) return '刚刚';
  if (s < 60) return `${Math.floor(s)} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};
const qs = (s, r = document) => r.querySelector(s);
const qsa = (s, r = document) => Array.from(r.querySelectorAll(s));
const el = (id) => document.getElementById(id);
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------- 主题（#12） ---------- */
const THEMES = ['dark', 'light', 'blue', 'warm'];
const THEME_LABEL = { dark: '深色', light: '浅色', blue: '冷蓝', warm: '暖色' };
/* 颜色一律从 CSS 变量读，JS/SVG 里不写死色值 */
function cssVar(name, fb = '') {
  try { return (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim() || fb; }
  catch (e) { return fb; }
}
function applyTheme(name, persist = true) {
  const t = THEMES.includes(name) ? name : 'dark';
  document.documentElement.dataset.theme = t;
  document.documentElement.style.colorScheme = t === 'light' ? 'light' : 'dark';
  if (persist) { try { localStorage.setItem('theme', t); } catch (e) { /* 隐私模式忽略 */ } }
  qsa('[data-theme-btn]').forEach((b) => b.classList.toggle('active', b.dataset.themeBtn === t));
  return t;
}
function initTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem('theme') || 'dark'; } catch (e) { saved = 'dark'; }
  applyTheme(saved, false);
  const seg = el('themeSeg');
  if (!seg) return;
  qsa('[data-theme-btn]', seg).forEach((b) => b.addEventListener('click', () => {
    if (document.documentElement.dataset.theme === b.dataset.themeBtn) return;
    applyTheme(b.dataset.themeBtn);
    toast('已切换到' + THEME_LABEL[b.dataset.themeBtn] + '主题', 'ok', 1400);
    route();   // 图表颜色取自计算样式，需要重画当前页
  }));
}

/* ---------- 局部刷新工具（#6） ---------- */
/* 只在值真的变化时写 DOM：避免每 3 秒重建整块节点导致滚动复位/焦点丢失 */
function setText(node, value) {
  if (!node) return;
  const v = value == null ? '' : String(value);
  if (node.textContent !== v) node.textContent = v;
}
function setHTML(node, html) {
  if (!node) return;
  const v = html == null ? '' : String(html);
  if (node.innerHTML !== v) node.innerHTML = v;
}
function patchText(root, selector, value) {
  const n = (root || document).querySelector(selector);
  if (n) setText(n, value);
  return n;
}
function patchHTML(root, selector, html) {
  const n = (root || document).querySelector(selector);
  if (n) setHTML(n, html);
  return n;
}
function patchClass(root, selector, className, on) {
  const n = (root || document).querySelector(selector);
  if (!n) return null;
  if (n.classList.contains(className) !== !!on) n.classList.toggle(className, !!on);
  return n;
}
/* KPI 卡：结构建一次，之后只 patch 三个 span 的文本与 class */
function patchKpis(root, items) {
  if (!root) return;
  if (root.children.length !== items.length) {
    root.innerHTML = items.map(() => '<div class="card kpi"><span class="kpi-label"></span>'
      + '<span class="kpi-value mono"></span><span class="kpi-sub muted"></span></div>').join('');
  }
  items.forEach((it, i) => {
    const card = root.children[i];
    if (!card) return;
    const lab = card.children[0], val = card.children[1], sub = card.children[2];
    setText(lab, it.label);
    setText(val, it.value);
    val.className = 'kpi-value mono ' + (it.cls || '');
    setText(sub, it.sub == null ? '' : it.sub);
    sub.className = 'kpi-sub ' + (it.subCls || 'muted');
  });
}
/* 滚动位置保存 / 恢复 */
const SCROLL_SEL = '.log-wrap,.mk-scroll,.modal-body';
function saveScroll() {
  return {
    y: window.scrollY || document.documentElement.scrollTop || 0,
    list: qsa(SCROLL_SEL).map((n) => [n, n.scrollTop]),
  };
}
function restoreScroll(s) {
  if (!s) return;
  (s.list || []).forEach(([n, t]) => {
    if (n && n.isConnected && n.scrollTop !== t) n.scrollTop = t;
  });
}
/* 轮询体包一层：请求前后保住窗口/列表滚动位置 */
async function guarded(fn) {
  const s = saveScroll();
  const h = document.body.scrollHeight;
  try {
    return await fn();
  } finally {
    restoreScroll(s);
    // 只有布局高度变了（浏览器可能把窗口滚动夹紧）才回滚窗口滚动，用户主动滚动不打断
    if (document.body.scrollHeight !== h && s.y) window.scrollTo(0, s.y);
  }
}
/* 键控增量列表：新旧数据是「头部插入」或「尾部追加」时只增删差量节点，
   其余情况才重建（并复用同 key 节点、恢复滚动位置）。返回是否写过 DOM。 */
function patchKeyed(container, list, keyOf, buildNode) {
  if (!container) return false;
  const keys = list.map((it) => String(keyOf(it)));
  const sig = keys.length + '|' + (keys.length ? keys[0] + '~' + keys[keys.length - 1] : '');
  if (container.dataset.sig === sig) return false;   // 完全没变：一个字节都不写
  const prevTop = container.scrollTop;
  const atBottom = prevTop + container.clientHeight >= container.scrollHeight - 24;
  const nodes = new Map();
  Array.from(container.children).forEach((n) => { if (n.dataset && n.dataset.key != null) nodes.set(n.dataset.key, n); });
  const prevCount = nodes.size;
  let incremental = false;
  if (keys.length > prevCount && prevCount > 0) {
    const headNew = [];
    for (let i = 0; i < keys.length; i += 1) { if (nodes.has(keys[i])) break; headNew.push(i); }
    const tailNew = [];
    for (let i = keys.length - 1; i >= 0; i -= 1) { if (nodes.has(keys[i])) break; tailNew.unshift(i); }
    if (headNew.length === keys.length - prevCount) {
      for (let k = headNew.length - 1; k >= 0; k -= 1) container.insertBefore(buildNode(list[headNew[k]]), container.firstChild);
      incremental = true;
    } else if (tailNew.length === keys.length - prevCount) {
      tailNew.forEach((i) => container.appendChild(buildNode(list[i])));
      incremental = true;
    }
  }
  if (!incremental) {
    const frag = document.createDocumentFragment();
    list.forEach((it) => {
      const k = String(keyOf(it));
      const n = nodes.get(k) || buildNode(it);
      nodes.delete(k);
      frag.appendChild(n);      // 复用旧节点：不打断选择/焦点/内联事件
    });
    nodes.forEach((n) => n.remove());
    container.replaceChildren(frag);
  }
  container.dataset.sig = sig;
  container.scrollTop = atBottom ? container.scrollHeight : prevTop;
  return true;
}

function toast(msg, type = 'info', ms = 3200) {
  const box = el('toasts');
  const node = document.createElement('div');
  node.className = 'toast toast-' + (type === 'info' ? 'ok' : type);
  node.textContent = msg;
  box.appendChild(node);
  setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 260); }, ms);
}

function stateBox(kind, text, hint) {
  const icon = kind === 'loading' ? '<span class="spinner"></span>' : kind === 'error' ? '!' : '∅';
  return `<div class="state ${kind}"><div class="state-icon">${icon}</div><p>${esc(text)}</p>${hint ? `<p class="muted">${esc(hint)}</p>` : ''}</div>`;
}
function loading(text = '加载中…') { return stateBox('loading', text); }
function empty(text = '暂无数据', hint = '') { return stateBox('empty', text, hint); }
function errorBox(text, hint) { return stateBox('error', text, hint); }

/* ---------- HTTP ---------- */
async function api(path, opts = {}, silent = false) {
  const { body, method, headers, ...rest } = opts;
  const init = { credentials: 'same-origin', ...rest, headers: { ...(headers || {}) } };
  if (method) init.method = method;
  if (body !== undefined && typeof body !== 'string') {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  } else if (body !== undefined) init.body = body;
  let res;
  try {
    res = await fetch(apiUrl(path), init);
  } catch (e) {
    if (!silent) toast('网络异常，请检查连接', 'err');
    const ne = new Error('network'); ne.network = true;
    throw ne;
  }
  let json = null;
  const text = await res.text().catch(() => '');
  if (text) { try { json = JSON.parse(text); } catch (e) { json = null; } }
  const onLogin = parseRoute().name === 'login';
  if (res.status === 401 && !path.startsWith('/api/auth/') && path !== '/api/me' && !onLogin) {
    S.user = null; stopPoll(); goto('#/login');
    const e = new Error('登录已失效'); e.unauthorized = true;
    if (!silent) toast('登录已失效，请重新登录', 'warn');
    throw e;
  }
  if (res.status === 401 && path === '/api/me') {
    const e = new Error('未登录'); e.status = 401; e.silent = true;
    throw e;
  }
  if (res.status === 401 && path.startsWith('/api/auth/')) {
    const msg = (json && json.error && json.error.message) || '用户名或密码错误';
    const e = new Error(msg); e.status = 401; e.code = json && json.error && json.error.code;
    if (!silent) toast(msg, 'err');
    throw e;
  }
  if (!res.ok || !json || json.ok !== true) {
    const err = (json && json.error) || {};
    const msg = err.message || `请求失败（${res.status}）`;
    const e = new Error(msg); e.code = err.code; e.status = res.status;
    if (!silent) toast(msg, 'err');
    throw e;
  }
  return json.data;
}
const apiGet = (p) => api(p);
const apiPost = (p, body) => api(p, { method: 'POST', body: body || {} });
const apiPatch = (p, body) => api(p, { method: 'PATCH', body: body || {} });
const apiDel = (p) => api(p, { method: 'DELETE' });

/* ---------- 路由 ---------- */
function goto(hash) { if (location.hash === hash) route(); else location.hash = hash; }
function parseRoute() {
  const raw = (location.hash || '#/dashboard').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean);
  let name = parts[0] || 'dashboard';
  let param = null;
  if (name === 'robots' && parts[1]) { name = 'robot'; param = decodeURIComponent(parts[1]); }
  return { name, param };
}
function stopPoll() { if (S.pollId) { clearInterval(S.pollId); S.pollId = 0; } S.pollFn = null; }
function setNav() {
  const r = parseRoute();
  const logged = !!S.user;
  nav.classList.toggle('hidden', !logged);
  if (!logged) return;
  el('navUser').textContent = S.user.username || '';
  qsa('.nav-links a').forEach((a) => a.classList.toggle('active', a.dataset.route === r.name ||
    (r.name === 'robot' && a.dataset.route === 'robots')));
}
async function route() {
  stopPoll();
  closeModal();
  const seq = ++routeSeq;
  const r = parseRoute();
  setNav();
  document.title = (r.name === 'robot' ? '机器人详情' : ({ dashboard: '概览', robots: '机器人', account: '账户', apikeys: 'API Key', login: '登录' }[r.name] || '终端')) + ' · 币安量化终端';
  if (!S.user && r.name !== 'login') { location.replace('#/login'); return; }
  if (S.user && r.name === 'login') { location.replace('#/dashboard'); return; }
  const views = { login: viewLogin, dashboard: viewDashboard, robots: viewRobots, robot: viewRobot, account: viewAccount, apikeys: viewApiKeys };
  const view = views[r.name];
  if (!view) { app.innerHTML = `<div class="page">${errorBox('页面不存在', '请从导航栏进入')}</div>`; return; }
  try {
    await view(r.param, seq);
  } catch (e) {
    if (e && (e.unauthorized || e.message === 'unauthorized')) return;
    if (seq !== routeSeq) return;
    app.innerHTML = `<div class="page head-left">${errorBox('页面加载失败', e && e.message)}</div>`;
  }
}
function alive(seq) { return seq === routeSeq; }
/* 唯一的轮询入口：页面隐藏时暂停，可见时恢复并立刻补一次 */
function poll(seq, fn, ms = 3000) {
  stopPoll();
  S.pollFn = fn;
  S.pollMs = ms;
  if (document.hidden) return;
  S.pollId = setInterval(() => { if (!alive(seq)) { stopPoll(); return; } fn(); }, ms);
}
function resumePoll() {
  if (!S.pollFn || S.pollId || document.hidden) return;
  const seq = routeSeq;
  S.pollId = setInterval(() => { if (!alive(seq)) { stopPoll(); return; } S.pollFn(); }, S.pollMs || 3000);
  try { S.pollFn(); } catch (e) { /* 单次失败不断流 */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPoll();
  else resumePoll();
});
window.addEventListener('hashchange', route);

async function ensureUser() {
  if (S.user !== null) return S.user;
  try { S.user = await api('/api/me', {}, true); } catch (e) { S.user = null; }
  return S.user;
}
window.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  el('logoutBtn').addEventListener('click', async () => {
    try { await apiPost('/api/auth/logout'); } catch (e) { /* 忽略 */ }
    S.user = null; stopPoll(); goto('#/login');
  });
  await ensureUser();
  if (!S.user && !location.hash) location.replace('#/login');
  route();
});

/* ---------- 弹窗 ---------- */
function closeModal() { modalRoot.innerHTML = ''; }
function openModal({ title, body, footer, onMount, wide = false, mountEl = null }) {
  modalRoot.innerHTML = '';
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="card modal"${wide ? ' style="max-width:760px"' : ''} role="dialog" aria-modal="true">
    <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="关闭">×</button></div>
    <div class="modal-body"></div><div class="modal-foot"></div></div>`;
  const bodyEl = mask.querySelector('.modal-body');
  const footEl = mask.querySelector('.modal-foot');
  if (body) bodyEl.innerHTML = body;
  if (footer) footEl.innerHTML = footer;
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) closeModal();
  });
  modalRoot.appendChild(mask);
  const root = mountEl || bodyEl;
  if (onMount) onMount({ root, bodyEl, footEl, mask });
  return { root, bodyEl, footEl, close: closeModal };
}

/* ---------- 参数表单（由 schema 动态渲染） ---------- */
function fieldHtml(f, value) {
  const key = esc(f.key), help = f.help ? `<span class="help">${esc(f.help)}</span>` : '';
  const label = `<label for="f-${key}">${esc(f.label || f.key)}</label>`;
  let control = '';
  if (f.type === 'select') {
    const opts = (f.options || []).map((o) => {
      const v = typeof o === 'object' ? o.value : o;
      const t = typeof o === 'object' ? (o.label == null ? o.value : o.label) : o;
      return `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`;
    }).join('');
    control = `<select id="f-${key}" data-key="${key}" data-type="select">${opts}</select>`;
  } else if (f.type === 'toggle') {
    const on = value === true || value === 'true' || value === 1 || value === '1';
    control = `<span class="switch"><input id="f-${key}" type="checkbox" data-key="${key}" data-type="toggle"${on ? ' checked' : ''}><span class="track"></span></span>`;
  } else {
    const isPct = f.type === 'percent';
    control = `<input id="f-${key}" type="number" data-key="${key}" data-type="${esc(f.type || 'number')}"
      value="${esc(value == null ? '' : value)}"${f.min != null ? ` min="${esc(f.min)}"` : ''}${f.max != null ? ` max="${esc(f.max)}"` : ''}
      step="${esc(f.step != null ? f.step : isPct ? 0.1 : 1)}"${isPct ? ' placeholder="百分比数值"' : ''}>`;
  }
  if (f.type === 'toggle') return `<div class="field field-inline">${label}${control}</div>`;
  return `<div class="field">${label}${control}${help}</div>`;
}
function renderSchemaForm(schema, values = {}) {
  const groups = [];
  const map = new Map();
  (schema || []).forEach((f) => {
    const g = f.group || '参数';
    if (!map.has(g)) { map.set(g, []); groups.push(g); }
    map.get(g).push(f);
  });
  return groups.map((g) => {
    const fields = map.get(g).map((f) => {
      const v = values && Object.prototype.hasOwnProperty.call(values, f.key) ? values[f.key] : f['default'];
      return fieldHtml(f, v);
    }).join('');
    return `<div class="divider">${esc(g)}</div><div class="form-grid">${fields}</div>`;
  }).join('');
}
function collectForm(root, schema) {
  const out = {};
  (schema || []).forEach((f) => {
    const node = root.querySelector(`[data-key="${cssEsc(f.key)}"]`);
    if (!node) return;
    if (f.type === 'toggle') out[f.key] = !!node.checked;
    else if (f.type === 'number' || f.type === 'percent') {
      const n = Number(node.value);
      out[f.key] = node.value === '' || !isFinite(n) ? f['default'] : n;
    } else out[f.key] = node.value;
  });
  return out;
}
function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

/* ---------- 纯 SVG 折线图 ---------- */
let chartSeq = 0;
function lineChart(points) {
  const W = 720, H = 190, P = 12;
  if (!Array.isArray(points) || points.length < 2) return empty('暂无权益曲线数据', '机器人运行后将自动记录');
  const vals = points.map((p) => Number(p.equity)).filter((v) => isFinite(v));
  if (vals.length < 2) return empty('暂无权益曲线数据', '机器人运行后将自动记录');
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || Math.abs(max) || 1;
  const X = (i) => P + (i / (points.length - 1)) * (W - P * 2);
  const Y = (v) => H - P - ((v - min) / span) * (H - P * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(Number(p.equity)).toFixed(1)}`).join(' ');
  const area = `${d} L${X(points.length - 1).toFixed(1)},${H - P} L${X(0).toFixed(1)},${H - P} Z`;
  const up = vals[vals.length - 1] >= vals[0];
  // 颜色走 CSS 变量，切主题时重画即可变色
  const stroke = up ? cssVar('--green', '#0ecb81') : cssVar('--red', '#f6465d');
  const axis = cssVar('--border', '#2c3140');
  const gid = 'lg' + (chartSeq += 1);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="权益曲线">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${stroke}" stop-opacity=".28"/><stop offset="1" stop-color="${stroke}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#${gid})"/><path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="${axis}" stroke-width="1"/>
  </svg>`;
}

/* ---------- K 线图（蜡烛图，纯 SVG，无依赖） ---------- */
const KLINE_INTERVALS = [
  { v: '1m', label: '1分' }, { v: '5m', label: '5分' }, { v: '15m', label: '15分' },
  { v: '1h', label: '1时' }, { v: '4h', label: '4时' }, { v: '1d', label: '1天' },
];

function candlesChart(bars, opts = {}) {
  const W = 900, H = 320, P = { l: 8, r: 58, t: 12, b: 22 };
  if (!Array.isArray(bars) || bars.length < 2) return empty('暂无 K 线数据', '换个周期试试，或稍后重试');
  const ivw = W - P.l - P.r, ivh = H - P.t - P.b;
  const highs = bars.map((b) => Number(b.h));
  const lows = bars.map((b) => Number(b.l));
  let max = Math.max(...highs), min = Math.min(...lows);
  const pad = (max - min) * 0.08 || Math.abs(max) * 0.02 || 1;
  max += pad; min -= pad;
  const X = (i) => P.l + (i + 0.5) * (ivw / bars.length);
  const Y = (v) => P.t + (1 - (v - min) / (max - min || 1)) * ivh;
  const bw = Math.max(1.2, (ivw / bars.length) * 0.62);
  // 蜡烛/网格/刻度颜色全部读 CSS 变量（切主题后重画即变色）
  const C_UP = cssVar('--green', '#0ecb81'), C_DOWN = cssVar('--red', '#f6465d');
  const C_GRID = cssVar('--border', '#2c3140'), C_MUTED = cssVar('--muted', '#8b93a7');
  const C_ACCENT = cssVar('--accent', '#f0b90b'), C_ACCENT_TEXT = cssVar('--accent-text', '#12141a');

  const body = bars.map((b, i) => {
    const o = Number(b.o), c = Number(b.c), h = Number(b.h), l = Number(b.l);
    const up = c >= o;
    const col = up ? C_UP : C_DOWN;
    const y1 = Y(Math.max(o, c)), y2 = Y(Math.min(o, c));
    const bh = Math.max(1, y2 - y1);
    const x = X(i);
    return `<line x1="${x.toFixed(2)}" y1="${Y(h).toFixed(2)}" x2="${x.toFixed(2)}" y2="${Y(l).toFixed(2)}" stroke="${col}" stroke-width="1"/>
      <rect x="${(x - bw / 2).toFixed(2)}" y="${y1.toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" fill="${col}" rx="0.5"/>`;
  }).join('');

  // 右侧价格刻度
  const ticks = 5;
  let grid = '';
  for (let k = 0; k <= ticks; k += 1) {
    const v = min + ((max - min) * k) / ticks;
    const y = Y(v);
    grid += `<line x1="${P.l}" y1="${y.toFixed(2)}" x2="${(W - P.r).toFixed(2)}" y2="${y.toFixed(2)}" stroke="${C_GRID}" stroke-width="1" stroke-dasharray="3 4"/>
      <text x="${(W - P.r + 6).toFixed(2)}" y="${(y + 3.5).toFixed(2)}" fill="${C_MUTED}" font-size="10" font-family="monospace">${v >= 100 ? v.toFixed(2) : v.toFixed(4)}</text>`;
  }
  // 时间刻度（取首/中/尾）
  const times = [0, Math.floor(bars.length / 2), bars.length - 1].map((i) => {
    const t = Number(bars[i].t) || 0;
    const d = new Date(t);
    const lbl = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `<text x="${X(i).toFixed(2)}" y="${(H - 6).toFixed(2)}" fill="${C_MUTED}" font-size="10" text-anchor="middle">${lbl}</text>`;
  }).join('');

  const last = bars[bars.length - 1];
  const lastC = Number(last.c);
  const lastY = Y(lastC);
  return `<svg class="kline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="K线图">
    ${grid}${body}${times}
    <line x1="${P.l}" y1="${lastY.toFixed(2)}" x2="${(W - P.r).toFixed(2)}" y2="${lastY.toFixed(2)}" stroke="${C_ACCENT}" stroke-width="1" stroke-dasharray="5 4" opacity=".85"/>
    <rect x="${(W - P.r).toFixed(2)}" y="${(lastY - 9).toFixed(2)}" width="${P.r}" height="18" fill="${C_ACCENT}" rx="2"/>
    <text x="${(W - P.r + 4).toFixed(2)}" y="${(lastY + 4).toFixed(2)}" fill="${C_ACCENT_TEXT}" font-size="10" font-family="monospace">${lastC >= 100 ? lastC.toFixed(2) : lastC.toFixed(4)}</text>
  </svg>`;
}

async function openKline(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return;
  let interval = '15m';
  let ov = null;
  try { ov = await apiGet('/api/market/overview?symbol=' + encodeURIComponent(sym)); } catch (e) { ov = null; }
  const priceTxt = ov ? money(ov.price, ov.price >= 100 ? 2 : 4) : '—';
  const chg = ov ? Number(ov.change24hPct) : 0;
  const body = `
    <div class="kline-head">
      <div><b class="kline-sym">${esc(sym)}</b>
        <span class="mono kline-price">${priceTxt}</span>
        <span class="mono ${chg >= 0 ? 'up' : 'down'}">${signed(chg)}%</span></div>
      <div class="seg seg-sm" id="kIv">${KLINE_INTERVALS.map((it) => `<button class="seg-btn${it.v === interval ? ' active' : ''}" data-iv="${it.v}" type="button">${it.label}</button>`).join('')}</div>
    </div>
    <div class="kline-meta muted" id="kMeta">加载中…</div>
    <div id="kChart">${loading('K 线加载中…')}</div>`;
  openModal({
    title: sym + ' K 线',
    body,
    wide: true,
    footer: '<button class="btn btn-ghost" data-close type="button">关闭</button>',
    onMount: ({ bodyEl }) => {
      const chartEl = bodyEl.querySelector('#kChart');
      const metaEl = bodyEl.querySelector('#kMeta');
      const loadK = async () => {
        chartEl.innerHTML = loading('K 线加载中…');
        try {
          const bars = await apiGet(`/api/market/klines?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(interval)}&limit=160`);
          chartEl.innerHTML = candlesChart(bars);
          if (Array.isArray(bars) && bars.length) {
            const f = bars[0], l = bars[bars.length - 1];
            const chgPct = ((Number(l.c) - Number(f.o)) / Number(f.o)) * 100;
            metaEl.innerHTML = `${KLINE_INTERVALS.find((x) => x.v === interval).label} · ${bars.length} 根 · 区间涨跌 <span class="${chgPct >= 0 ? 'up' : 'down'}">${signed(chgPct)}%</span> · 最高 ${money(Math.max(...bars.map((b) => Number(b.h))), 2)} · 最低 ${money(Math.min(...bars.map((b) => Number(b.l))), 2)}`;
          }
        } catch (e) { chartEl.innerHTML = errorBox('K 线加载失败', e.message); }
      };
      bodyEl.querySelectorAll('#kIv .seg-btn').forEach((btn) => btn.addEventListener('click', () => {
        interval = btn.dataset.iv;
        bodyEl.querySelectorAll('#kIv .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
        loadK();
      }));
      loadK();
    },
  });
}

/* ---------- 登录 / 注册 ---------- */
async function viewLogin(param, seq) {
  stopPoll();
  app.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
    <div class="auth-brand"><span class="logo">B</span>币安量化终端</div>
    <div class="seg seg-wide auth-tabs">
      <button class="seg-btn active" data-tab="login" type="button">登录</button>
      <button class="seg-btn" data-tab="register" type="button">注册</button>
    </div>
    <form class="auth-form" id="authForm" novalidate>
      <div class="field"><label for="au">用户名</label>
        <input id="au" name="username" type="text" autocomplete="username" placeholder="请输入用户名" required></div>
      <div class="field"><label for="ap">密码</label>
        <input id="ap" name="password" type="password" autocomplete="current-password" placeholder="请输入密码" required></div>
      <p class="auth-msg muted" id="authMsg"></p>
      <button class="btn btn-primary btn-block" type="submit" id="authSubmit">登录</button>
    </form>
    <p class="muted" style="text-align:center;margin:0">登录后即可管理量化机器人策略</p>
  </div></div>`;
  let mode = 'login';
  const msg = el('authMsg');
  qsa('.auth-tabs .seg-btn', app).forEach((btn) => btn.addEventListener('click', () => {
    mode = btn.dataset.tab;
    qsa('.auth-tabs .seg-btn', app).forEach((b) => b.classList.toggle('active', b === btn));
    el('authSubmit').textContent = mode === 'login' ? '登录' : '注册并登录';
    el('ap').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    msg.textContent = '';
  }));
  el('authForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const username = el('au').value.trim(), password = el('ap').value;
    if (!username || !password) { msg.textContent = '请填写用户名和密码'; return; }
    const btn = el('authSubmit');
    btn.disabled = true; btn.textContent = '处理中…';
    try {
      if (mode === 'register') {
        await apiPost('/api/auth/register', { username, password });
        const d = await apiPost('/api/auth/login', { username, password });
        S.user = d.user || d;
        toast('注册成功，已自动登录', 'ok');
      } else {
        const d = await apiPost('/api/auth/login', { username, password });
        S.user = d.user || d;
        toast('登录成功', 'ok');
      }
      if (!S.user || !S.user.username) { try { S.user = await api('/api/me', {}, true); } catch (e) { /* ignore */ } }
      goto('#/dashboard');
    } catch (e) {
      msg.textContent = e && e.message && e.message !== 'network' ? e.message : '';
      btn.disabled = false; btn.textContent = mode === 'login' ? '登录' : '注册并登录';
    }
  });
}

/* ---------- 概览 ---------- */
let dashMode = 'paper';
async function viewDashboard(param, seq) {
  const saved = sessionStorage.getItem('dashMode');
  if (saved === 'paper' || saved === 'live') dashMode = saved;
  app.innerHTML = `<div class="page">
    <div class="page-head"><div class="head-left"><h1>概览</h1><span class="muted" id="dashUpdated"></span></div>
      <div class="head-actions"><div class="seg" id="dashSeg">
        <button class="seg-btn" data-mode="paper" type="button">模拟盘</button>
        <button class="seg-btn" data-mode="live" type="button">实盘</button>
      </div></div></div>
    <div class="banner banner-warn hidden" id="dashLiveWarn"></div>
    <div class="kpis" id="dashKpis">${loading('加载中…')}</div>
    <div class="grid-2">
      <div class="card"><div class="card-head"><h2>行情</h2><span class="muted" id="dashMarketMeta">24h 涨跌 / ATR</span></div>
        <div class="mk-tools"><input id="dashMkSearch" class="mk-search" type="search" placeholder="搜索币种，例如 BTC / PEPE" autocomplete="off"></div>
        <div id="dashMarket" class="mk-scroll">${loading('加载中…')}</div></div>
      <div class="card"><div class="card-head"><h2>权益曲线</h2><span class="muted" id="dashCurveMeta">首个机器人</span></div><div id="dashCurve">${loading('加载中…')}</div></div>
    </div></div>`;
  const segBtns = qsa('#dashSeg .seg-btn', app);
  const syncSeg = () => segBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === dashMode));
  syncSeg();
  segBtns.forEach((b) => b.addEventListener('click', () => {
    dashMode = b.dataset.mode; sessionStorage.setItem('dashMode', dashMode); syncSeg(); loadDash(seq);
  }));
  const kpisEl = el('dashKpis'), mkEl = el('dashMarket'), cvEl = el('dashCurve'), warnEl = el('dashLiveWarn');
  let cvSig = '';

  async function loadDash(s2) {
    const q = '?mode=' + encodeURIComponent(dashMode);
    const [ov, robots] = await Promise.allSettled([apiGet('/api/account/overview' + q), apiGet('/api/robots')]);
    if (!alive(s2)) return;
    if (ov.status === 'fulfilled') {
      const d = ov.value;
      patchText(app, '#dashUpdated', '更新于 ' + fmtTime(d.updatedAt || Date.now()));
      const live = d.live || null;
      const warn = dashMode === 'live' && live && (live.configured === false || !!live.error);
      if (warnEl) {
        if (warnEl.classList.contains('hidden') === warn) warnEl.classList.toggle('hidden', !warn);
        if (warn) setText(warnEl, '实盘账户未就绪' + (live.error ? '：' + live.error : '') + (live.configured === false ? '（未配置 API Key）' : ''));
      }
      const today = d.todayPnl || 0;
      const okR = robots.status === 'fulfilled';
      const rl = okR ? (robots.value || []) : null;
      // KPI 卡只 patch 文本与 class，不重建节点
      patchKpis(kpisEl, [
        { label: '账户权益 (' + (dashMode === 'live' ? '实盘' : '模拟盘') + ')', value: money(d.equity), sub: 'USDT' },
        { label: '今日盈亏（含浮动）', value: signed(today), cls: signCls(today),
          sub: Number.isFinite(Number(d.todayPnlPct)) ? signed(d.todayPnlPct) + '%' : '—', subCls: signCls(today) },
        { label: '今日已落袋', value: signed(d.todayRealizedPnl), cls: signCls(d.todayRealizedPnl), sub: '平仓盈亏 − 手续费' },
        { label: '运行中机器人', value: okR ? String(rl.filter((r) => r.status === 'running').length) : '—',
          sub: '共 ' + (okR ? rl.length : '—') + ' 个' },
        { label: '累计订单数', value: okR ? String(rl.reduce((a, r) => a + (Number(r.stats && r.stats.orders) || 0), 0)) : '—',
          sub: '持仓 ' + (d.positions || []).length },
      ]);
      kpisEl.dataset.err = '';
    } else if (kpisEl.dataset.err !== '1') {
      kpisEl.dataset.err = '1';
      setHTML(kpisEl, errorBox('账户数据加载失败', ov.reason && ov.reason.message));
    }

    // 权益曲线用「账户级」快照：所有机器人共用一个钱包，曲线必须代表整个账户
    try {
      const cv = await apiGet('/api/account/equity-curve?mode=' + encodeURIComponent(dashMode) + '&limit=500');
      if (!alive(s2)) return;
      const points = (cv && cv.points) || [];
      patchText(app, '#dashCurveMeta', points.length
        ? points.length + ' 点 · ' + (dashMode === 'live' ? '实盘' : '模拟盘') + '账户' : '—');
      // 数据没变就不重画 SVG，避免每 3 秒闪一次
      const sig = points.length + ':' + (points.length
        ? Number(points[points.length - 1].equity) + ':' + Number(points[points.length - 1].ts) : '');
      if (sig !== cvSig) {
        cvSig = sig;
        setHTML(cvEl, lineChart(points));
      }
    } catch (e) {
      if (alive(s2) && cvSig !== 'err') { cvSig = 'err'; setHTML(cvEl, errorBox('曲线加载失败', e && e.message)); }
    }
    await loadMarket(s2);
  }
  let mkAll = [];
  const mkSearch = el('dashMkSearch');
  /* 行情表：只有标的集合变化才重建表；价格/涨跌只改单元格文本 */
  function renderMarket(filter) {
    const kw = String(filter || '').trim().toUpperCase();
    const list = kw ? mkAll.filter((s) => s.symbol.includes(kw)) : mkAll;
    const body = mkEl.querySelector('tbody');
    if (!list.length) {
      if (body || !mkEl.querySelector('.state')) setHTML(mkEl, empty('没有匹配的币种', '换个关键词试试，例如 BTC、ETH、PEPE'));
      return;
    }
    const sig = list.map((s) => s.symbol).join(',');
    if (!body || mkEl.dataset.sig !== sig) {
      const prevTop = mkEl.scrollTop;
      setHTML(mkEl, `<div class="table-wrap"><table class="table table-compact"><thead><tr>
        <th>币种</th><th class="ra">最新价</th><th class="ra">24h 涨跌</th><th class="ra">ATR%</th></tr></thead>
        <tbody>${list.map((s) => `<tr class="mk-row" data-symbol="${esc(s.symbol)}" title="点击查看 K 线">
          <td><b>${esc(s.symbol.replace(/USDT$/, ''))}</b><span class="muted mk-quote">/USDT</span></td>
          <td class="ra mono" data-cell="p"></td><td class="ra mono" data-cell="c"></td>
          <td class="ra mono muted" data-cell="a"></td></tr>`).join('')}</tbody></table></div>`);
      mkEl.dataset.sig = sig;
      mkEl.scrollTop = prevTop;
      qsa('.mk-row', mkEl).forEach((tr) => tr.addEventListener('click', () => openKline(tr.dataset.symbol)));
      qsa('.mk-row', mkEl).forEach((tr) => { tr.dataset.bound = '1'; });
    }
    const rows = qsa('.mk-row', mkEl);
    list.forEach((s, i) => {
      const tr = rows[i];
      if (!tr) return;
      const up = Number(s.change24hPct) >= 0;
      const pc = tr.querySelector('[data-cell="p"]'), cc = tr.querySelector('[data-cell="c"]'), ac = tr.querySelector('[data-cell="a"]');
      setText(pc, money(s.price, s.price >= 100 ? 2 : 4));
      setText(cc, signed(s.change24hPct) + '%');
      const want = 'ra mono ' + (up ? 'up' : 'down');
      if (cc && cc.className !== want) cc.className = want;
      setText(ac, s.atrPct ? num(s.atrPct, 2) + '%' : '—');
    });
  }
  if (mkSearch) {
    mkSearch.addEventListener('input', debounce(() => renderMarket(mkSearch.value), 200));
  }
  async function loadMarket(s2) {
    try {
      const list = await apiGet('/api/market/symbols');
      if (!alive(s2)) return;
      if (!list || !list.length) {
        if (mkEl.dataset.sig !== 'empty') { mkEl.dataset.sig = 'empty'; setHTML(mkEl, empty('暂无行情')); }
        return;
      }
      mkAll = list;
      renderMarket(mkSearch ? mkSearch.value : '');
      const degraded = list.some((s) => s.degraded);
      patchText(app, '#dashMarketMeta', degraded
        ? '模拟行情（币安不可达，已降级）'
        : `币安实时行情 · ${list.length} 个币种 · 点击看 K 线`);
    } catch (e) {
      if (alive(s2) && mkEl.dataset.sig !== 'err') { mkEl.dataset.sig = 'err'; setHTML(mkEl, errorBox('行情加载失败', e.message)); }
    }
  }
  await loadDash(seq);
  poll(seq, () => guarded(() => loadDash(seq)));
}

/* ---------- 机器人列表 ---------- */
const STATUS_LABEL = { running: '运行中', stopped: '已停止', halted: '已熔断', error: '异常', idle: '空闲', created: '已创建' };
function statusBadge(s) {
  const st = String(s || 'stopped');
  const cls = st === 'running' ? 'badge-ok' : st === 'halted' || st === 'error' ? 'badge-err' : '';
  return `<span class="badge ${cls}">${esc(STATUS_LABEL[st] || st)}</span>`;
}
function modeBadge(m) {
  return `<span class="badge ${m === 'live' ? 'badge-live' : 'badge-paper'}">${m === 'live' ? '实盘' : '模拟盘'}</span>`;
}
let metaCache = null;
async function getMeta(force) {
  if (!metaCache || force) metaCache = await apiGet('/api/meta/defaults');
  return metaCache;
}

async function viewRobots(param, seq) {
  app.innerHTML = `<div class="page">
    <div class="page-head"><div class="head-left"><h1>机器人</h1><span class="muted" id="botCount"></span></div>
      <div class="head-actions"><button class="btn btn-primary" id="newBotBtn" type="button">+ 新建机器人</button></div></div>
    <div id="botList">${loading('加载中…')}</div></div>`;
  const listEl = el('botList');
  el('newBotBtn').addEventListener('click', () => openCreateBot(seq));
  robotsRefresh = () => load(seq);

  async function load(s2) {
    let list;
    try { list = await apiGet('/api/robots'); }
    catch (e) {
      if (!alive(s2)) return;
      if (listEl.dataset.sig !== 'err') { listEl.dataset.sig = 'err'; setHTML(listEl, errorBox('机器人列表加载失败', e.message)); }
      return;
    }
    if (!alive(s2)) return;
    list = list || [];
    patchText(app, '#botCount', `共 ${list.length} 个 · ${list.filter((r) => r.status === 'running').length} 个运行中`);
    if (!list.length) {
      if (listEl.dataset.sig !== 'empty') {
        listEl.dataset.sig = 'empty';
        setHTML(listEl, `<div class="card">${empty('还没有机器人', '点击右上角「+ 新建机器人」开始')}</div>`);
      }
      return;
    }
    // 卡片按 id 复用：只有增删机器人时才重建，其余只 patch 数字/徽章，不打断 hover 与点击
    let grid = listEl.querySelector('.bot-grid');
    if (!grid) {
      setHTML(listEl, '<div class="bot-grid"></div>');
      grid = listEl.querySelector('.bot-grid');
      listEl.dataset.sig = 'list';
    }
    patchKeyed(grid, list, (r) => String(r.id), botCardNode);
    const cards = qsa('.bot-card', grid);
    list.forEach((r, i) => {
      const card = cards[i];
      if (!card || card.dataset.id !== String(r.id)) return;
      patchBotCard(card, r);
    });
  }
  await load(seq);
  poll(seq, () => guarded(() => load(seq)));
}

/* 卡片骨架只建一次，值走 data-f 定位后 setText */
function botCardNode(r) {
  const node = document.createElement('div');
  node.className = 'card bot-card';
  node.dataset.id = String(r.id);
  node.dataset.key = String(r.id);
  node.innerHTML = `<div class="bot-top"><a class="bot-name" data-f="name" href="#/robots/${encodeURIComponent(r.id)}"></a>
      <div class="bot-badges" data-f="badges"></div></div>
    <div class="bot-meta muted"><span data-f="symbol"></span> · 最后更新 <span data-f="tick"></span></div>
    <div class="bot-meta muted">分配资金 <b class="mono" data-f="alloc"></b> U　当前资金基数 <b class="mono" data-f="capital"></b> U<span data-f="extra"></span></div>
    <div class="bot-nums">
      <div><span class="muted">权益</span><b class="mono" data-f="equity"></b></div>
      <div><span class="muted">收益率</span><b class="mono" data-f="pct"></b></div>
      <div><span class="muted">订单数</span><b class="mono" data-f="orders"></b></div>
    </div>
    <div class="muted down" data-f="err"></div>
    <div class="bot-actions">
      <button class="btn btn-sm" data-act="start" type="button">启动</button>
      <button class="btn btn-sm" data-act="stop" type="button">停止</button>
      <button class="btn btn-sm btn-ghost" data-act="reset" type="button">重置</button>
      <button class="btn btn-sm btn-danger" data-act="delete" type="button">删除</button></div>`;
  patchBotCard(node, r);
  bindBotCardActions(node);
  return node;
}
function patchBotCard(card, r) {
  const st = r.stats || {};
  const q = (f) => card.querySelector('[data-f="' + f + '"]');
  const pnlPct = Number(st.pnlPct) || 0;
  setText(q('name'), r.name || '未命名');
  const badges = modeBadge(r.mode) + statusBadge(st.halted ? 'halted' : r.status);
  const bEl = q('badges');
  if (bEl && bEl.innerHTML !== badges) bEl.innerHTML = badges;
  setText(q('symbol'), r.symbol || '—');
  setText(q('tick'), ago(r.lastTick || r.startedAt));
  setText(q('alloc'), money((r.params || {}).allocatedCapital));
  // 当前资金基数 = 分配资金 + 本机器人已实现盈亏（赚钱后仓位会变大）
  setText(q('capital'), money(st.capital));
  const usedMargin = Number(st.marginUsed);
  setText(q('extra'), Number.isFinite(usedMargin) ? ' / 已占用 ' + money(usedMargin) + ' U' : '');
  setText(q('equity'), money(st.equity));
  setText(q('pct'), signed(pnlPct) + '%');
  const pctEl = q('pct');
  if (pctEl) {
    const want = 'mono ' + signCls(pnlPct);
    if (pctEl.className !== want) pctEl.className = want;
  }
  setText(q('orders'), num(st.orders, 0));
  setText(q('err'), r.lastError ? String(r.lastError).slice(0, 100) : '');
  const running = r.status === 'running';
  qsa('button[data-act]', card).forEach((btn) => {
    const a = btn.dataset.act;
    const dis = a === 'start' ? running : a === 'stop' ? !running : false;
    if (!btn.dataset.busy && btn.disabled !== dis) btn.disabled = dis;
  });
}
function bindBotCardActions(card) {
  const id = card.dataset.id;
  qsa('button[data-act]', card).forEach((btn) => btn.addEventListener('click', async () => {
    const act = btn.dataset.act;
    if (act === 'stop') { askStop(id, () => refreshRobots()); return; }
    if (act === 'delete' && !confirm('确认删除该机器人？该操作不可恢复。')) return;
    if (act === 'reset' && !confirm('确认重置机器人状态与统计？')) return;
    btn.disabled = true;
    btn.dataset.busy = '1';
    try {
      if (act === 'start') await apiPost(`/api/robots/${encodeURIComponent(id)}/start`);
      else if (act === 'reset') await apiPost(`/api/robots/${encodeURIComponent(id)}/reset`);
      else if (act === 'delete') { await apiDel(`/api/robots/${encodeURIComponent(id)}`); toast('已删除', 'ok'); }
      if (act !== 'delete') toast('操作成功', 'ok');
      await refreshRobots();
    } catch (e) { btn.disabled = false; } finally { delete btn.dataset.busy; }
  }));
}
/* 列表页的刷新入口：由当前路由挂上，避免把 load 传来传去 */
let robotsRefresh = null;
async function refreshRobots() { if (robotsRefresh) await robotsRefresh(); }

/* 停止机器人：两个选项，避免「想留着仓位却被平掉」 */
function askStop(rid, after) {
  const body = `<p class="hint" style="margin:0 0 10px">机器人停止后不再开新仓。请选择现有仓位如何处理：</p>
    <p class="muted" style="margin:0">「保留仓位」只停策略；「平掉仓位」会先市价平掉本机器人当前持仓再停。</p>`;
  const foot = `<button class="btn btn-ghost" data-close type="button">取消</button>
    <button class="btn" data-stop="keep" type="button">停止但保留仓位</button>
    <button class="btn btn-danger" data-stop="close" type="button">停止并平掉本机器人仓位</button>`;
  const ui = openModal({ title: '停止机器人', body, footer: foot });
  qsa('button[data-stop]', ui.footEl).forEach((b) => b.addEventListener('click', async () => {
    const closePositions = b.dataset.stop === 'close';
    qsa('button', ui.footEl).forEach((x) => { x.disabled = true; });
    b.textContent = '停止中…';
    try {
      await apiPost(`/api/robots/${encodeURIComponent(rid)}/stop`, { closePositions });
      closeModal();
      toast(closePositions ? '已停止并平仓' : '已停止，仓位保留', 'ok');
      await after();
    } catch (e) {
      qsa('button', ui.footEl).forEach((x) => { x.disabled = false; });
      b.textContent = closePositions ? '停止并平掉本机器人仓位' : '停止但保留仓位';
    }
  }));
}

/* ---------- 新建机器人弹窗 ---------- */
async function openCreateBot(seq) {
  const m = await getMeta().catch(() => null);
  if (!m) { toast('参数元数据加载失败', 'err'); return; }
  const schema = (m.params && m.params.schema) || [];
  const defaults = (m.params && m.params.defaults) || {};
  const modes = m.modes || [{ value: 'paper', label: '模拟盘' }, { value: 'live', label: '实盘' }];
  const symbols = m.symbols || (m.symbolDetail || []).map((s) => s.symbol) || [];
  const body = `<form id="createForm" novalidate>
    <div class="field"><label for="cName">机器人名称</label>
      <input id="cName" type="text" maxlength="40" placeholder="例如：BTC 网格稳健型"></div>
    <div class="field-row">
      <div class="field"><label for="cSym">交易标的</label>
        <select id="cSym">${symbols.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</select></div>
      <div class="field"><label for="cMode">运行模式</label>
        <select id="cMode">${modes.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></div>
    </div>
    <div class="preview" id="cLiveWarn"></div>
    <div id="cParams">${renderSchemaForm(schema, defaults)}</div>
    <div class="preview" id="cPreview">调整参数后可预览策略计划</div></form>`;
  const foot = `<button class="btn" data-close type="button">取消</button>
    <button class="btn btn-primary" id="cSubmit" type="button">创建机器人</button>`;
  const ui = openModal({ title: '新建机器人', body, footer: foot, wide: true });
  // 注意：身体区在 ui.bodyEl，按钮在 ui.footEl。用 ui.root（bodyEl 的别名）查 footer 里的元素会得到 null。
  const bodyEl = ui.bodyEl;
  const cParams = bodyEl.querySelector('#cParams');
  const cSym = bodyEl.querySelector('#cSym');
  const cMode = bodyEl.querySelector('#cMode');
  const cName = bodyEl.querySelector('#cName');
  const cPreview = bodyEl.querySelector('#cPreview');
  const cLiveWarn = bodyEl.querySelector('#cLiveWarn');
  let lastPreview = null;
  // 实盘：建机器人前先查该交易对是否已经有仓。
  // 币安双向持仓是账户级聚合，程序分不清「机器人开的」和「用户手动开的」。
  // 现行规则（用户 m06852）：机器人一旦启动就**接管该交易对全部仓位** ——
  // 已有仓会被登记进机器人账本、按交易所真实均价等止盈价一次性全平，然后才重建第一层。
  // 所以这里只做「提前告知」，不再让用户二选一。
  let liveCheckSeq = 0;
  const checkLivePosition = async () => {
    if (cMode.value !== 'live') { cLiveWarn.innerHTML = ''; return; }
    const my = ++liveCheckSeq;
    cLiveWarn.innerHTML = '<span class="muted">正在检查该交易对的现有持仓…</span>';
    let d = null;
    try {
      d = await apiGet('/api/robots/live-position?symbol=' + encodeURIComponent(cSym.value));
    } catch (e) {
      if (my !== liveCheckSeq) return;
      cLiveWarn.innerHTML = `<span class="muted">持仓检查失败：${esc(e.message)}（不影响创建，但建议先确认）</span>`;
      return;
    }
    if (my !== liveCheckSeq) return;
    if (!d || !d.configured) {
      cLiveWarn.innerHTML = '<div class="banner banner-warn">还没有可用的 API Key，无法检查现有持仓。实盘启动前请先在「API Key」页面配置并验证。</div>';
      return;
    }
    if (d.error) {
      cLiveWarn.innerHTML = `<div class="banner banner-warn">${esc(d.error)}</div>`;
      return;
    }
    if (!d.hasPosition) { cLiveWarn.innerHTML = ''; return; }
    const parts = [];
    if (d.long) parts.push(`多单 ${num(d.long.qty, 6)} 张（开仓价 ${money(d.long.entryPrice, 4)}）`);
    if (d.short) parts.push(`空单 ${num(d.short.qty, 6)} 张（开仓价 ${money(d.short.entryPrice, 4)}）`);
    cLiveWarn.innerHTML = `<div class="banner banner-warn" style="display:block">
      <div><b>这个交易对已经有持仓</b>：${esc(parts.join('；'))}。</div>
      <div style="margin-top:8px">机器人启动后会<b>接管这里全部仓位</b>：把这部分仓登记进机器人账本，按交易所真实均价算出实际止盈价，价位到了就一次性全部平掉，然后才重新建第一层。接管期间不加仓（因为没等到止盈价再往下加仓只会让风险越来越大）。</div>
      <div style="margin-top:8px" class="muted">如果你希望机器人从现在起完全按自己的参数开始、不被现有仓影响，请先手动把该交易对的仓位平掉再启动机器人。</div>
    </div>`;
  };
  const preview = debounce(async () => {
    const params = collectForm(cParams, schema);
    const symbol = cSym.value;
    const mode = cMode.value;
    try {
      const d = await apiPost('/api/robots/preview', { symbol, mode, params });
      lastPreview = d;
      cPreview.innerHTML = previewHtml(d);
    } catch (e) {
      cPreview.innerHTML = `<span class="muted">预览失败：${esc(e.message)}</span>`;
    }
  }, 320);
  cParams.addEventListener('input', preview);
  cParams.addEventListener('change', preview);
  cSym.addEventListener('change', () => { preview(); checkLivePosition(); });
  cMode.addEventListener('change', () => { preview(); checkLivePosition(); });
  checkLivePosition();
  preview();
  const submitBtn = ui.footEl.querySelector('#cSubmit');
  submitBtn.addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const name = cName.value.trim();
    if (!name) { toast('请填写机器人名称', 'warn'); cName.focus(); return; }
    const payload = {
      name,
      symbol: cSym.value,
      mode: cMode.value,
      params: collectForm(cParams, schema),
    };
    btn.disabled = true; btn.textContent = '创建中…';
    try {
      const d = await apiPost('/api/robots', payload);
      closeModal();
      toast('机器人已创建', 'ok');
      const id = d && d.robot && d.robot.id;
      goto(id ? '#/robots/' + encodeURIComponent(id) : '#/robots');
    } catch (e) { btn.disabled = false; btn.textContent = '创建机器人'; }
  });
}

/* ---------- 计划预览渲染 ---------- */
/**
 * 强平价显示。
 * 币安全仓下，当账户权益远大于持仓时，强平价算出来会是负数
 * （意思是「这个仓位靠自身根本爆不掉」）。负数没有意义，统一显示 0。
 */
function liqText(v) {
  const n = Number(v);
  // <=0 表示「这个仓位靠自身不会爆仓」（币安全仓下常见），统一显示 0
  if (!Number.isFinite(n) || n <= 0) return '<span title="强平价为 0 或负数：该仓位靠自身资金不会爆仓">0</span>';
  return money(n, 2);
}

function layerCount(p) {
  if (!p) return '—';
  if (Array.isArray(p.layers)) return p.layers.length;
  if (Array.isArray(p.layerList)) return p.layerList.length;
  return num(p.layers, 0);
}
function previewHtml(d) {
  const p = (d && d.plan) || {};
  const notes = (p.notes || []).map((n) => `<li>${esc(n)}</li>`).join('');
  const feas = p.feasible === false ? '<span class="badge badge-err">不可行</span>' : '<span class="badge badge-ok">可行</span>';
  const hasLong = p.hasLong !== false && (p.direction === 'dual' || p.direction === 'long' || p.hasLong === true);
  const hasShort = p.hasShort === true || p.direction === 'dual' || p.direction === 'short';
  const tpModeLabel = p.tpMode === 'layer' ? '逐笔止盈' : '整体止盈';
  const curLong = p.currentTpPrice ? money(p.currentTpPrice, 2) : '—';
  const curShort = p.currentTpPriceShort ? money(p.currentTpPriceShort, 2) : '—';
  return `<div class="preview-title">策略计划预览 ${feas}</div>
    <div class="plan-grid">
      <div class="plan-item"><span>分配资金</span><b class="mono">${money(p.allocatedCapital || p.capital)} U</b></div>
      <div class="plan-item"><span>加满占用保证金</span><b class="mono">${money(p.marginTotal)} U</b></div>
      <div class="plan-item"><span>交易方向</span><b class="mono">${esc(p.direction === 'long' ? '只做多' : p.direction === 'short' ? '只做空' : '双向')}</b></div>
      <div class="plan-item"><span>最多加仓到几笔</span><b class="mono">${esc(layerCount(p))}</b></div>
      <div class="plan-item"><span>第一笔保证金</span><b class="mono">${money(p.firstLayerMargin)}</b></div>
      <div class="plan-item"><span>第一笔仓位(名义)</span><b class="mono">${money(p.firstLayerNotional)}</b></div>
      <div class="plan-item"><span>每笔是上一笔的几倍</span><b class="mono">${num(p.growRatio, 2)}</b></div>
      <div class="plan-item"><span>加仓间距</span><b class="mono">${num(p.spacingPct, 2)}%</b></div>
      <div class="plan-item"><span>单方向最多投入(名义)</span><b class="mono">${money(p.notionalTotal)}</b></div>
      <div class="plan-item"><span>止盈方式</span><b class="mono">${esc(tpModeLabel)} ${num(p.tpPct, 2)}%</b></div>
      <div class="plan-item"><span>止损幅度</span><b class="mono">${num(p.stopPct, 2)}%</b></div>
      <div class="plan-item"><span>现在(只1笔)该盯的多单止盈</span><b class="mono up">${curLong}</b></div>
      ${hasShort ? `<div class="plan-item"><span>现在(只1笔)该盯的空单止盈</span><b class="mono up">${curShort}</b></div>` : ''}
      <div class="plan-item"><span>加满后多单均价</span><b class="mono">${money(p.avgEntry, 2)}</b></div>
      ${hasShort ? `<div class="plan-item"><span>加满后空单均价</span><b class="mono">${money(p.avgEntryShort, 2)}</b></div>` : ''}
      <div class="plan-item"><span>加满后多单强平</span><b class="mono down">${liqText(p.liqPrice)}</b></div>
      ${hasShort ? `<div class="plan-item"><span>加满后空单强平</span><b class="mono down">${liqText(p.liqPriceShort)}</b></div>` : ''}
      <div class="plan-item"><span>加满后多单止损</span><b class="mono down">${money(p.stopPrice, 2)}</b></div>
      ${hasShort ? `<div class="plan-item"><span>加满后空单止损</span><b class="mono down">${money(p.stopPriceShort, 2)}</b></div>` : ''}
      <div class="plan-item"><span>加满后最坏亏损</span><b class="mono down">${num(p.maxLossPct, 2)}%</b></div>
    </div>${notes ? `<ul class="notes">${notes}</ul>` : ''}`;
}
function layersTable(d) {
  const cand = [d && d.plan && d.plan.layerList, d && d.layers, d && d.plan && d.plan.layers];
  const layers = cand.find((x) => Array.isArray(x) && x.length) || [];
  if (!layers.length) return empty('暂无加仓计划', '参数计算后展示每一笔的触发价');
  const plan0 = (d && d.plan) || {};
  const dir = plan0.direction || 'dual';
  const hasLong = plan0.hasLong !== false && dir !== 'short';
  const hasShort = plan0.hasShort === true || dir === 'dual' || dir === 'short';
  const built = num(d && d.builtLayers, 0);

  const rowLong = (l) => `<tr class="${l.layer <= built ? 'row-built' : ''}">
      <td>第 ${esc(l.layer)} 笔${l.layer <= built ? ' <span class="badge badge-ok">已建</span>' : ''}</td>
      <td class="ra mono">${money(l.notional)}</td>
      <td class="ra mono">${money(l.margin)}</td>
      <td class="ra mono up">${money(l.entryPrice, 2)}</td>
      <td class="ra mono">${money(l.avgEntry, 2)}</td>
      <td class="ra mono up">${money(l.tpPrice, 2)}</td>
      <td class="ra mono down">${money(l.stopPrice, 2)}</td></tr>`;

  const headLong = `<thead><tr><th>第几笔</th><th class="ra">这笔名义</th><th class="ra">保证金</th>
      <th class="ra">价格跌到这里才加(多)</th><th class="ra">加完后的多单均价</th>
      <th class="ra">加完后的多单止盈</th><th class="ra">加完后的多单止损</th></tr></thead>`;

  if (!hasShort) {
    return `<div class="hint">价格只有真的走到「触发价」才会加这一笔，不是现在就全部建好；第一行就是现在建的那一笔。</div>
      <div class="table-wrap"><table class="table">${headLong}<tbody>${layers.map(rowLong).join('')}</tbody></table></div>`;
  }

  const rowDual = (l, side) => {
    const isLong = side === 'long';
    const trig = isLong ? l.entryPrice : l.shortEntryPrice;
    const avg = isLong ? l.avgEntry : l.avgEntryShort;
    const tp = isLong ? l.tpPrice : (l.shortTpPrice != null ? l.shortTpPrice : l.tpPriceShort);
    const stp = isLong ? l.stopPrice : l.stopPriceShort;
    return `<tr class="${l.layer <= built ? 'row-built' : ''}">
      <td>第 ${esc(l.layer)} 笔${l.layer <= built ? ' <span class="badge badge-ok">已建</span>' : ''}</td>
      <td class="ra mono">${money(l.notional)}</td>
      <td class="ra mono">${money(l.margin)}</td>
      <td class="ra mono ${isLong ? 'up' : 'down'}">${money(trig, 2)}</td>
      <td class="ra mono">${money(avg, 2)}</td>
      <td class="ra mono up">${money(tp, 2)}</td>
      <td class="ra mono down">${money(stp, 2)}</td></tr>`;
  };

  const head = (title, side) => `<thead><tr><th colspan="7" class="tbl-title">${esc(title)}</th></tr>
    <tr><th>第几笔</th><th class="ra">这笔名义</th><th class="ra">保证金</th>
    <th class="ra">${side === 'long' ? '价格跌到这里才加' : '价格涨到这里才加'}</th>
    <th class="ra">加完后的${side === 'long' ? '多' : '空'}单均价</th>
    <th class="ra">加完后的止盈</th><th class="ra">加完后的止损</th></tr></thead>`;

  const hint = '<div class="hint">价格只有真的走到「触发价」才会加这一笔，不是现在就全部建好；第 1 笔就是现在建的那一笔。</div>';
  const longTable = hasLong
    ? `<div class="table-wrap"><table class="table">${head('做多这边（跌了加仓、均价被摊低）', 'long')}<tbody>${layers.map((l) => rowDual(l, 'long')).join('')}</tbody></table></div>`
    : '';
  const shortTable = hasShort
    ? `<div class="table-wrap"><table class="table">${head('做空这边（涨了加仓、均价被摊高）', 'short')}<tbody>${layers.map((l) => rowDual(l, 'short')).join('')}</tbody></table></div>`
    : '';
  return hint + longTable + shortTable;
}

/* ---------- 机器人详情 ---------- */
async function viewRobot(id, seq) {
  if (!id) { app.innerHTML = `<div class="page">${errorBox('缺少机器人 ID')}</div>`; return; }
  app.innerHTML = `<div class="page">
    <div class="page-head"><div class="head-left">
      <a class="back" href="#/robots" title="返回">←</a><h1 id="rName">机器人详情</h1>
      <span id="rBadges"></span></div>
      <div class="head-actions" id="rActions"></div></div>
    <div class="kpis" id="rKpis">${loading('加载中…')}</div>
    <div class="card plan-card"><div class="card-head"><h2>计划预览</h2><span class="muted" id="rCapital"></span></div>
      <div class="muted" id="rPlanMeta" style="margin:-4px 0 8px"></div>
      <div id="rPlan">${loading('加载中…')}</div>
      <div id="rLayers" style="margin-top:12px"></div></div>
    <div class="card">
      <div class="tabs"><button class="tab active" data-tab="events" type="button">事件日志</button>
        <button class="tab" data-tab="orders" type="button">订单流水</button></div>
      <div id="rTabBody" class="log-wrap">${loading('加载中…')}</div></div>
    <div class="card"><div class="card-head"><h2>参数编辑</h2><span class="muted">修改后实时预览，保存后生效</span></div>
      <div id="rEditParams">${loading('加载中…')}</div>
      <div class="preview" id="rEditPreview">调整参数后可预览新计划</div>
      <div class="form-actions"><button class="btn btn-primary" id="rSave" type="button" disabled>保存参数</button>
        <button class="btn btn-ghost" id="rRevert" type="button" disabled>还原</button></div></div>
  </div>`;
  const meta = await getMeta().catch(() => null);
  const schema = (meta && meta.params && meta.params.schema) || [];
  let current = null, tab = 'events', dirtyParams = null;

  function renderHeader(d) {
    const r = d.robot || {}, st = d.state || {}, plan = d.plan || {};
    // 持仓来源有两套：
    //   模拟盘 → st.positions（每一笔一个元素，元素个数就是层数）
    //   实盘   → st.liveLegs（机器人自己的账本，元素个数才是层数；
    //            st.positions 是交易所聚合后的持仓，一个方向只有一条，不能用来数层数）
    const live = st.liveLegs;
    const useLive = live && (Array.isArray(live.long) || Array.isArray(live.short));
    const pos = st.positions || {};
    const src = useLive ? live : pos;
    const builtLong = Array.isArray(src.long) ? src.long.length : 0;
    const builtShort = Array.isArray(src.short) ? src.short.length : 0;
    const built = Math.max(builtLong, builtShort);
    d.builtLayers = built;
    const posCount = (Array.isArray(pos.long) ? pos.long.length : 0)
      + (Array.isArray(pos.short) ? pos.short.length : 0);
    el('rName').textContent = r.name || '机器人';
    const badges = `${modeBadge(r.mode)}${statusBadge(r.status)}<span class="badge">${esc(r.symbol || '—')}</span>`;
    if (el('rBadges').innerHTML !== badges) el('rBadges').innerHTML = badges;
    patchKpis(el('rKpis'), [
      { label: '当前权益', value: money(st.equity), sub: 'USDT' },
      { label: '浮动盈亏', value: signed(st.unrealizedPnl), cls: signCls(st.unrealizedPnl), sub: '持仓 ' + posCount + ' 笔' },
      { label: '已实现盈亏', value: signed(st.realizedPnl), cls: signCls(st.realizedPnl), sub: '订单 ' + num((r.stats || {}).orders, 0) },
      { label: '已建仓笔数 / 上限', value: built + ' / ' + layerCount(plan),
        sub: '多 ' + builtLong + ' 笔 · 空 ' + builtShort + ' 笔' + (r.lastTick ? ' · ' + ago(r.lastTick) + '更新' : '') },
    ]);
    setText(el('rPlanMeta'), r.lastError ? '⚠ ' + String(r.lastError).slice(0, 80) : (plan.feasible === false ? '计划不可行' : '按当前参数生成'));
    // 分配资金 / 当前资金基数 / 已占用保证金：放在计划卡标题右侧的补一行
    let capitalLine = '分配资金 ' + money((r.params || {}).allocatedCapital) + ' U'
      + ' ｜ 当前资金基数 ' + money((r.stats || {}).capital) + ' U（含本机器人已赚 '
      + signed((r.stats || {}).realizedPnl) + ' U）'
      + ' ｜ 已占用 ' + money(plan.marginTotal) + ' U';
    // 实盘：如果机器人正在接管交易所已有仓位，把接管数量与止盈价显示出来，避免用户忘了
    const tk = st.takeover || {};
    for (const sd of ['long', 'short']) {
      const t = tk[sd];
      if (!t || !(Number(t.qty) > 0)) continue;
      capitalLine += ' ｜ 正接管' + (sd === 'long' ? '多' : '空') + '单 ' + num(t.qty, 6) + ' 张'
        + '（实际均价 ' + money(t.entryPrice, 6) + '，到止盈价一次性全平）';
    }
    patchText(app, '#rCapital', capitalLine);
    if (!dirtyParams) {
      setHTML(el('rPlan'), previewHtml(d));
      setHTML(el('rLayers'), layersTable(d));
    }
    // 动作按钮只建一次，之后只切 disabled，避免轮询时把按钮点掉
    const acts = el('rActions');
    if (!acts.dataset.built) {
      acts.dataset.built = '1';
      acts.innerHTML = `<button class="btn btn-sm" data-act="start" type="button">启动</button>
        <button class="btn btn-sm" data-act="stop" type="button">停止</button>
        <button class="btn btn-sm btn-ghost" data-act="reset" type="button">重置</button>
        <button class="btn btn-sm btn-danger" data-act="delete" type="button">删除</button>`;
      qsa('button[data-act]', acts).forEach((btn) => btn.addEventListener('click', () => robotAction(btn, r.id)));
    }
    const running = r.status === 'running';
    qsa('button[data-act]', acts).forEach((btn) => {
      const a = btn.dataset.act;
      const dis = a === 'start' ? running : (a === 'stop' ? !running : false);
      if (!btn.dataset.busy && btn.disabled !== dis) btn.disabled = dis;
    });
  }
  async function robotAction(btn, rid) {
    const act = btn.dataset.act;
    if (act === 'stop') { askStop(rid, () => loadDetail(seq)); return; }
    btn.disabled = true;
    btn.dataset.busy = '1';
    try {
      if (act === 'start') await apiPost(`/api/robots/${encodeURIComponent(rid)}/start`);
      else if (act === 'reset') { if (!confirm('确认重置机器人？')) { btn.disabled = false; return; } await apiPost(`/api/robots/${encodeURIComponent(rid)}/reset`); }
      else if (act === 'delete') {
        if (!confirm('确认删除该机器人？该操作不可恢复。')) { btn.disabled = false; return; }
        await apiDel(`/api/robots/${encodeURIComponent(rid)}`);
        toast('已删除', 'ok'); goto('#/robots'); return;
      }
      toast('操作成功', 'ok');
      await loadDetail(seq);
    } catch (e) { btn.disabled = false; }
    finally { delete btn.dataset.busy; }
  }
  /* 事件/订单列表：骨架只建一次，之后只差量补节点，滚动位置由 patchKeyed 保持 */
  function renderTab(d) {
    const body = el('rTabBody');
    const list = (tab === 'events' ? (d.events || []) : (d.orders || [])).slice(0, 200);
    const sk = list.length ? tab : 'empty:' + tab;
    if (body.dataset.sk !== sk) {
      body.dataset.sk = sk;
      if (!list.length) {
        body.innerHTML = tab === 'events'
          ? empty('暂无事件', '机器人有动作后这里会记录')
          : empty('暂无订单', '还没有成交记录');
        return;
      }
      if (tab === 'events') body.innerHTML = `<ul class="events" data-list></ul>`;
      else body.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>
        <th>时间</th><th>方向</th><th>类型</th><th class="ra">数量</th><th class="ra">均价</th>
        <th class="ra">手续费</th><th class="ra">平仓盈亏</th><th>状态</th><th>原因</th></tr></thead>
        <tbody data-list></tbody></table></div>`;
    }
    const holder = body.querySelector('[data-list]');
    if (!holder || !list.length) return;
    if (tab === 'events') {
      patchKeyed(holder, list, (e) => String(e.ts) + '|' + String(e.message),
        (e) => {
          const lv = ['warn', 'error', 'info'].includes(e.level) ? e.level : 'info';
          const li = document.createElement('li');
          li.className = 'ev ev-' + lv;
          li.dataset.key = String(e.ts) + '|' + String(e.message);
          li.innerHTML = `<span class="ev-dot"></span><div><p></p><span class="muted"></span></div>`;
          li.querySelector('p').textContent = e.message == null ? '—' : String(e.message);
          li.querySelector('span.muted').textContent = fmtTime(e.ts);
          return li;
        });
    } else {
      patchKeyed(holder, list, (o) => String(o.id != null ? o.id : o.createdAt + '|' + o.side + '|' + o.qty),
        (o) => {
          const pnl = Number(o.realizedPnl) || 0;
          const tr = document.createElement('tr');
          tr.dataset.key = String(o.id != null ? o.id : o.createdAt + '|' + o.side + '|' + o.qty);
          const buy = o.side === 'BUY' || o.side === 'buy';
          tr.innerHTML = `<td class="muted"></td><td class="${buy ? 'up' : 'down'}"></td><td></td>
            <td class="ra mono"></td><td class="ra mono"></td><td class="ra mono muted"></td>
            <td class="ra mono ${!pnl ? 'muted' : (pnl > 0 ? 'up' : 'down')}"></td><td></td><td class="muted wrap"></td>`;
          const td = tr.children;
          td[0].textContent = fmtTime(o.createdAt);
          td[1].textContent = (o.side || '—') + (o.reduceOnly ? ' (只减)' : '');
          td[2].textContent = o.type || '—';
          td[3].textContent = num(o.qty, 4);
          td[4].textContent = money(o.avgPrice || o.price, 2);
          td[5].textContent = num(o.fee, 4);
          td[6].textContent = pnl ? signed(pnl) : '—';
          td[7].textContent = o.status || '—';
          td[8].textContent = o.reason || '—';
          return tr;
        });
    }
  }
  function mountEditor(d) {
    const container = el('rEditParams');
    if (!schema.length) { container.innerHTML = empty('参数元数据不可用', '无法编辑参数'); return; }
    container.innerHTML = renderSchemaForm(schema, (d.robot && d.robot.params) || {});
    const onInput = debounce(async () => {
      const params = collectForm(container, schema);
      dirtyParams = params;
      try {
        // 编辑已持仓的机器人时沿用当前锚点，否则预览里的触发价会跟着实时价跳（用户问题 #7）
        const stNow = d.state || {};
        const stStats = (d.robot && d.robot.stats) || {};
        const pv = await apiPost('/api/robots/preview', {
          symbol: d.robot.symbol,
          mode: d.robot.mode,
          params,
          anchorPrice: Number(stNow.anchorPrice) || Number((stNow.plan || {}).anchorPrice) || 0,
          // 机器人自己已赚到的钱已并入资金基数，预览必须跟实际运行一致
          realizedPnl: Number(stStats.realizedPnl) || 0,
        });
        el('rEditPreview').innerHTML = previewHtml(pv);
        el('rSave').disabled = false; el('rRevert').disabled = false;
      } catch (e) { el('rEditPreview').innerHTML = `<span class="muted">预览失败：${esc(e.message)}</span>`; }
    }, 400);
    container.addEventListener('input', onInput);
    container.addEventListener('change', onInput);
  }
  async function loadDetail(s2, opt = {}) {
    let d;
    try { d = await apiGet('/api/robots/' + encodeURIComponent(id)); }
    catch (e) {
      if (!alive(s2)) return;
      app.innerHTML = `<div class="page"><div class="page-head"><div class="head-left"><a class="back" href="#/robots">←</a><h1>机器人详情</h1></div></div>${errorBox('加载失败', e.message)}</div>`;
      stopPoll(); return;
    }
    if (!alive(s2)) return;
    current = d;
    renderHeader(d);
    renderTab(d);
    if (!opt.keepEditor) mountEditor(d);
  }
  qsa('.tabs .tab', app).forEach((t) => t.addEventListener('click', () => {
    tab = t.dataset.tab;
    qsa('.tabs .tab', app).forEach((x) => x.classList.toggle('active', x === t));
    if (current) renderTab(current);
  }));
  el('rSave').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    if (!dirtyParams) return;
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      await apiPatch('/api/robots/' + encodeURIComponent(id), { params: dirtyParams });
      toast('参数已保存', 'ok');
      dirtyParams = null;
      el('rRevert').disabled = true;
      await loadDetail(seq);
    } catch (e) { btn.disabled = false; }
    btn.textContent = '保存参数';
  });
  el('rRevert').addEventListener('click', async () => {
    dirtyParams = null; el('rRevert').disabled = true; el('rSave').disabled = true;
    el('rEditPreview').textContent = '调整参数后可预览新计划';
    await loadDetail(seq);
  });
  await loadDetail(seq);
  poll(seq, () => guarded(() => loadDetail(seq, { keepEditor: true })));
}

/* ---------- 账户 ---------- */
let accMode = 'paper';
async function viewAccount(param, seq) {
  const saved = sessionStorage.getItem('accMode');
  if (saved === 'paper' || saved === 'live') accMode = saved;
  app.innerHTML = `<div class="page">
    <div class="page-head"><div class="head-left"><h1>账户</h1><span class="muted" id="accUpdated"></span></div>
      <div class="head-actions"><button class="btn btn-sm" id="accSetBalance" type="button"${accMode === 'live' ? ' style="display:none"' : ''}>设置模拟余额</button>
        <div class="seg" id="accSeg">
        <button class="seg-btn" data-mode="paper" type="button">模拟盘</button>
        <button class="seg-btn" data-mode="live" type="button">实盘</button>
      </div></div></div>
    <div id="accWarn"></div>
    <div class="kpis" id="accKpis">${loading('加载中…')}</div>
    <div class="card"><div class="card-head"><h2>持仓</h2><span class="muted" id="accPosCount"></span></div>
      <div id="accPos">${loading('加载中…')}</div></div></div>`;
  const segBtns = qsa('#accSeg .seg-btn', app);
  const syncSeg = () => segBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === accMode));
  syncSeg();
  // 只有模拟盘才显示「设置模拟余额」，实盘模式下这个按钮没有意义
  const syncBalanceBtn = () => {
    const btn = el('accSetBalance');
    if (btn) btn.style.display = accMode === 'live' ? 'none' : '';
  };
  syncBalanceBtn();
  segBtns.forEach((b) => b.addEventListener('click', () => {
    accMode = b.dataset.mode; sessionStorage.setItem('accMode', accMode);
    syncSeg(); syncBalanceBtn(); load(seq);
  }));
  el('accSetBalance').addEventListener('click', () => openPaperBalance(seq));
  async function load(s2) {
    const kpisEl = el('accKpis'), posEl = el('accPos'), warnEl = el('accWarn');
    let d;
    try { d = await apiGet('/api/account/overview?mode=' + encodeURIComponent(accMode)); }
    catch (e) {
      if (!alive(s2)) return;
      if (kpisEl.dataset.err !== '1') { kpisEl.dataset.err = '1'; setHTML(kpisEl, errorBox('账户数据加载失败', e.message)); }
      setHTML(posEl, empty('暂无持仓'));
      setHTML(warnEl, `<div class="banner banner-warn">账户数据获取失败，已降级显示。${esc(e.message || '')}</div>`);
      return;
    }
    if (!alive(s2)) return;
    kpisEl.dataset.err = '';
    syncBalanceBtn();
    patchText(app, '#accUpdated', '更新于 ' + fmtTime(d.updatedAt || Date.now()));
    const live = d.live || null;
    const degraded = accMode === 'live' && live && (live.configured === false || !!live.error);
    // 提示条只在内容变化时写，避免每 3 秒闪一下
    if (degraded) {
      setHTML(warnEl, `<div class="banner banner-warn">未配置 API Key 或网络不可达，已降级${live.error ? '：' + esc(live.error) : ''}${live.configured === false ? '（当前显示为空数据）' : ''}</div>`);
    } else if (warnEl.innerHTML) setHTML(warnEl, '');
    patchKpis(kpisEl, [
      { label: '账户权益', value: money(d.equity), sub: 'USDT' },
      { label: '钱包余额', value: money(d.walletBalance), sub: 'USDT' },
      { label: '可用余额', value: money(d.availableBalance), sub: 'USDT' },
      { label: '未实现盈亏', value: signed(d.unrealizedPnl), cls: signCls(d.unrealizedPnl), sub: 'USDT' },
      { label: '已实现盈亏', value: signed(d.realizedPnl), cls: signCls(d.realizedPnl), sub: 'USDT' },
      { label: '今日盈亏(含浮动)', value: signed(d.todayPnl), cls: signCls(d.todayPnl), sub: 'USDT' },
      { label: '今日已落袋', value: signed(d.todayRealizedPnl), cls: signCls(d.todayRealizedPnl), sub: 'USDT' },
    ]);
    const positions = d.positions || [];
    patchText(app, '#accPosCount', `${positions.length} 个持仓`);
    const isLive = accMode === 'live';
    if (!positions.length) {
      if (posEl.dataset.sk !== 'empty') { posEl.dataset.sk = 'empty'; posEl.innerHTML = empty('当前无持仓', '机器人开仓后将在此展示'); }
      return;
    }
    const orderErr = positions.find((p) => p.ordersError);
    const hint = isLive
      ? '实盘：止盈价 / 止损价直接读<b>币安上真实挂着的条件单</b>。币安上没挂就显示「—」，平台不会自己编一个价格。'
        + ' 数量列标「手动」的是你自己在币安开的仓，机器人只平自己开的那部分。'
      : '模拟盘：止盈价 / 止损价按<b>当前实际持仓均价</b>现算（改参数后立即变化）；价格到达止盈价时这一边整体平仓。';
    const errBanner = (isLive && orderErr)
      ? `<div class="banner banner-warn">读取币安挂单失败：${esc(String(orderErr.ordersError).slice(0, 160))}。下方的止盈/止损为参数估算值，非真实挂单。</div>`
      : '';
    const head = `<div class="hint">${hint}</div>${errBanner}
      <div class="table-wrap"><table class="table"><thead><tr>
      <th>标的</th><th>方向</th><th class="ra">数量</th><th class="ra">开仓均价</th><th class="ra">标记价</th>
      <th class="ra">止盈价</th><th class="ra">止损价</th><th class="ra">未实现盈亏</th><th class="ra">强平价</th><th class="ra">杠杆</th><th class="ra">保证金</th></tr></thead>
      <tbody data-list></tbody></table></div>`;
    const headSig = (isLive ? 'L' : 'P') + (orderErr ? 'E' : '') + '|' + String(orderErr ? orderErr.ordersError : '').slice(0, 40);
    const wrap = posEl.querySelector('.table-wrap');
    const wrapTop = wrap ? wrap.scrollTop : 0;
    if (posEl.dataset.sk !== 'rows' || posEl.dataset.head !== headSig) {
      posEl.dataset.sk = 'rows';
      posEl.dataset.head = headSig;
      posEl.innerHTML = head;
      if (wrap) wrap.scrollTop = wrapTop;
    }
    const holder = posEl.querySelector('[data-list]');
    if (!holder) return;
    const items = positions.map((p) => ({
      key: `${p.symbol}|${p.side}|${p.robotId != null ? p.robotId : (p.robotName || '')}`,
      html: posRow(p, isLive),
    }));
    const htmlByKey = new Map(items.map((it) => [it.key, it.html]));
    patchKeyed(holder, items, (it) => it.key, (it) => {
      const tr = document.createElement('tr');
      tr.dataset.key = it.key;
      tr.dataset.sig = it.html;
      tr.innerHTML = it.html;
      return tr;
    });
    // 已有行只在与上次渲染不同时替换内容，滚动位置不受影响
    qsa('tr[data-key]', holder).forEach((tr) => {
      const want = htmlByKey.get(tr.dataset.key);
      if (want != null && tr.dataset.sig !== want) { tr.dataset.sig = want; tr.innerHTML = want; }
    });
    const wrap2 = posEl.querySelector('.table-wrap');
    if (wrap2 && wrap) wrap2.scrollTop = wrapTop;
  }
  await load(seq);
  poll(seq, () => guarded(() => load(seq)));
}
/* 一行持仓的 HTML：所有后端字段都过 esc()/数字格式化 */
function posRow(p, isLive) {
  const isLong = String(p.side).toUpperCase().startsWith('LONG') || String(p.side).toUpperCase() === 'BUY' || (Number(p.qty) > 0 && !String(p.side).toUpperCase().includes('SHORT'));
  const mark = Number(p.markPrice) || 0;
  const tpOk = !mark || !(Number(p.tpPrice) > 0) || (isLong ? Number(p.tpPrice) > mark : Number(p.tpPrice) < mark);
  const stpOk = !mark || !(Number(p.stopPrice) > 0) || (isLong ? Number(p.stopPrice) < mark : Number(p.stopPrice) > mark);
  const tp = Number(p.tpPrice) > 0 ? num(p.tpPrice, 2) : '—';
  const stp = Number(p.stopPrice) > 0 ? num(p.stopPrice, 2) : '—';
  const tpTag = isLive && Number(p.tpPrice) > 0 ? (p.tpFromOrder ? '' : '<span class="tag-est">估算</span>') : '';
  const stpTag = isLive && Number(p.stopPrice) > 0 ? (p.stopFromOrder ? '' : '<span class="tag-est">估算</span>') : '';
  const tpTitle = isLive
    ? (p.tpFromOrder ? `币安真实挂单 ${p.tpCount || 1} 个` : '未在币安找到止盈单，此为按参数估算')
    : (p.tpPct ? `（均价${isLong ? '+' : '-'}${p.tpPct}%）` : '');
  const stpTitle = isLive
    ? (p.stopFromOrder ? `币安真实挂单 ${p.stopCount || 1} 个` : '未在币安找到止损单，此为按参数估算')
    : '';
  const warn = (!tpOk || !stpOk) ? '<span class="tag-warn" title="价格方向异常，可能与币安实际挂单不一致">!</span>' : '';
  return `<td><b>${esc(p.symbol)}</b>${p.robotName ? `<span class="muted" style="font-size:11px;display:block">${esc(p.robotName)}</span>` : ''}</td>
    <td class="${isLong ? 'up' : 'down'}">${esc(longLabel(p.side, p.qty))}</td>
    <td class="ra mono">${num(Math.abs(Number(p.qty)), 4)}${qtyTag(p)}</td>
    <td class="ra mono">${money(p.entryPrice, 2)}</td>
    <td class="ra mono">${money(p.markPrice, 2)}</td>
    <td class="ra mono up" title="${esc(tpTitle)}">${esc(tp)}${tpTag}${warn}</td>
    <td class="ra mono down" title="${esc(stpTitle)}">${esc(stp)}${stpTag}</td>
    <td class="ra mono ${signCls(p.unrealizedPnl)}">${signed(p.unrealizedPnl)}</td>
    <td class="ra mono down">${liqText(p.liqPrice)}</td>
    <td class="ra mono">${num(p.leverage, 0)}x</td>
    <td class="ra mono">${money(p.margin)}</td>`;
}
/* 实盘持仓里区分「机器人仓位」与「手动仓位」 */
function qtyTag(p) {
  if (!isLivePos(p)) return '';
  const own = Number(p.ownQty) || 0;
  const manual = Number(p.manualQty) || 0;
  if (!(own > 0) && manual > 0) return '<span class="tag-est" title="这笔持仓不是机器人开的，机器人不会动它">手动</span>';
  if (own > 0 && manual > 0) {
    return `<span class="tag-est" title="机器人 ${own} 张 / 手动 ${manual} 张">手动 ${num(manual, 4)}</span>`;
  }
  return '';
}
function isLivePos(p) {
  return p && (p.ownQty != null || p.manualQty != null);
}

/* 自定义模拟盘余额（账户级钱包，不是每个机器人各一份） */
async function openPaperBalance(seq) {
  let info = null;
  try { info = await apiGet('/api/account/paper/balance'); } catch (e) { info = null; }
  const books = (info && info.books) || [];
  const balance = info ? Number(info.balance || 0) : 0;
  const rowsHtml = books.length
    ? `<div class="table-wrap"><table class="table"><thead><tr>
        <th>机器人</th><th>标的</th><th>状态</th><th class="ra">多仓数量</th><th class="ra">空仓数量</th><th class="ra">层数</th></tr></thead>
        <tbody>${books.map((b) => `<tr>
          <td><b>${esc(b.name)}</b></td><td>${esc(b.symbol)}</td>
          <td>${esc(b.status === 'running' ? '运行中' : b.status === 'stopped' ? '已停止' : b.status)}</td>
          <td class="ra mono up">${num(b.longQty, 4)}</td>
          <td class="ra mono down">${num(b.shortQty, 4)}</td>
          <td class="ra mono">${num(b.layers, 0)}</td></tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">当前还没有模拟机器人。钱包余额是账户级的，即使没有机器人也可以先设置。</p>`;
  const body = `
    <div class="banner banner-info">模拟盘余额是<b>账户级的钱包</b>，相当于币安全仓账户的钱包余额，由所有模拟机器人共用；开仓时从钱包里占用保证金，平仓后把盈亏和手续费退回钱包。修改余额会重置钱包（已实现盈亏与手续费清零）；未选择「只改余额」时，所有模拟机器人会被停机并清空持仓。</div>
    <div class="field"><label for="pbAmount">模拟钱包余额（USDT）</label>
      <input id="pbAmount" type="number" min="10" step="10" value="${balance > 0 ? num(balance, 0) : 100}">
      <span class="help">当前账户钱包：${money(balance)} USDT；初始余额 ${money(info ? info.initialBalance : 0)} USDT；已实现盈亏 ${signed(info ? info.realizedPnl : 0)} USDT；手续费 ${money(info ? info.feePaid : 0)} USDT。最小 10 USDT，此为整个模拟盘的总资金。</span></div>
    <div class="field"><label for="pbKeep">处理方式</label>
      <select id="pbKeep"><option value="reset">重置钱包，并清空所有机器人的持仓（推荐）</option><option value="keep">只改钱包余额，保留机器人现有持仓</option></select>
      <span class="help">清空持仓可以避免旧仓位继续用新余额计算浮盈浮亏。</span></div>
    <div class="card" style="margin-top:12px"><div class="card-head"><h2>使用该钱包的模拟机器人（${books.length} 个）</h2></div>${rowsHtml}</div>`;
  openModal({
    title: '设置模拟盘钱包余额',
    body,
    footer: '<button class="btn btn-ghost" data-close type="button">取消</button><button class="btn btn-primary" id="pbSave" type="button">保存</button>',
    onMount: ({ mask, bodyEl, close }) => {
      // 保存按钮在 modal-foot 里，不在 body 内，所以从 mask 上查
      const saveBtn = mask.querySelector('#pbSave');
      if (saveBtn) saveBtn.addEventListener('click', async () => {
        const amount = Number(bodyEl.querySelector('#pbAmount').value);
        const keepEl = bodyEl.querySelector('#pbKeep');
        const resetRobots = !keepEl || keepEl.value !== 'keep';
        if (!isFinite(amount) || amount < 10) { toast('模拟资金不能小于 10 USDT', 'warn'); return; }
        if (amount > 10000000) { toast('模拟资金不能超过 10,000,000 USDT', 'warn'); return; }
        try {
          const r = await apiPost('/api/account/paper/balance', { amount, resetRobots });
          toast(resetRobots
            ? `模拟钱包已设为 ${money(r.balance)} USDT，${r.count} 个机器人持仓已清空`
            : `模拟钱包已设为 ${money(r.balance)} USDT（保留持仓）`, 'ok');
          close();
          route();
        } catch (e) { /* api() 已提示 */ }
      });
    },
  });
}

function longLabel(side, qty) {
  const s = String(side || '').toUpperCase();
  if (s === 'LONG' || s === 'BUY') return '多';
  if (s === 'SHORT' || s === 'SELL') return '空';
  return Number(qty) >= 0 ? '多' : '空';
}

/* ---------- API Key ---------- */
async function viewApiKeys(param, seq) {
  app.innerHTML = `<div class="page">
    <div class="page-head"><div class="head-left"><h1 id="kTitle">API Key</h1><span class="muted" id="kCount"></span></div></div>
    <div class="banner banner-info">密钥以 AES-256-GCM 加密存储，仅用于调用币安接口，页面永不回显明文</div>
    <div class="grid-2">
      <div class="card"><div class="card-head"><h2>已添加的密钥</h2><button class="btn btn-sm btn-ghost" id="kRefresh" type="button">刷新</button></div>
        <div id="kList">${loading('加载中…')}</div></div>
      <div class="card"><div class="card-head"><h2 id="kFormTitle">修改 API Key</h2></div>
        <form id="kForm" novalidate>
          <div class="field"><label for="kLabel">备注名称</label>
            <input id="kLabel" type="text" maxlength="40" placeholder="例如：主账户只读" required></div>
          <div class="field"><label for="kKey">API Key</label>
            <input id="kKey" type="password" autocomplete="off" placeholder="粘贴 API Key" required>
            <span class="help">已有 Key 时重新粘贴同一个 Key 即覆盖更新，不会重复添加</span></div>
          <div class="field"><label for="kSecret">API Secret</label>
            <input id="kSecret" type="password" autocomplete="off" placeholder="粘贴 API Secret（可稍后补填）">
            <span class="help">Secret 只显示一次，保存后仅展示打码后的 Key。币安账户接口必须用 Secret 签名，只填 Key 读不到余额；可先存 Key、之后再补 Secret。建议仅授予合约交易权限，关闭提现权限</span></div>
          <button class="btn btn-primary btn-block" type="submit" id="kSubmit">修改 API Key</button>
        </form></div>
    </div></div>`;
  const listEl = el('kList');
  let hasKey = false;
  function syncTitles() {
    const t = hasKey ? '修改 API Key' : '配置 API Key';
    setText(el('kTitle'), hasKey ? '修改 API Key' : '配置 API Key');
    setText(el('kFormTitle'), t);
    setText(el('kSubmit'), t);
    if (document.title.indexOf('API Key') >= 0) document.title = t + ' · 币安量化终端';
  }
  async function load(s2) {
    let list;
    try { list = await apiGet('/api/apikeys'); }
    catch (e) {
      if (!alive(s2)) return;
      if (listEl.dataset.sig !== 'err') { listEl.dataset.sig = 'err'; setHTML(listEl, errorBox('密钥列表加载失败', e.message)); }
      return;
    }
    if (!alive(s2)) return;
    list = list || [];
    hasKey = list.length > 0;
    syncTitles();
    patchText(app, '#kCount', `共 ${list.length} 条`);
    if (!list.length) {
      if (listEl.dataset.sig !== 'empty') {
        listEl.dataset.sig = 'empty';
        setHTML(listEl, empty('尚未配置 API Key', '配置后可在实盘模式运行机器人'));
      }
      return;
    }
    patchKeyed(listEl, list, (k) => String(k.id),
      (k) => {
        const st = String(k.status || '').toLowerCase();
        const cls = st === 'verified' || st === 'ok' || st === 'active' ? 'badge-ok'
          : st === 'incomplete' ? 'badge-warn'
            : st === 'error' || st === 'invalid' ? 'badge-err' : '';
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cssText = 'background:var(--card2);margin-bottom:10px';
        card.dataset.key = String(k.id);
        card.dataset.id = String(k.id);
        card.innerHTML = `<div class="bot-top"><b></b><span class="badge ${cls}"></span></div>
          <div class="bot-meta muted mono"></div>
          <div class="bot-meta muted"></div>
          <div class="bot-actions" style="margin-top:10px">
            <button class="btn btn-sm" data-act="verify" type="button">验证</button>
            <button class="btn btn-sm btn-ghost" data-act="edit" type="button">修改</button>
            <button class="btn btn-sm btn-danger" data-act="delete" type="button">删除</button></div>`;
        card.querySelector('.bot-top b').textContent = k.label || '未命名';
        const badge = card.querySelector('.badge');
        badge.textContent = k.status || '未验证';
        card.querySelectorAll('.bot-meta')[0].textContent = k.masked || '••••';
        const meta2 = card.querySelectorAll('.bot-meta')[1];
        meta2.textContent = '最后验证：' + ago(k.lastVerified);
        if (k.lastError) {
          const er = document.createElement('span');
          er.className = 'down';
          er.textContent = ' · ' + String(k.lastError).slice(0, 80);
          meta2.appendChild(er);
        }
        qsa('button[data-act]', card).forEach((btn) => btn.addEventListener('click', async () => {
          const act = btn.dataset.act;
          if (act === 'edit') {
            // 不预填 Key/Secret（页面无可回显的明文），只把备注带过去给用户改
            el('kLabel').value = k.label || '';
            el('kKey').value = ''; el('kSecret').value = '';
            el('kKey').focus();
            el('kForm').scrollIntoView({ block: 'center', behavior: 'smooth' });
            toast('请粘贴要更新到的 API Key 与 Secret（同一个 Key 会覆盖原记录）', 'info');
            return;
          }
          if (act === 'delete' && !confirm('确认删除该 API Key？删除后实盘将无法下单。')) return;
          btn.disabled = true;
          try {
            if (act === 'verify') {
              const r = await apiPost(`/api/apikeys/${encodeURIComponent(k.id)}/verify`);
              toast(r && r.error ? '验证失败：' + r.error : '验证通过', r && r.error ? 'err' : 'ok');
            } else {
              await apiDel(`/api/apikeys/${encodeURIComponent(k.id)}`);
              toast('已删除', 'ok');
            }
            await load(s2);
          } catch (e) { btn.disabled = false; }
        }));
        return card;
      });
  }
  el('kRefresh').addEventListener('click', () => load(seq));
  el('kForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const label = el('kLabel').value.trim(), apiKey = el('kKey').value.trim(), apiSecret = el('kSecret').value.trim();
    if (!label || !apiKey) { toast('请至少填写备注名称和 API Key', 'warn'); return; }
    if (!apiSecret) { toast('未填 Secret：Key 会先保存，但读不到余额，之后需补填', 'warn'); }
    const btn = el('kSubmit');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await apiPost('/api/apikeys', { label, apiKey, apiSecret });
      el('kForm').reset();
      toast((r && r.updated ? '已更新原密钥' : '密钥已加密保存') + (apiSecret ? '' : '，待补填 Secret'), 'ok');
      await load(seq);
    } catch (e) { /* toast 已弹 */ }
    btn.disabled = false;
    syncTitles();
  });
  await load(seq);
}

