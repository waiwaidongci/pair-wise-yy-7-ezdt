import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 每个用例独立数据文件
process.env.DB_PATH = join(await mkdtemp(join(tmpdir(), "rigging-")), "db.json");
process.env.PORT = "3099";

const srv = await import("./server.js");
const {
  migrate,
  applyBatchMerge,
  submitReview,
  updateTask,
  computeStats
} = srv;

const TODAY = "2026-09-30T09:00";

function legacyDb() {
  return {
    items: [
      {
        code: "MR-OLD",
        shipType: "沙船",
        status: "待复核",
        tasks: [
          { id: "T-9", position: "前桅斜桁索", tension: "适中", status: "调整中", logs: [{ at: "2026-06-01", note: "历史调整" }] },
          { id: "T-10", position: "后桅支索", tension: "偏紧", status: "待检查", ticketNo: "RC-OLD-1", measuredAt: "2026-06-02", logs: [] }
        ],
        logs: []
      }
    ]
  };
}

function freshItem(overrides = {}) {
  return {
    id: "MR-1",
    code: "MR-1",
    status: "待检查",
    version: 3,
    conflict: false,
    mergedTickets: {},
    review: null,
    tasks: [],
    logs: [],
    ...overrides
  };
}

// ---------- 1. 旧数据没有现场单号和版本，升级后仍可查看并校准 ----------
test("迁移：旧数据补齐版本/单号/幂等索引，已带单号的历史任务可继续合并", () => {
  const db = migrate(legacyDb());
  assert.equal(db.schemaVersion, 2);
  const item = db.items[0];
  assert.equal(item.version, 0);
  assert.equal(item.conflict, false);
  assert.equal(item.tasks[0].ticketNo, null);
  assert.deepEqual(item.mergedTickets["RC-OLD-1"].taskId, "T-10");

  // 旧模型仍可继续校准：新批次与旧单号去重，同号沿用首次结果
  const r1 = applyBatchMerge(item, {
    expectedVersion: 0,
    records: [
      { ticketNo: "RC-OLD-1", position: "后桅支索", tension: "偏紧", measuredAt: TODAY },
      { ticketNo: "RC-NEW-1", position: "前桅侧支索", tension: "偏松", measuredAt: TODAY }
    ]
  });
  assert.equal(r1.created.length, 1);
  assert.equal(r1.reused.length, 1);
  assert.equal(r1.reused[0].deduplicated, true);
  assert.equal(item.version, 1);
  assert.equal(item.status, "校准中");
});

// ---------- 2. 网络恢复后按单号合并；同号重传沿用首次结果 ----------
test("合并：按现场单号幂等，同号重传不重复建任务", () => {
  const item = freshItem({ status: "校准中" });
  const records = [
    { ticketNo: "RC-1", position: "前桅侧支索", tension: "偏松", measuredAt: TODAY },
    { ticketNo: "RC-2", position: "后桅升帆索", tension: "偏紧", measuredAt: TODAY }
  ];
  const r1 = applyBatchMerge(item, { expectedVersion: 3, records });
  assert.equal(r1.created.length, 2);
  assert.equal(item.tasks.length, 2);
  assert.equal(item.version, 4);
  assert.equal(item.mergedTickets["RC-1"].taskId, item.tasks[0].id);

  // 重传整批：沿用首次结果，不再产生新任务、版本不变
  const r2 = applyBatchMerge(item, { expectedVersion: 4, records });
  assert.equal(r2.created.length, 0);
  assert.equal(r2.reused.length, 2);
  assert.equal(item.tasks.length, 2);
  assert.equal(item.version, 4);
  assert.equal(r2.changed, false);
});

// ---------- 3. 写入失败后保留原批次：整批校验，任一条不合法则全部不生效 ----------
test("整批校验：缺单号/缺张力/时间不可识别，整批拒绝且原数据不动", () => {
  const item = freshItem({ version: 7 });
  const bad = [
    { ticketNo: "RC-A", position: "x", tension: "偏松", measuredAt: TODAY },
    { ticketNo: "", position: "y", tension: "偏紧", measuredAt: TODAY },
    { ticketNo: "RC-C", position: "z", tension: "", measuredAt: TODAY },
    { ticketNo: "RC-D", position: "w", tension: "偏松", measuredAt: "不是日期" }
  ];
  assert.throws(
    () => applyBatchMerge(item, { expectedVersion: 7, records: bad }),
    e => e.status === 400 && e.code === "invalid_batch"
  );
  assert.equal(item.tasks.length, 0);
  assert.equal(item.version, 7); // 半条帆索任务都没有留下
  assert.equal(Object.keys(item.mergedTickets).length, 0);

  // 空批次
  assert.throws(() => applyBatchMerge(item, { expectedVersion: 7, records: [] }), e => e.code === "empty_batch");
});

