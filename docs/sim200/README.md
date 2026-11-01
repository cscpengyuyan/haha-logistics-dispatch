# SIM200 可复现业务演练

本批次使用固定种子 `20261101`、业务日期 `2026-11-01` 起的 14 天需求。全部客户、主体、电话、车辆、SN、报价、附件与证据均为合成资料。原 `销售交单收集表.xlsx` 未在本次检查的工作区输出与 QA 目录找到；CSV 字段直接匹配 V13 `sales_workbook.FIELDS`，由实际销售文件 preview / confirm 导入，随后物流 handoff 接手。

## 运行

```powershell
python -X utf8 scripts/run_sim200.py --generate-only
python -X utf8 scripts/run_sim200.py --output docs/sim200/my-run
python -X utf8 scripts/run_sim200.py --output docs/sim200/my-ready --prepare-only
python -X utf8 -m unittest discover -s tests -p test_sim200.py -v
```

`--output` 建议指定新的专用目录。重复运行同一路径会从同事务提交的步骤回执续跑；已成功动作不会再次入库。脚本从不删除或重置已有目录；遇到非 `mode=demo` 数据库会拒绝。业务结果全部由现有 V13 领域服务产生，没有更新订单完成状态或凭空制造签收的 SQL。

`v13/data/sim200/` 中包含 200 条 JSON、实际模板 CSV、初始资源与海运清单及 SHA256。`coverage` 是验收预期，不能当作实际完成状态。资源包中的 M01 包装是虚构参数，不作为真实产品规格。

## 已运行结果

干净运行结果位于 `docs/sim200/acceptance/`：

| 检查 | 实际结果 |
| --- | --- |
| 主订单 | 精确 200 个唯一 SIM200 ID；销售重复导入新增 0 |
| 主单终态 | 180 运输结算 + 12 自提核账 + 8 合法取消 |
| 台数 | 初始库存 174 + 4 个海运批次实际接收 86 = 260 |
| 首次客户交接 | 252 个唯一 SN；取消释放 8 台仍可用 |
| 售后 | 20 原 SN 回收、维修、原机回送、验收；20 附属回送单已结算 |
| 失败及恢复 | 132 次实际业务拒绝；10 票首送失败后再次交接，保留两次尝试 |
| C2 改派 | 5 票撤销未执行第二程、免收原班费用、计入短存并重新签发 |
| 财务 | 主单 USD 72,060，关联返修回送 USD 8,000 |
| 最终检查 | 取消订单 SN 锁 0；孤立预订 0；未关闭售后 0 |
| 轨迹 | 2,591 条逐步记录，含实际返回、角色、业务时间、墙钟和版本 |

`trace.jsonl` 包含每步实际返回，`results.csv` 与 `result.json` 包含逐票终态。SQL 台账保留销售原件、变更历史、供应商资格、委托、仓口、逐 SN 交接、账单和售后证据。管理员只参与演练账户/资源初始化及原引擎明确要求主管批准的维修工位授权；订单主流程使用销售、仓库、采购、调度、司机、技术、财务岗位。

## 公开快照

`ready-public/SIM200.sqlite3` 是从空白演练库经同一实际 API 生成的待排快照：200 主单 ready、260 SN reserved、180 运输订单有报价与对应委托。其隐私与来源检查见 `ready-public/PUBLIC-SNAPSHOT-AUDIT.json`。它与 `acceptance/` 的终态证据库独立；公开访问应为每访客使用独立浏览器存储。

公开 API：销售 `POST /api/simulation/import`；调度 `POST /api/simulation/prepare`；授权办公岗位 `GET /api/simulation/summary`。`prepare` 只完成真实销售接手和路线/位置字段，不自动签发或制造完成状态。

## 验收边界

本脚本属于业务 API 回归。车次使用显式 `SIM-CONTROLLED-CARRIER-EVIDENCE-NOT-REAL-ROAD` 作为受控道路依据替身；网格坐标与仓口核验也是合成测试事实，未经真实路口实核。真实 Valhalla / VROOM / CP-SAT 道路与优化集成由独立报告证明，本报告不替代该项证据。

资源日历例外关闭、共享容量池、全批优化、44 场景及浏览器验收不能仅凭本脚本宣称全部通过。`result.json.full_acceptance` 保持 `false`，直至整体方案另行核齐。阶段业务终态的 `complete=true` 仅表示 200 主订单预期终态达成。
