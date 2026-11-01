# V13 旧版终点与附加服务迁移

版本：`v13.scope.1`。实现：`v13/engine/migrations.py`。适用于现有共享 SQLite 订单库；不负责把 V8 浏览器 localStorage 全量导入 SQLite。

## 迁移规则

- 旧 `level=L4` 改为 `level=""`、`addon_l4=true`；旧 `level=L5` 同理改为 `addon_l5=true`。两种附项互不覆盖。原 `endpoint` 描述不改，也不据文字猜测 L1/L2/L3。
- 已有 `addon_l4`、`addon_l5` 和旧布尔别名 `L4`、`L5` 的真值保留；已有非空 `technical_order` 保留并映射技术附项。字符串 `"false"` 等不自动当真假：拒绝整个迁移批次，要求核实源数据。
- 缺少的结构字段补成空值或未知坐标；不填造时区、日期、路线、几何、价格、交付完成状态。缺少附项字段按原版本默认 `false` 兼容读取，明确的旧附项或技术委托优先保留。
- 未明确终点保留 `ENDPOINT_REQUIRED`。旧自提标记不免除此要求；只有 A/L1 的组合可使用自提。`pending_issues(order)` 基于当前事实返回补正路径，历史迁移标记本身不是放行依据。
- 订单改动增加版本，旧计划和草案的订单版本随之失效。缺新版字段的旧草案撤下可行标记并要求重新核验。已签发路线保持原版本与原内容；不能以迁移重写已执行事实。
- 未改动的记录保持原 JSON 和版本。重复执行不重复迁移；后续新增的旧格式记录仍会被处理。
- 旧附项别名和技术委托只在本迁移版本首次转换时映射。销售后续明确变更附项时，重启不会用历史字段重新覆盖其新选择。

`scope_migration_rows` 逐行保留修改前、修改后的**完整原文 JSON**、版本、状态与对象 ID；`scope_migration_runs` 保存版本、执行人、时间、备份引用和结果。订单数据内保留原层级与迁移批次引用。现有回执 BLOB、原事件、SN 锁、技术委托均不删除。

## 服务接入

在 `core.core_schema(db)`、`operations.init_db(db)` 之后、服务接受请求之前调用：

```python
import migrations
report = migrations.migrate(db)
```

内部使用 SAVEPOINT；已有外层事务时绝不主动提交外层事务。允许在服务初始化的 `BEGIN IMMEDIATE` 内调用。浏览器 `connect_demo()` 使用同一入口，Worker 的 Python 加载清单需包含 `migrations.py`。

规划预检应合并 `migrations.pending_issues(order)`，保留服务现有的时区、坐标、库存和资源等检查。销售通过正常订单变更补录 `level`、`endpoint`、`endpoint_ref`；已放行订单先按正常撤回/变更流程处理，不能直接改历史版本。

## 离线整库备份与恢复

首次升级现有正式库前，停止服务并执行（路径仅为示例）：

```powershell
python v13/engine/migrations.py migrate C:/logistics/current.sqlite C:/logistics/before-v13-scope.sqlite
```

工具取得 SQLite 写锁后，使用独立只读连接创建一致性整库备份，再执行迁移。原库、现有备份或任何已存在目标都不会被覆盖。迁移失败时事务回滚，成功完成的备份仍保留。

有已确认合同事实时，可附 `--resolutions C:/logistics/confirmed-endpoints.json`：

```json
{
  "OLD-ORDER-ID": {
    "level": "L3",
    "endpoint": "合同确认的一层营业机位",
    "evidence": "CONTRACT-REFERENCE"
  }
}
```

没有依据时保持待补。该清单不能改变已有的明确 L1/L2/L3 终点；改变合同范围须使用正常销售流程。

恢复到**新路径**，验证后再在停机状态切换服务数据库配置：

```powershell
python v13/engine/migrations.py restore C:/logistics/before-v13-scope.sqlite C:/logistics/restored.sqlite
```

恢复保持备份中的业务数据和历史；会撤销旧 sessions。整库恢复会回到备份时点，不应覆盖升级后新增业务。在线逻辑回退可调用 `rollback_run(db, run_id)`：仅当该批次全部对象仍与迁移后快照一致才恢复原 JSON；任一对象已被业务修改，整个回退拒绝。逻辑回退追加事件且版本继续增加，防止旧客户端复活。启动迁移会再次处理已回退的旧格式，因此逻辑回退主要用于故障排查；停机恢复应同步选择兼容应用版本。

## 实际验证范围

2026-11-01 运行 `python -B -m unittest discover -s tests -p test_v13_migrations.py -v`：15 项通过。测试在真实 SQLite 内存库及磁盘文件中插入旧格式原始 JSON、旧回执 BLOB、事件、SN 锁和草案，并通过实际 V13 `get_order` / `edit_order` / `planning.precheck` 读取和补正。

覆盖 L4/L5 拆分、不猜终点、兼容已有附项和技术委托、重复执行及迟到导入、确认依据、自提冲突、旧草案可读、已签发路线不改、触发器中途故障整批回滚、外层事务不被提交、版本单调回退、后续业务修改防覆盖、整库备份恢复、会话撤销和目标拒绝覆盖。

测试数据是合成旧格式样本，**不代表已迁移任何真实客户数据库**。实际生产库应先在隔离副本上运行并核对待补清单及附件数量。