// ---------- 4. 两台终端同时提交：先到接受，后到 409 ----------
test("乐观锁：版本不匹配拒绝（409），携带当前版本", () => {
  const item = freshItem({ version: 5 });
  applyBatchMerge(item, {
    expectedVersion: 5,
    records: [{ ticketNo: "RC-X", tension: "偏松", measuredAt: TODAY }]
  });
  assert.equal(item.version, 6);
  assert.throws(
    () => applyBatchMerge(item, {
      expectedVersion: 5, // 另一台终端仍拿着旧版本
      records: [{ ticketNo: "RC-Y", tension: "偏紧", measuredAt: TODAY }]
    }),
    e => e.status === 409 && e.code === "version_conflict" && e.extra.currentVersion === 6
  );
  // 后到者刷新到当前版本后提交，应当成功
  const r = applyBatchMerge(item, {
    expectedVersion: 6,
    records: [{ ticketNo: "RC-Y", tension: "偏紧", measuredAt: TODAY }]
  });
  assert.equal(r.created.length, 1);
});

// ---------- 5. 张力变化让复核结论失效，退回待复核，列表/统计/校准记录显示冲突 ----------
test("张力冲突：复核后张力改变 → 结论失效、退回待复核、标记冲突", () => {
  const item = freshItem({
    status: "已交付",
    version: 10,
    tasks: [
      { id: "T-a", position: "前桅侧支索", tension: "适中", status: "完成", ticketNo: "RC-A", logs: [] }
    ]
  });

  submitReview(item, { expectedVersion: 10, conclusion: "通过" });
  assert.equal(item.status, "已交付");
  assert.equal(item.conflict, false);
  assert.equal(item.review.invalid, false);
  assert.equal(item.version, 11);

  // 张力变化（单条更新）
  updateTask(item, "T-a", { expectedVersion: 11, tension: "偏紧" });
  assert.equal(item.review.invalid, true);
  assert.equal(item.conflict, true);
  assert.equal(item.status, "待复核");
  const conflictLog = item.logs.find(l => l.type === "conflict");
  assert.ok(conflictLog, "校准记录里应有冲突条目");
  assert.match(conflictLog.note, /前桅侧支索：适中→偏紧/);

  // 统计中冲突计数 +1
  const stats = computeStats([item]);
  assert.equal(stats["冲突"], 1);
  assert.equal(stats["待复核"], 1);

  // 断网合并进来的新张力若与复核快照不同，同样失效
  const item2 = freshItem({
    status: "已交付",
    version: 1,
    tasks: [{ id: "T-b", position: "后桅升帆索", tension: "适中", status: "完成", ticketNo: null, logs: [] }]
  });
  submitReview(item2, { expectedVersion: 1, conclusion: "通过" });
  applyBatchMerge(item2, {
    expectedVersion: 2,
    records: [{ ticketNo: "RC-B", position: "后桅升帆索", tension: "偏松", measuredAt: TODAY }]
  });
  assert.equal(item2.conflict, true);
  assert.equal(item2.status, "待复核");
  assert.equal(item2.review.invalid, true);

  // 重新复核后冲突清除
  submitReview(item, { expectedVersion: item.version, conclusion: "通过" });
  assert.equal(item.conflict, false);
  assert.equal(item.review.invalid, false);
  assert.equal(item.status, "已交付");
  assert.equal(computeStats([item])["冲突"], 0);
});

test("复核快照后张力未变：不产生冲突", () => {
  const item = freshItem({
    status: "校准中",
    version: 0,
    tasks: [{ id: "T-c", position: "锚链", tension: "偏松", status: "调整中", ticketNo: null, logs: [] }]
  });
  submitReview(item, { expectedVersion: 0, conclusion: "不通过" });
  // 同值更新
  updateTask(item, "T-c", { expectedVersion: 1, tension: "偏松" });
  assert.equal(item.conflict, false);
  assert.equal(item.review.invalid, false);
});

