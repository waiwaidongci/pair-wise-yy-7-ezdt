# 古船模型帆索校准

零依赖 Node.js 服务，串联古船模型、帆索任务与校准记录。

运行：

```bash
npm start          # http://localhost:3038
npm test           # 14 项单元 + HTTP 集成测试（node:test）
```

数据保存在 `data/model-rigging-calibration.json`，可用 `DB_PATH=/path/to/db.json` 指定其他位置。

## 业务规则

- **断网采集**：负责人先只记索具张力、测量时间和现场单号，暂存在本地批次（浏览器 localStorage）；网络恢复后按模型“按单号合并”。
- **按现场单号幂等合并**：服务端以现场单号去重，同号重传沿用首次结果（不重复建帆索任务），返回 `created` / `reused` 明细。
- **乐观版本号**：每个模型有单调递增的 `version`，所有写操作带 `expectedVersion`。两台终端同时提交同一任务时接受先到的当前版本，后到者收到 `409 version_conflict`（附当前版本），刷新后重试即可。
- **整批原子写入**：先整批校验（现场单号、索具张力、测量时间缺一不可），任一不合法整批拒绝（400 带 issues）；写入采用临时文件 + rename 原子落盘。失败时本地批次原样保留可继续重试，不留下半条帆索任务。
- **张力变化作废复核**：提交复核时保存各索具张力快照；之后张力与快照不一致（单条更新或断网合并）时，复核结论标记失效、模型退回待复核、置冲突标记，列表卡片、统计（“冲突”计数）与校准记录（冲突日志）三处同时可见；重新复核后冲突清除。
- **旧数据兼容**：没有现场单号和版本号的历史数据读入时自动迁移（补 `version:0`、`ticketNo:null`，已带单号的任务回填幂等索引），升级后仍可查看并继续校准。

## 主要 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/items` | 模型列表（含版本号、冲突标记、复核结论） |
| POST | `/api/items` | 建档（v0） |
| PATCH | `/api/items/:id` | 改模型状态（带 expectedVersion） |
| POST | `/api/items/:id/merge-batch` | 断网批次按现场单号合并 |
| PATCH | `/api/items/:id/tasks/:taskId` | 更新帆索张力/任务状态 |
| POST | `/api/items/:id/review` | 提交复核结论（通过/不通过，存张力快照） |
| POST | `/api/items/:id/logs` | 追加校准记录 |
| GET | `/api/stats` | 分阶段统计 + 冲突计数 |
