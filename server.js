import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);
const seed = {
  "items": [
    {
      "code": "MR-001",
      "shipType": "福船",
      "scale": "1:48",
      "mastCount": 3,
      "riggingMaterial": "蜡线",
      "owner": "周宁",
      "dueDate": "2026-06-28",
      "status": "校准中",
      "tasks": [
        {
          "id": "T-1",
          "position": "前桅侧支索",
          "tension": "偏松",
          "status": "调整中",
          "logs": [
            {
              "at": "2026-06-12",
              "note": "已缩短2mm"
            }
          ]
        }
      ],
      "logs": []
    }
  ]
};
const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
const stages = ["待检查","校准中","待复核","已交付"];
const statLabels = ["待检查","校准中","待复核","已交付"];
const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  for (const item of db.items || []) ensureVersions(item);
  return db;
}
// 原子写入：先写临时文件再改名，写入失败也不会留下半条帆索任务
async function saveDb(db) {
  const tmp = dbPath + ".tmp";
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "MR-" + Date.now(); }
function findItem(db, id) { return db.items.find(x => x.id === id || x.code === id); }
// 旧数据没有单号和版本，升级后补默认值，仍可查看并校准
function ensureVersions(item) {
  if (typeof item.version !== "number") item.version = 1;
  if (typeof item.conflict !== "boolean") item.conflict = false;
  for (const t of (item.tasks || [])) {
    if (typeof t.version !== "number") t.version = 1;
    if (typeof t.reviewed !== "boolean") t.reviewed = false;
    if (typeof t.conflict !== "boolean") t.conflict = false;
    if (!t.status) t.status = "待检查";
  }
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  stats["冲突"] = 0;
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
    if (item.conflict) stats["冲突"] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  const taskCount = (item.tasks || []).length;
  const conflictCount = (item.tasks || []).filter(t => t.conflict).length;
  return { ...item, logCount, taskCount, conflictCount };
}
function fmt(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString("zh-CN"); } catch { return iso; }
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --warn-bg:#f7e9e5; --ok:#3f6b47; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; flex-wrap:wrap; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:400px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.small { padding:6px 9px; font-size:12px; }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .stat.conflict { border-color:var(--warn); } .stat.conflict strong { color:var(--warn); }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; } .pill.muted { color:var(--muted); }
    .badge { display:inline-block; border-radius:4px; padding:2px 7px; font-size:12px; font-weight:700; } .badge.conflict { background:var(--warn-bg); color:var(--warn); } .badge.ok { background:#e6efe7; color:var(--ok); }
    .task { border:1px solid var(--line); border-radius:6px; padding:8px; display:grid; gap:5px; } .task.conflict { border-color:var(--warn); background:var(--warn-bg); }
    .task .row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .banner { background:var(--warn-bg); border:1px solid var(--warn); color:var(--warn); border-radius:8px; padding:10px 14px; margin-bottom:14px; font-weight:700; }
    .outbox { font-size:13px; } .outbox .entry { border-top:1px dashed var(--line); padding:6px 0; display:grid; gap:2px; }
    .outbox .err { color:var(--warn); }
    .online-dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; } .online-dot.on { background:var(--ok); } .online-dot.off { background:var(--warn); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>古船模型帆索校准</h1><div class="meta">模型、帆索任务和校准记录串联 · 断网可先录单，联网后按单号合并</div></div>
    <div style="display:flex;gap:10px;align-items:center;">
      <span class="meta"><span class="online-dot" id="netDot"></span><span id="netLabel">在线</span></span>
      <button id="toggleOffline" class="secondary small">模拟断网</button>
      <button id="reload" class="secondary small">刷新</button>
    </div>
  </header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存模型</button></form>
      <form id="measureForm" style="margin-top:14px"><h2>现场录入（断网可存）</h2>
        <label>选择模型</label><select name="itemId" id="measureItemSelect"></select>
        <label>现场单号</label><input name="ticketNo" placeholder="如 XC-2026-0012">
        <label>索具位置</label><input name="position" placeholder="如 前桅侧支索">
        <label>松紧状态</label><input name="tension" placeholder="如 偏松 / 偏紧 / 正常">
        <label>测量时间</label><input name="measuredAt" type="datetime-local">
        <label>备注</label><input name="note" placeholder="选填">
        <button>提交录入</button>
      </form>
      <div class="panel outbox" style="margin-top:14px"><h2>待传批次 <span class="pill" id="outboxCount">0</span></h2><div id="outboxList" class="meta">暂无待传记录</div><div style="margin-top:8px;display:flex;gap:8px;"><button id="syncOutbox" class="small">重传全部</button><button id="clearOutbox" class="secondary small">清空</button></div></div>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div id="conflictBanner"></div>
      <div class="panel"><h2>按单号合并帆索任务；同号重传沿用首次结果；张力变化会让复核失效并显示冲突。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待复核","已交付"];
    const OUTBOX_KEY = 'rigging-outbox-v1';
    const createForm = document.querySelector('#createForm');
    const measureForm = document.querySelector('#measureForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const measureItemSelect = document.querySelector('#measureItemSelect');
    const conflictBanner = document.querySelector('#conflictBanner');
    let items = [];
    let forcedOffline = false;

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const err = new Error(data.error || '请求失败'); err.data = data; err.status = res.status; throw err; }
      return data;
    }
    function fmt(iso) { if (!iso) return ''; try { return new Date(iso).toLocaleString('zh-CN'); } catch { return iso; } }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      const now = new Date(); now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      document.querySelector('#measureForm [name=measuredAt]').value = now.toISOString().slice(0,16);
    }
    function isOffline() { return forcedOffline || !navigator.onLine; }
    function updateNetLabel() {
      const off = isOffline();
      document.querySelector('#netDot').className = 'online-dot ' + (off ? 'off' : 'on');
      document.querySelector('#netLabel').textContent = off ? '离线（断网可先录入）' : '在线';
      document.querySelector('#toggleOffline').textContent = off ? '恢复联网' : '模拟断网';
    }
    function loadOutbox() { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; } }
    function saveOutbox(batch) { localStorage.setItem(OUTBOX_KEY, JSON.stringify(batch)); renderOutbox(); }
    function renderOutbox() {
      const batch = loadOutbox();
      document.querySelector('#outboxCount').textContent = batch.length;
      const el = document.querySelector('#outboxList');
      if (!batch.length) { el.textContent = '暂无待传记录'; return; }
      el.innerHTML = batch.map(e => '<div class="entry"><div><b>'+(e.ticketNo||'无单号')+'</b> · '+(e.position||'')+' · '+e.tension+'</div><div class="meta">'+(e.itemCode||e.itemId)+' · '+fmt(e.measuredAt)+'</div>'+(e.lastError?'<div class="err">失败：'+e.lastError+'（第'+(e.attempts||1)+'次）</div>':'')+'</div>').join('');
    }
    // 断网暂存：先把记录放进待传批次，联网后按单号合并；失败保留批次继续重试
    async function syncOutbox() {
      const batch = loadOutbox();
      if (!batch.length) return;
      const groups = {};
      for (const e of batch) (groups[e.itemId] ||= []).push(e);
      for (const [itemId, entries] of Object.entries(groups)) {
        try {
          await api('/api/items/'+encodeURIComponent(itemId)+'/measurements', { method:'POST', body: JSON.stringify({ measurements: entries.map(({ticketNo,position,tension,measuredAt,note}) => ({ticketNo,position,tension,measuredAt,note})) }) });
          const ids = new Set(entries.map(e => e.id));
          saveOutbox(loadOutbox().filter(e => !ids.has(e.id)));
        } catch (err) {
          const ob = loadOutbox();
          for (const e of ob) if (entries.some(x => x.id === e.id)) { e.attempts = (e.attempts||0)+1; e.lastError = err.message; }
          saveOutbox(ob);
        }
      }
      await load();
    }
    function render() {
      measureItemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.shipType || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      const conflictCount = items.filter(i => i.conflict).length;
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('')
        + '<div class="stat conflict"><span>冲突</span><strong>'+conflictCount+'</strong></div>';
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      conflictBanner.innerHTML = conflictCount ? '<div class="banner">有 '+conflictCount+' 个模型因张力变化导致复核结论失效，请重新复核后再交付。</div>' : '';
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+encodeURIComponent(sel.dataset.status), { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+encodeURIComponent(id)+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      document.querySelectorAll('[data-review]').forEach(btn => btn.onclick = async () => {
        const itemId = btn.dataset.item; const taskId = btn.dataset.review;
        const item = items.find(i => (i.id||i.code) === itemId);
        const task = (item.tasks||[]).find(t => t.id === taskId);
        try { await api('/api/items/'+encodeURIComponent(itemId)+'/tasks/'+encodeURIComponent(taskId)+'/review', { method:'POST', body: JSON.stringify({ version: task.version }) }); await load(); }
        catch (err) { if (err.status === 409) { alert('复核冲突：版本不一致，服务器当前为 v'+err.data.serverVersion+'，已刷新请重试'); await load(); } else alert(err.message); }
      });
      document.querySelectorAll('[data-tension]').forEach(btn => btn.onclick = async () => {
        const itemId = btn.dataset.item; const taskId = btn.dataset.tension;
        const item = items.find(i => (i.id||i.code) === itemId);
        const task = (item.tasks||[]).find(t => t.id === taskId);
        const tension = prompt('新的松紧状态（修改后复核结论将失效）', task.tension || '');
        if (tension === null) return;
        try { await api('/api/items/'+encodeURIComponent(itemId)+'/tasks/'+encodeURIComponent(taskId), { method:'PATCH', body: JSON.stringify({ version: task.version, tension }) }); await load(); }
        catch (err) { if (err.status === 409) { alert('写入冲突：版本不一致，服务器当前为 v'+err.data.serverVersion+'，后到者请刷新后重试'); await load(); } else alert(err.message); }
      });
    }
    function taskHtml(item, t) {
      const conflict = t.conflict ? '<span class="badge conflict">冲突</span>' : '';
      const reviewed = t.reviewed ? '<span class="badge ok">已复核</span>' : '';
      const ticket = t.ticketNo ? '<span class="pill">单号 '+t.ticketNo+'</span>' : '<span class="pill muted">无单号（旧数据）</span>';
      const measured = t.measuredAt ? '<span class="meta">测量 '+fmt(t.measuredAt)+'</span>' : '<span class="meta">无测量时间</span>';
      return '<div class="task'+(t.conflict?' conflict':'')+'"><div class="row"><b>'+t.position+'</b>'+ticket+reviewed+conflict+'</div>'
        + '<div class="meta">张力：'+(t.tension||'')+' · 状态：'+t.status+' · v'+(t.version||1)+'</div>'+measured
        + '<div class="row"><button class="small" data-item="'+(item.id||item.code)+'" data-review="'+t.id+'">复核</button>'
        + '<button class="small secondary" data-item="'+(item.id||item.code)+'" data-tension="'+t.id+'">调整张力</button></div></div>';
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => taskHtml(item, t)).join('') || '<div class="meta">暂无帆索任务</div>';
      const logs = (item.logs || []).slice(-5).map(l => '<div class="'+(l.step==='冲突'?'warn':'')+'">'+(l.step||'')+'：'+(l.note||'')+'</div>').join('');
      const conflictBadge = item.conflict ? '<span class="badge conflict">模型冲突</span>' : '';
      return '<article class="card'+(item.conflict?' conflict':'')+'"><h3>'+(item.code || item.id)+'</h3><div class="row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;"><span class="pill">'+item.status+'</span>'+conflictBadge+'<span class="meta">任务 '+(item.taskCount||0)+' · 冲突 '+(item.conflictCount||0)+'</span></div>'+main+tasks
        + '<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'
        + '<button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); renderForms(); await load(); };
    measureForm.onsubmit = async event => {
      event.preventDefault();
      const fd = new FormData(measureForm);
      const itemId = fd.get('itemId');
      const entry = { id: 'M-' + Date.now() + '-' + Math.random().toString(36).slice(2,6), itemId, itemCode: (items.find(i => (i.id||i.code)===itemId)||{}).code || itemId, ticketNo: (fd.get('ticketNo')||'').trim(), position: (fd.get('position')||'').trim(), tension: (fd.get('tension')||'').trim(), measuredAt: fd.get('measuredAt') ? new Date(fd.get('measuredAt')).toISOString() : new Date().toISOString(), note: (fd.get('note')||'').trim(), attempts: 0 };
      const batch = loadOutbox(); batch.push(entry); saveOutbox(batch);
      measureForm.reset(); renderForms();
      if (!isOffline()) await syncOutbox();
    };
    document.querySelector('#syncOutbox').onclick = syncOutbox;
    document.querySelector('#clearOutbox').onclick = () => { if (confirm('清空待传批次？未联网的记录将丢失。')) { saveOutbox([]); } };
    document.querySelector('#toggleOffline').onclick = () => { forcedOffline = !forcedOffline; updateNetLabel(); if (!isOffline()) syncOutbox(); };
    window.addEventListener('online', () => { updateNetLabel(); syncOutbox(); });
    window.addEventListener('offline', updateNetLabel);
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); renderOutbox(); updateNetLabel(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId(), ...input, conflict: false, version: 1, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建模型" }] };
      item.tasks = [];
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findItem(db, patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      Object.assign(item, await body(req));
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = findItem(db, log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    // 现场录入批次：按单号合并到帆索任务；同号重传沿用首次结果（幂等去重）
    const measurements = url.pathname.match(/^\/api\/items\/([^/]+)\/measurements$/);
    if (measurements && req.method === "POST") {
      const item = findItem(db, measurements[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      ensureVersions(item);
      const input = await body(req);
      const list = Array.isArray(input.measurements) ? input.measurements : [input];
      const result = { merged: 0, duplicates: 0, tasks: [] };
      for (const m of list) {
        const ticketNo = (m.ticketNo || "").trim();
        const existing = ticketNo && (item.tasks || []).find(t => t.ticketNo === ticketNo);
        if (existing) {
          result.duplicates += 1;
          result.tasks.push({ ticketNo, status: "duplicate", taskId: existing.id });
          continue;
        }
        const task = {
          id: "T-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
          ticketNo: ticketNo || undefined,
          position: (m.position || "未命名索具").trim(),
          tension: (m.tension || "").trim(),
          measuredAt: m.measuredAt || new Date().toISOString(),
          status: "待检查",
          version: 1,
          reviewed: false,
          conflict: false,
          logs: [{ at: new Date().toISOString(), note: "现场录入" + (ticketNo ? " · 单号 " + ticketNo : "（无单号）") }]
        };
        item.tasks ||= [];
        item.tasks.push(task);
        result.merged += 1;
        result.tasks.push({ ticketNo, status: "merged", taskId: task.id });
      }
      if (result.merged > 0) {
        if (item.status === "待检查") item.status = "校准中";
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: "合并", note: "按单号合并 " + result.merged + " 条帆索任务" + (result.duplicates ? "，去重 " + result.duplicates + " 条（沿用首次结果）" : "") });
      }
      await saveDb(db);
      return send(res, 200, result);
    }
    // 帆索任务更新：乐观并发控制，后到者版本不一致时看到冲突
    const taskUpdate = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)$/);
    if (taskUpdate && req.method === "PATCH") {
      const item = findItem(db, taskUpdate[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      ensureVersions(item);
      const task = (item.tasks || []).find(t => t.id === taskUpdate[2]);
      if (!task) return send(res, 404, { error: "task_not_found" });
      const input = await body(req);
      if (input.version !== undefined && Number(input.version) !== task.version) {
        return send(res, 409, { error: "conflict", message: "版本不一致，后到者看到冲突", serverVersion: task.version, clientVersion: Number(input.version), task });
      }
      const prevTension = task.tension;
      if (input.tension !== undefined) task.tension = String(input.tension).trim();
      if (input.position !== undefined) task.position = String(input.position).trim();
      if (input.note !== undefined) { task.logs ||= []; task.logs.push({ at: new Date().toISOString(), note: input.note }); }
      task.version += 1;
      // 张力变化会让复核结论失效：模型退回待复核，列表、统计和校准记录显示冲突
      if (input.tension !== undefined && task.tension !== prevTension && task.reviewed) {
        task.reviewed = false;
        task.conflict = true;
        item.conflict = true;
        item.status = "待复核";
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: "冲突", note: task.position + " 张力由「" + prevTension + "」改为「" + task.tension + "」，复核结论失效，退回待复核" });
      }
      await saveDb(db);
      return send(res, 200, { item, task });
    }
    // 复核：通过后标记已复核；张力变化会令其失效
    const review = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      const item = findItem(db, review[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      ensureVersions(item);
      const task = (item.tasks || []).find(t => t.id === review[2]);
      if (!task) return send(res, 404, { error: "task_not_found" });
      const input = await body(req);
      if (input.version !== undefined && Number(input.version) !== task.version) {
        return send(res, 409, { error: "conflict", message: "版本不一致，复核冲突", serverVersion: task.version, task });
      }
      task.reviewed = true;
      task.conflict = false;
      task.status = "已复核";
      task.version += 1;
      task.logs ||= [];
      task.logs.push({ at: new Date().toISOString(), note: "复核通过" + (input.note ? "：" + input.note : "") });
      if ((item.tasks || []).length && item.tasks.every(t => t.reviewed)) item.status = "待复核";
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "复核", note: task.position + " 复核通过" });
      await saveDb(db);
      return send(res, 200, { item, task });
    }
    // 冲突解决：重新复核后清除模型冲突标记
    const resolve = url.pathname.match(/^\/api\/items\/([^/]+)\/conflicts\/resolve$/);
    if (resolve && req.method === "POST") {
      const item = findItem(db, resolve[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      ensureVersions(item);
      item.conflict = false;
      for (const t of (item.tasks || [])) if (t.reviewed) t.conflict = false;
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "冲突", note: "冲突已解决，恢复正常" });
      await saveDb(db);
      return send(res, 200, { item });
    }
    // 快速新增帆索任务（旧路径，保留兼容）
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = findItem(db, action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      ensureVersions(item);
      const input = await body(req);
      item.logs ||= [];
      item.tasks ||= [];
      item.tasks.push({ id: "T-" + Date.now(), position: input.position, tension: input.tension, status: "待检查", version: 1, reviewed: false, conflict: false, logs: [{ at: new Date().toISOString(), note: input.note || "新增帆索任务" }] });
      item.status = "校准中";
      item.logs.push({ at: new Date().toISOString(), step: "帆索", note: input.position + " · " + input.tension });
      await saveDb(db);
      return send(res, 201, item);
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