// ---------- 6. 原子存储 + HTTP 集成 ----------
test("HTTP 集成：迁移落盘、幂等合并、409、冲突统计", async (t) => {
  // 先放一份旧格式数据文件
  const dir = await mkdtemp(join(tmpdir(), "rigging-http-"));
  const file = join(dir, "db.json");
  await writeFile(file, JSON.stringify(legacyDb()));

  process.env.DB_PATH = file;
  process.env.PORT = "3130";
  const { createServer } = await import("./server.js?x=" + Date.now());

  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const call = async (path, init) => {
    const res = await fetch(base + path, init && init.body
      ? { ...init, headers: { "Content-Type": "application/json" } }
      : init);
    const data = await res.json();
    return { status: res.status, data };
  };

  await t.test("旧数据可查看", async () => {
    const r = await call("/api/items");
    assert.equal(r.status, 200);
    const old = r.data.find(i => i.code === "MR-OLD");
    assert.ok(old);
    assert.equal(old.version, 0);
    assert.equal(old.tasks[0].ticketNo, null);
  });

  let itemId;
  let createdVersion;

  await t.test("创建模型 v0", async () => {
    const r = await call("/api/items", {
      method: "POST",
      body: JSON.stringify({ code: "MR-NEW", shipType: "福船" })
    });
    assert.equal(r.status, 201);
    itemId = r.data.id;
    createdVersion = r.data.version;
    assert.equal(createdVersion, 0);
  });

  await t.test("合并整批成功并原子落盘", async () => {
    const r = await call(`/api/items/${itemId}/merge-batch`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 0,
        batchId: "B-1",
        records: [
          { ticketNo: "RC-HTTP-1", position: "前桅侧支索", tension: "偏松", measuredAt: TODAY },
          { ticketNo: "RC-HTTP-2", position: "后桅支索", tension: "适中", measuredAt: TODAY }
        ]
      })
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.created.length, 2);
    assert.equal(r.data.item.version, 1);
    // 落盘内容完整，无残留临时文件
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    const saved = onDisk.items.find(i => i.id === itemId);
    assert.equal(saved.tasks.length, 2);
  });

  await t.test("同号重传沿用首次结果，版本不变", async () => {
    const r = await call(`/api/items/${itemId}/merge-batch`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 1,
        batchId: "B-1",
        records: [
          { ticketNo: "RC-HTTP-1", position: "前桅侧支索", tension: "偏松", measuredAt: TODAY },
          { ticketNo: "RC-HTTP-2", position: "后桅支索", tension: "适中", measuredAt: TODAY }
        ]
      })
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.created.length, 0);
    assert.equal(r.data.reused.length, 2);
    assert.equal(r.data.item.version, 1);
  });

  await t.test("坏批次整批拒绝（400），任务数不变，可继续重试", async () => {
    const before = JSON.parse(await readFile(file, "utf8")).items.find(i => i.id === itemId);
    const n = before.tasks.length;
    const r = await call(`/api/items/${itemId}/merge-batch`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 1,
        records: [
          { ticketNo: "RC-HTTP-3", position: "x", tension: "偏松", measuredAt: TODAY },
          { ticketNo: "RC-HTTP-4", position: "y", tension: "", measuredAt: TODAY }
        ]
      })
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "invalid_batch");
    assert.equal(r.data.issues.length, 1);
    const after = JSON.parse(await readFile(file, "utf8")).items.find(i => i.id === itemId);
    assert.equal(after.tasks.length, n, "不留半条帆索任务");
  });

  await t.test("并发：旧版本提交得到 409", async () => {
    const r = await call(`/api/items/${itemId}/merge-batch`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: 0,
        records: [{ ticketNo: "RC-CONFLICT", tension: "偏松", measuredAt: TODAY }]
      })
    });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "version_conflict");
    assert.equal(r.data.currentVersion, 1);
  });

  await t.test("复核后张力变化 → 冲突，统计可见", async () => {
    const taskId = (await call(`/api/items`)).data.find(i => i.id === itemId).tasks[0].id;

    let r = await call(`/api/items/${itemId}/review`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion: 1, conclusion: "通过" })
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, "已交付");

    r = await call(`/api/items/${itemId}/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: 2, tension: "偏紧" })
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.status, "待复核");
    assert.equal(r.data.conflict, true);
    assert.equal(r.data.review.invalid, true);
    assert.ok(r.data.logs.some(l => l.type === "conflict"));

    const stats = (await call("/api/stats")).data;
    assert.ok(stats["冲突"] >= 1);
  });

  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});
