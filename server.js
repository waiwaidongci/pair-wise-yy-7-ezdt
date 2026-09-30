import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH
  ? resolve(process.env.DB_PATH)
  : join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);
const SCHEMA_VERSION = 2;
const seed = {
  "schemaVersion": SCHEMA_VERSION,
  "items": [
    {
      "id": "MR-001",
      "code": "MR-001",
      "shipType": "福船",
      "scale": "1:48",
      "mastCount": 3,
      "riggingMaterial": "蜡线",
      "owner": "周宁",
      "dueDate": "2026-06-28",
      "status": "校准中",
      "version": 0,
      "conflict": false,
      "mergedTickets": {},
      "tasks": [
        {
          "id": "T-1",
          "position": "前桅侧支索",
          "tension": "偏松",
          "status": "调整中",
          "ticketNo": null,
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
const tensionOptions = ["偏松","适中","偏紧"];
const statLabels = [...stages, "冲突"];
const extraFields = [["position","索具位置"],["tension","松紧状态"],["note","调整备注"]];

// ---------- 基础工具 ----------
function nowIso() { return new Date().toISOString(); }
function newId() { return "MR-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7); }
let taskSeq = 0;
function newTaskId() { return "T-" + Date.now() + "-" + (taskSeq++).toString(36); }
function fail(status, code, extra) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  error.extra = extra || {};
  return error;
}

// ---------- 存储：迁移 + 原子写入 + 串行化互斥锁 ----------
/**
 * 旧数据没有现场单号和版本号：读入时补齐默认值，
 * 已带现场单号的历史任务回填幂等索引，升级后仍可查看并继续校准。
 */
function migrate(db) {
  if (!db || typeof db !== "object" || !Array.isArray(db.items)) {
    throw fail(500, "db_corrupt");
  }
  db.schemaVersion = SCHEMA_VERSION;
  for (const item of db.items) {
    if (!item.id) item.id = item.code || newId();
    if (typeof item.version !== "number") item.version = 0;
    if (!item.mergedTickets || typeof item.mergedTickets !== "object") item.mergedTickets = {};
    for (const task of item.tasks || []) {
      if (task.ticketNo && !item.mergedTickets[task.ticketNo]) {
        item.mergedTickets[task.ticketNo] = {
          taskId: task.id,
          measuredAt: task.measuredAt || null,
          mergedAt: task.mergedAt || null,
          batchId: null
        };
      }
      if (task.ticketNo === undefined) task.ticketNo = null;
    }
    if (typeof item.conflict !== "boolean") item.conflict = false;
    if (!Array.isArray(item.logs)) item.logs = [];
    if (!Array.isArray(item.tasks)) item.tasks = [];
  }
  return db;
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return migrate(JSON.parse(JSON.stringify(seed)));
  }
  return migrate(JSON.parse(await readFile(dbPath, "utf8")));
}

/** 先写临时文件再 rename：要么整批落盘，要么完全不动，绝不留下半条帆索任务。 */
async function saveDb(db) {
  const tmp = `${dbPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}

// Node 单线程但存在 await 交错，用 Promise 链把“读最新版本→校验→写盘”串成临界区。
let chain = Promise.resolve();
function withLock(task) {
  const run = chain.then(() => task());
  chain = run.then(() => {}, () => {});
  return run;
}
async function mutate(fn) {
  return withLock(async () => {
    const db = await loadDb();
    const result = await fn(db);
    await saveDb(db);
    return result;
  });
}

// ---------- 领域逻辑（纯函数，便于测试） ----------
function findItem(db, idOrCode) {
  return db.items.find(x => x.id === idOrCode || x.code === idOrCode) || null;
}

/** 乐观锁：两台终端同时提交同一任务，先到者成为当前版本，后到者得到 409 冲突。 */
function checkVersion(item, expectedVersion) {
  if (expectedVersion !== undefined && expectedVersion !== null &&
      Number(expectedVersion) !== item.version) {
    throw fail(409, "version_conflict", {
      currentVersion: item.version,
      currentStatus: item.status,
      conflict: item.conflict
    });
  }
}

function snapshotTensions(item) {
  const byId = {};
  const byPosition = {};
  for (const t of item.tasks || []) {
    byId[t.id] = t.tension;
    if (t.position) byPosition[t.position] = t.tension;
  }
  return { byId, byPosition };
}

/** 张力变化让复核结论失效：模型退回待复核，并在列表、统计、校准记录中显示冲突。 */
function markTensionConflict(item, reasons) {
  if (item.review) item.review.invalid = true;
  item.conflict = true;
  item.status = "待复核";
  item.logs.push({
    at: nowIso(),
    step: "冲突",
    type: "conflict",
    note: `索具张力变化（${reasons.join("；")}），原复核结论失效，退回待复核`
  });
}

function detectConflictForNewTasks(item, newTasks) {
  if (!item.review || item.review.invalid || !newTasks.length) return;
  const snapshot = item.review.tensions;
  const reasons = [];
  for (const t of newTasks) {
    const oldByTask = snapshot?.byId?.[t.id];
    const oldByPosition = t.position ? snapshot?.byPosition?.[t.position] : undefined;
    const old = oldByTask !== undefined ? oldByTask : oldByPosition;
    if (old !== undefined && old !== t.tension) {
      reasons.push(`${t.position || t.id}：${old}→${t.tension}`);
    }
  }
  if (reasons.length) markTensionConflict(item, reasons);
}

function detectConflictForChangedTask(item, task, oldTension) {
  if (!item.review || item.review.invalid) return;
  const old = item.review.tensions?.byId?.[task.id]
    ?? (task.position ? item.review.tensions?.byPosition?.[task.position] : undefined);
  const baseline = old !== undefined ? old : oldTension;
  if (baseline !== undefined && baseline !== task.tension) {
    markTensionConflict(item, [`${task.position || task.id}：${baseline}→${task.tension}`]);
  }
}

/**
 * 断网恢复后按现场单号把整批记录合并为帆索任务。
 * - 同号重传沿用首次结果，不重复建任务；
 * - 先校验整批，任一记录不合法则整批拒绝；
 * - expectedVersion 过期则 409，调用方保留原批次继续重试。
 */
function applyBatchMerge(item, body) {
  checkVersion(item, body && body.expectedVersion);
  const records = Array.isArray(body.records) ? body.records : null;
  if (!records || records.length === 0) throw fail(400, "empty_batch");

  // 整批先校验，任何一条不合法都不动原数据
  const issues = [];
  records.forEach((r, index) => {
    if (!r || typeof r !== "object") {
      issues.push({ index, error: "记录格式错误" });
      return;
    }
    if (!String(r.ticketNo || "").trim()) issues.push({ index, field: "ticketNo", error: "现场单号缺失" });
    if (!String(r.tension || "").trim()) issues.push({ index, field: "tension", error: "索具张力缺失" });
    if (!r.measuredAt || Number.isNaN(Date.parse(r.measuredAt))) {
      issues.push({ index, field: "measuredAt", error: "测量时间缺失或无法识别" });
    }
  });
  if (issues.length) throw fail(400, "invalid_batch", { issues });

  const created = [];
  const reused = [];
  const seenInBatch = new Set();
  for (const r of records) {
    const ticketNo = String(r.ticketNo).trim();
    if (seenInBatch.has(ticketNo)) {
      reused.push({ ticketNo, reason: "duplicate_in_batch" });
      continue;
    }
    const known = item.mergedTickets[ticketNo];
    if (known) {
      seenInBatch.add(ticketNo);
      reused.push({ ticketNo, taskId: known.taskId, deduplicated: true });
      continue;
    }
    const at = nowIso();
    const task = {
      id: newTaskId(),
      position: String(r.position || "").trim(),
      tension: String(r.tension).trim(),
      status: "待检查",
      ticketNo,
      measuredAt: r.measuredAt,
      mergedAt: at,
      logs: [{ at, type: "merge", note: `现场单 ${ticketNo} 合并${r.note ? `：${r.note}` : ""}` }]
    };
    item.tasks.push(task);
    item.mergedTickets[ticketNo] = {
      taskId: task.id,
      measuredAt: task.measuredAt,
      mergedAt: at,
      batchId: body.batchId ? String(body.batchId) : null
    };
    seenInBatch.add(ticketNo);
    created.push(task);
    item.logs.push({
      at,
      step: "合并",
      type: "merge",
      note: `现场单 ${ticketNo} → ${task.position || "未命名索具"} · ${task.tension}（测量于 ${task.measuredAt}）`
    });
  }

  let changed = created.length > 0;
  if (created.length) {
    // 新校准数据到达：未开始的进入校准中；待复核（且本次未触发新冲突）退回校准中
    if (item.status === "待检查" || (item.status === "待复核" && !item.conflict)) item.status = "校准中";
    detectConflictForNewTasks(item, created);
  }
  if (changed) item.version += 1;
  return { version: item.version, conflict: item.conflict, created, reused, changed };
}

function updateTask(item, taskId, patch) {
  checkVersion(item, patch && patch.expectedVersion);
  const task = (item.tasks || []).find(t => t.id === taskId);
  if (!task) throw fail(404, "task_not_found");
  const oldTension = task.tension;
  const at = nowIso();
  if (patch.tension !== undefined && String(patch.tension).trim() && patch.tension !== task.tension) {
    task.tension = String(patch.tension).trim();
    task.logs.push({ at, type: "tension", note: `张力调整：${oldTension}→${task.tension}${patch.note ? `（${patch.note}）` : ""}` });
  }
  if (patch.status !== undefined && patch.status !== task.status) {
    task.status = String(patch.status);
    task.logs.push({ at, note: `任务状态更新为 ${task.status}` });
  }
  if (task.tension !== oldTension) detectConflictForChangedTask(item, task, oldTension);
  item.logs.push({ at, step: "帆索", type: "task", note: `${task.position || task.id} · ${task.tension}${task.ticketNo ? ` · 现场单 ${task.ticketNo}` : ""}` });
  item.version += 1;
  return task;
}

function submitReview(item, body) {
  checkVersion(item, body && body.expectedVersion);
  const conclusion = body.conclusion === "通过" || body.conclusion === "不通过" ? body.conclusion : null;
  if (!conclusion) throw fail(400, "bad_conclusion");
  const at = nowIso();
  item.review = {
    conclusion,
    at,
    note: body.note ? String(body.note) : "",
    tensions: snapshotTensions(item),
    invalid: false
  };
  item.conflict = false;
  item.status = conclusion === "通过" ? "已交付" : "校准中";
  item.logs.push({
    at,
    step: "复核",
    type: "review",
    note: `复核结论：${conclusion}${body.note ? `（${body.note}）` : ""}`
  });
  item.version += 1;
  return item.review;
}

function updateStatus(item, patch) {
  checkVersion(item, patch && patch.expectedVersion);
  if (!stages.includes(patch.status)) throw fail(400, "bad_status");
  if (patch.status === item.status) return item;
  item.status = patch.status;
  item.logs.push({ at: nowIso(), step: "状态", type: "status", note: `状态更新为 ${item.status}` });
  item.version += 1;
  return item;
}

function appendLog(item, body) {
  checkVersion(item, body && body.expectedVersion);
  item.logs.push({ at: nowIso(), step: body.step || "备注", type: body.type || "note", note: body.note || "" });
  item.version += 1;
  return item;
}

function computeStats(items) {
  const stats = Object.fromEntries(stages.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  stats["冲突"] = items.filter(i => i.conflict).length;
  return stats;
}

function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return {
    ...item,
    logCount,
    review: item.review || null
  };
}

// ---------- HTTP ----------
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

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古船模型帆索校准</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat,.pending { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.small { padding:5px 9px; font-size:12px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .stat.conflict strong { color:var(--warn); }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.conflict { background:#f7e7e2; border-color:var(--warn); color:var(--warn); font-weight:700; }
    .task { border:1px solid var(--line); border-radius:6px; padding:8px; display:grid; gap:6px; } .task .row { display:flex; gap:6px; align-items:center; } .task select { padding:5px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:120px; overflow:auto; display:grid; gap:3px; } .warn,.log-conflict { color:var(--warn); font-weight:700; }
    .log-merge { color:#3f5a33; }
    .pending { margin-bottom:14px; border-color:#b59c4a; background:#fdf9ec; display:grid; gap:8px; }
    .pending ul { margin:0; padding-left:18px; } .pending .err { color:var(--warn); font-weight:700; }
    .reviewline { font-size:13px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古船模型帆索校准</h1><div class="meta">断网采集 · 按现场单号幂等合并 · 版本冲突可见 · 张力变化退回待复核</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增模型</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><p class="meta">保存后即获得版本号 v0。</p><button>保存模型</button></form>
      <form id="captureForm" style="margin-top:14px">
        <h2>断网采集</h2>
        <label>选择模型</label><select name="id" id="itemSelect"></select>
        <div id="captureFields"></div>
        <p class="meta">只记索具张力、测量时间和现场单号，暂存在本机；网络恢复后按单号合并，同号重传沿用首次结果。</p>
        <button type="button" id="stageBtn">暂存到待合并批次</button>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div id="pendingZone"></div>
      <div class="panel"><h2>帆索任务与校准记录</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","模型编号","text"],["shipType","船型","text"],["scale","比例","text"],["mastCount","桅杆数量","number"],["riggingMaterial","帆索材料","text"],["owner","负责人","text"],["dueDate","交付日期","date"]];
    const stages = ["待检查","校准中","待复核","已交付"];
    const tensionOptions = ${JSON.stringify(tensionOptions)};
    const PENDING_KEY = "rigging-pending-batches-v1";
    const createForm = document.querySelector('#createForm');
    const captureForm = document.querySelector('#captureForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const pendingZone = document.querySelector('#pendingZone');
    let items = [];

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || '请求失败');
        err.status = res.status; err.data = data;
        if (res.status === 409) {
          alert('版本冲突：该任务已被另一台终端提交，当前接受的是先到版本（v' + (data.currentVersion ?? '?') + '），请刷新后基于最新版本重试。');
          load();
        }
        throw err;
      }
      return data;
    }

    function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
    function nowLocal() {
      const d = new Date();
      return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,16);
    }

    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#captureFields').innerHTML =
        '<label>索具位置</label><input name="position" placeholder="如 前桅侧支索">' +
        '<label>索具张力</label><select name="tension">' + tensionOptions.map(t => '<option>'+t+'</option>').join('') + '</select>' +
        '<label>测量时间</label><input name="measuredAt" type="datetime-local" step="1" required>' +
        '<label>现场单号</label><input name="ticketNo" placeholder="如 RC-20260930-01" required>' +
        '<label>备注（可选）</label><input name="note">';
      captureForm.elements.measuredAt.value = nowLocal();
    }

    // ---------- 断网暂存批次（localStorage） ----------
    function loadPending() {
      try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || {}; } catch { return {}; }
    }
    function savePending(map) { localStorage.setItem(PENDING_KEY, JSON.stringify(map)); }

    function renderPending() {
      const map = loadPending();
      const blocks = Object.entries(map).filter(([,b]) => b.records.length);
      if (!blocks.length) { pendingZone.innerHTML = ''; return; }
      pendingZone.innerHTML = blocks.map(([modelId, batch]) => {
        const item = items.find(i => i.id === modelId);
        return '<div class="pending"><strong>待合并批次 · ' + esc(item ? (item.code || item.id) : modelId) + ' · '
          + batch.records.length + ' 条（批次号 ' + esc(batch.batchId) + '）</strong>'
          + '<ul>' + batch.records.map(r => '<li>现场单 <b>'+esc(r.ticketNo)+'</b> · '+esc(r.position||'未命名索具')+' · '+esc(r.tension)+' · 测量于 '+esc(r.measuredAt)+'</li>').join('') + '</ul>'
          + '<div class="meta">断网或写入失败时批次原样保留，可继续重试；服务端按现场单号去重，不会留下半条帆索任务。</div>'
          + '<div class="row"><button class="small" data-merge="'+esc(modelId)+'">网络已恢复 · 按单号合并</button> <span class="err" data-err="'+esc(modelId)+'"></span></div></div>';
      }).join('');
      pendingZone.querySelectorAll('[data-merge]').forEach(btn => btn.onclick = () => mergeBatch(btn.dataset.merge));
    }

    document.querySelector('#stageBtn').onclick = () => {
      const modelId = itemSelect.value;
      if (!modelId) return alert('请先选择模型');
      const f = captureForm.elements;
      if (!f.ticketNo.value.trim() || !f.measuredAt.value) return alert('现场单号和测量时间必填');
      const map = loadPending();
      if (!map[modelId]) map[modelId] = { batchId: 'B-' + Date.now() + '-' + Math.random().toString(36).slice(2,6), records: [] };
      map[modelId].records.push({
        clientId: 'C-' + Date.now() + '-' + Math.random().toString(36).slice(2,6),
        ticketNo: f.ticketNo.value.trim(),
        position: f.position.value.trim(),
        tension: f.tension.value,
        measuredAt: f.measuredAt.value,
        note: f.note.value.trim()
      });
      savePending(map);
      f.ticketNo.value = ''; f.position.value = ''; f.note.value = ''; f.measuredAt.value = nowLocal();
      renderPending();
    };

    async function mergeBatch(modelId) {
      const map = loadPending();
      const batch = map[modelId];
      if (!batch) return;
      const item = items.find(i => i.id === modelId);
      const errEl = pendingZone.querySelector('[data-err="'+modelId+'"]');
      if (errEl) errEl.textContent = '';
      try {
        const result = await api('/api/items/' + encodeURIComponent(modelId) + '/merge-batch', {
          method: 'POST',
          body: JSON.stringify({ batchId: batch.batchId, expectedVersion: item ? item.version : null, records: batch.records })
        });
        // 只有整批成功（含同号沿用）才清掉本地批次；失败一律保留继续重试
        delete map[modelId];
        savePending(map);
        alert('合并完成：新建 ' + result.created.length + ' 条，同号沿用 ' + result.reused.length + ' 条' + (result.conflict ? '；检测到张力变化，已退回待复核并标记冲突。' : '。'));
        await load();
      } catch (e) {
        if (errEl) errEl.textContent = e.status === 409 ? '版本冲突，请刷新后重试（批次已保留）' : ('合并失败，批次已保留：' + e.message);
      }
    }

    // ---------- 列表 / 统计 / 校准记录 ----------
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+esc(item.id)+'">'+esc(item.code || item.id)+' · '+esc(item.shipType || '')+'</option>').join('');
      const stats = Object.fromEntries([...stages, '冲突'].map(s => [s, 0]));
      items.forEach(i => { stats[i.status] = (stats[i.status]||0) + 1; if (i.conflict) stats['冲突'] += 1; });
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) =>
        '<div class="stat'+(k==='冲突'&&v>0?' conflict':'')+'"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');

      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item =>
        (!status || item.status === status) &&
        (!q || JSON.stringify(item).includes(q)) &&
        (!q || true));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      bindCardActions();
      renderPending();
    }

    function reviewHtml(item) {
      if (!item.review) return '<div class="meta">暂无复核结论</div>';
      const r = item.review;
      return '<div class="reviewline ' + (r.invalid ? 'warn' : '') + '">复核：' + esc(r.conclusion)
        + (r.invalid ? '（已因张力变化失效）' : '（有效）') + ' · ' + esc((r.at||'').slice(0,16).replace('T',' ')) + '</div>';
    }

    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+esc(item[key])+'</div>').join('');
      const tasks = (item.tasks || []).map(t =>
        '<div class="task"><div><b>'+esc(t.position||'未命名索具')+'</b> · '+esc(t.status)+'</div>'
        + '<div class="meta">张力：'+esc(t.tension)+' · '
        + (t.ticketNo ? '现场单 '+esc(t.ticketNo)+' · 测量于 '+esc((t.measuredAt||'').slice(0,16).replace('T',' '))
                      : '历史数据（无现场单号）') + '</div>'
        + '<div class="row"><select data-tension="'+esc(t.id)+'">'
        + tensionOptions.map(o => '<option '+(o===t.tension?'selected':'')+'>'+o+'</option>').join('')
        + '</select><button class="small" data-update-item="'+esc(item.id)+'" data-update-task="'+esc(t.id)+'">更新张力</button></div></div>'
      ).join('');
      const logs = (item.logs || []).slice(-6).map(l =>
        '<div class="log-'+esc(l.type||'')+'">'+esc((l.at||'').slice(0,16).replace('T',' '))+' '+esc(l.step||'记录')+'：'+esc(l.note)+'</div>').join('');
      return '<article class="card">'
        + '<h3>'+esc(item.code || item.id)+' <span class="meta">v'+esc(item.version)+'</span></h3>'
        + '<div>'+(item.conflict ? '<span class="pill conflict">冲突 · 待复核</span>' : '<span class="pill">'+esc(item.status)+'</span>')+'</div>'
        + main + reviewHtml(item)
        + '<div>'+tasks+'</div>'
        + '<label>模型状态</label><select data-status="'+esc(item.id)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'
        + '<div class="row"><button class="secondary small" data-review="'+esc(item.id)+'" data-conclusion="通过">复核通过</button>'
        + '<button class="secondary small" data-review="'+esc(item.id)+'" data-conclusion="不通过">复核不通过</button>'
        + '<button class="secondary small" data-note="'+esc(item.id)+'">追加备注</button></div>'
        + '<div class="logs meta">'+(logs || '暂无校准记录')+'</div>'
        + '</article>';
    }

    function bindCardActions() {
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        const item = items.find(i => i.id === sel.dataset.status);
        try {
          await api('/api/items/' + encodeURIComponent(sel.dataset.status), { method:'PATCH', body: JSON.stringify({ status: sel.value, expectedVersion: item.version }) });
          await load();
        } catch (e) { if (e.status !== 409) alert(e.message); }
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => {
        const item = items.find(i => i.id === btn.dataset.note);
        const note = prompt('记录备注');
        if (note === null) return;
        try {
          await api('/api/items/' + encodeURIComponent(btn.dataset.note) + '/logs', { method:'POST', body: JSON.stringify({ step:'备注', note, expectedVersion: item.version }) });
          await load();
        } catch (e) { if (e.status !== 409) alert(e.message); }
      });
      document.querySelectorAll('[data-update-item]').forEach(btn => btn.onclick = async () => {
        const item = items.find(i => i.id === btn.dataset.updateItem);
        const tension = document.querySelector('[data-tension="'+btn.dataset.updateTask+'"]').value;
        try {
          await api('/api/items/' + encodeURIComponent(btn.dataset.updateItem) + '/tasks/' + encodeURIComponent(btn.dataset.updateTask), {
            method:'PATCH', body: JSON.stringify({ tension, expectedVersion: item.version })
          });
          await load();
        } catch (e) { if (e.status !== 409) alert(e.message); }
      });
      document.querySelectorAll('[data-review]').forEach(btn => btn.onclick = async () => {
        const item = items.find(i => i.id === btn.dataset.review);
        const note = prompt('复核备注（可空）', '') ?? '';
        try {
          await api('/api/items/' + encodeURIComponent(btn.dataset.review) + '/review', {
            method:'POST', body: JSON.stringify({ conclusion: btn.dataset.conclusion, note, expectedVersion: item.version })
          });
          await load();
        } catch (e) { if (e.status !== 409) alert(e.message); }
      });
    }

    async function load() {
      items = await api('/api/items');
      render();
    }

    createForm.onsubmit = async event => {
      event.preventDefault();
      await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) });
      createForm.reset();
      await load();
    };
    document.querySelector('#statusFilter').onchange = render;
    document.querySelector('#search').oninput = render;
    document.querySelector('#reload').onclick = load;
    renderForms();
    load();
  </script>
</body>
</html>`;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/") return html(res, page());

      if (req.method === "GET" && url.pathname === "/api/items") {
        const db = await loadDb();
        return send(res, 200, db.items.map(summarize));
      }
      if (req.method === "GET" && url.pathname === "/api/stats") {
        const db = await loadDb();
        return send(res, 200, computeStats(db.items));
      }

      if (req.method === "POST" && url.pathname === "/api/items") {
        const input = await body(req);
        const item = await mutate(db => {
          const item = {
            id: newId(),
            ...input,
            status: input.status || "待检查",
            version: 0,
            conflict: false,
            mergedTickets: {},
            review: null,
            tasks: [],
            logs: [{ at: nowIso(), step: "建档", type: "status", note: "创建模型" }]
          };
          db.items.unshift(item);
          return item;
        });
        return send(res, 201, summarize(item));
      }

      // 断网恢复后：按现场单号合并整批到帆索任务
      const merge = url.pathname.match(/^\/api\/items\/([^/]+)\/merge-batch$/);
      if (merge && req.method === "POST") {
        const input = await body(req);
        try {
          const result = await mutate(db => {
            const item = findItem(db, decodeURIComponent(merge[1]));
            if (!item) throw fail(404, "item_not_found");
            const r = applyBatchMerge(item, input);
            return { ...r, item: summarize(item) };
          });
          return send(res, 200, result);
        } catch (e) {
          if (e.status) return send(res, e.status, { error: e.code, ...e.extra });
          throw e;
        }
      }

      // 提交复核结论（带张力快照）
      const review = url.pathname.match(/^\/api\/items\/([^/]+)\/review$/);
      if (review && req.method === "POST") {
        const input = await body(req);
        try {
          const item = await mutate(db => {
            const item = findItem(db, decodeURIComponent(review[1]));
            if (!item) throw fail(404, "item_not_found");
            submitReview(item, input);
            return item;
          });
          return send(res, 200, summarize(item));
        } catch (e) {
          if (e.status) return send(res, e.status, { error: e.code, ...e.extra });
          throw e;
        }
      }

      // 单条帆索任务张力/状态更新
      const taskPatch = url.pathname.match(/^\/api\/items\/([^/]+)\/tasks\/([^/]+)$/);
      if (taskPatch && req.method === "PATCH") {
        const input = await body(req);
        try {
          const item = await mutate(db => {
            const item = findItem(db, decodeURIComponent(taskPatch[1]));
            if (!item) throw fail(404, "item_not_found");
            updateTask(item, decodeURIComponent(taskPatch[2]), input);
            return item;
          });
          return send(res, 200, summarize(item));
        } catch (e) {
          if (e.status) return send(res, e.status, { error: e.code, ...e.extra });
          throw e;
        }
      }

      const itemPatch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
      if (itemPatch && req.method === "PATCH") {
        const input = await body(req);
        try {
          const item = await mutate(db => {
            const item = findItem(db, decodeURIComponent(itemPatch[1]));
            if (!item) throw fail(404, "item_not_found");
            updateStatus(item, input);
            return item;
          });
          return send(res, 200, summarize(item));
        } catch (e) {
          if (e.status) return send(res, e.status, { error: e.code, ...e.extra });
          throw e;
        }
      }

      const logRoute = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
      if (logRoute && req.method === "POST") {
        const input = await body(req);
        try {
          const item = await mutate(db => {
            const item = findItem(db, decodeURIComponent(logRoute[1]));
            if (!item) throw fail(404, "item_not_found");
            appendLog(item, input);
            return item;
          });
          return send(res, 201, summarize(item));
        } catch (e) {
          if (e.status) return send(res, e.status, { error: e.code, ...e.extra });
          throw e;
        }
      }

      // 兼容旧版在线直接新增（无现场单号，记为历史任务）
      const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
      if (action && req.method === "POST") {
        const input = await body(req);
        try {
          const item = await mutate(db => {
            const item = findItem(db, decodeURIComponent(action[1]));
            if (!item) throw fail(404, "item_not_found");
            const at = nowIso();
            const task = {
              id: newTaskId(),
              position: input.position || "",
              tension: input.tension || "",
              status: "待检查",
              ticketNo: null,
              measuredAt: at,
              logs: [{ at, note: input.note || "在线新增帆索任务" }]
            };
            item.tasks.push(task);
            if (item.status === "待检查") item.status = "校准中";
            item.logs.push({ at, step: "帆索", type: "task", note: `${task.position} · ${task.tension}（无现场单号）` });
            detectConflictForNewTasks(item, [task]);
            item.version += 1;
            return item;
          });
          return send(res, 201, summarize(item));
        } catch (e) {
          if (e.status) return send(res, e.status, { error: e.code, ...e.extra });
          throw e;
        }
      }

      send(res, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof SyntaxError) return send(res, 400, { error: "bad_json" });
      send(res, 500, { error: error.message });
    }
  });
}

// 直接运行时才监听；被测试 import 时不占端口
const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  createServer().listen(port, () => console.log("古船模型帆索校准 listening on http://localhost:" + port));
}

export {
  migrate,
  applyBatchMerge,
  updateTask,
  submitReview,
  updateStatus,
  appendLog,
  computeStats,
  snapshotTensions,
  findItem,
  checkVersion
};
