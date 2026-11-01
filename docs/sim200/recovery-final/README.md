# T30：两站后故障、冻结前缀与实际救援交接

本专项于 2026-11-01 16:08 UTC 运行。它使用独立合成数据库，不改公开 SIM200 待排快照或 200 单终态验收记录。最终依据以 JSON 内时间戳为准。

## 实际结果

- `SIM200-053`、`SIM200-054` 经真实订单、库存、委托、签发、逐台验放、POD 和交付 API 完成前两站。
- 11:00（America/Chicago）登记故障；053/054 的已交执行前缀冻结。055/056 保持实际在途 SN，只进入异常冻结状态，从未写回 ready。
- 使用人工逐台点清的 SN 和明确确认的故障交接点，登记另一辆同合同内合格救援车。新路线从该故障点续行，站序为 056 → 055；新订单版本、新路线和新提货号独立留档。
- 真正调用本机 `18803` 的 Valhalla truck 3.8.3 与 VROOM，取得两段货车道路、36 点道路几何、498.839 米 / 77.964 秒，无未分配任务。取消重签后按新的订单版本再次真实计算。
- 首次救援签发被取消，取消只释放未交接的新授权和新车次占用；故障保管、原始历史和故障车辆暂停状态保留。重新签发后，由仓管岗位核验实际人车、位置、旧保管人签字、新司机签字、安全交接凭据及逐台 SN，完成现场交接。
- 剩余两票继续普通 POD/逐台交付 API，最终 4 台全部 delivered。已完成前两票原始订单行、全部原已交接 gate_grants 行逐字节不变。
- 65 条轨迹、14 条实际拒绝断言。覆盖错误车载 SN、冲突幂等键、旧签发上传、普通 resolve 绕过、重新加入冻结前缀、旧 case 版本、错误救援车辆、第二票旧提货号造成整批拒绝、已经交接后撤销、未交接提前复运和非主管复运。
- 原故障车在独立暂停表中阻止普通排线及验放。救援取消不解除故障；实际交接后由主管登记检修、检验和批准凭据才可复运。

`recovery-result.json` 是断言汇总，`recovery-trace.json` 是真实服务调用及拒绝轨迹，`recovery-case.json` 保存完整冻结前缀、原签发、原占用、现场 SN 版本及救援记录，`recovery-real-roads.json` 保存两次真实道路结果。`SIM200.sqlite3` 可逐表检查。

## API

共同入口为 `operations.handle`，server 与浏览器 worker 使用同一模块 `recovery.py`。所有 POST 都要求 `idempotency_key`；同操作者、同键、同请求返回原结果，变更请求体必须换键。所有多票写入使用 SAVEPOINT，失败整批回滚。除 report 外都要求当前 `version`（救援任务版本）。

| 方法及路径 | 岗位 | 必要内容 |
|---|---|---|
| GET `/api/ops/recovery` | 调度/采购/仓管/财务/主管 | 救援任务列表 |
| GET `/api/ops/recovery/{id}` | 同上 | 任务与历史日志 |
| POST `/api/ops/recovery/report` | 调度 | `route_id`, `route_version`, 全原车次 `order_versions`, 带 UTC 偏移的 `reported_at`, `location`（lat/lng/address/timezone）, 排序后的 `onboard_sns`, `reason`, `evidence`, `custody_ref` |
| POST `/api/ops/recovery/{id}/draft` | 调度 | 全部且仅剩余票的 `order_ids`, `order_versions`, `route`（新车/班组/司机/时刻/班次/包材/逐站窗口/道路依据） |
| POST `/api/ops/recovery/{id}/accept` | 采购 | 逐票 `links`（原 gate.network 登记的新人车关系）, `included_in_original_contract: true`, `acceptance_ref`, `approval_ref`, `handover_ref` |
| POST `/api/ops/recovery/{id}/issue` | 调度 | `evidence`；再次校验订单、SN、资源、合同、资格、道路与时段占用，逐票新签发 |
| POST `/api/ops/recovery/{id}/handover` | 仓管 | `handed_at`, `location_id`, `driver`, `plate`, `crew_id`, `vehicle_id`, `evidence`, `old_custodian_ref`, `receiving_driver_ref`, `safety_ref`, 逐票 `tickets`（release_version/pickup_code/sns） |
| POST `/api/ops/recovery/{id}/cancel` | 调度 | `evidence`；仅未交接草案/承接/签发可撤销，订单仍在故障冻结保管 |
| POST `/api/ops/recovery/{id}/repair` | 主管 | 已完成救援交接，且有 `repair_ref`, `inspection_ref`, `approval_ref`；只解除该故障的车辆暂停，不恢复原车次 |

真实道路服务请求额外传 `recovery_id`、`recovery_version`，起点 `warehouse` 必须是 report 返回的 `case.origin.name`，全量剩余订单版本也必须匹配。`road_service.inputs` 调用独立恢复校验，确认实际车载 SN 与保管版本，然后允许这些异常冻结在途票计算道路；不会将其它异常票放行。道路资源签名包含实际 recovery_origin 的 ID 和版本。draft 中的第一段 `from_id` 应为 `case.origin.id`，采用真实道路结果时由服务端覆盖。

## 保守边界

已支持纯送货、全部剩余 SN、终端直送或真实末段在途、原批准合同内同一执行方换车救援。车辆外廓、车门、地板、固定托位、重量、尾板附加重量、人员工具、技能、时窗及班次继续校验；没有费用变更时才可使用本接口。

混合取机、部分台数已经签收的单票、站仓首程、换承运商、新增费用不在本专项范围，接口明确拒绝，须另行完善相应授权及采购链。当前余站顺序是调度确认的可行顺序，并经 VROOM 与真实货车道路校验；本专项不宣称通用全局最优恢复、自动识别故障位置或自动推断货权。

合成故障点、客户门口、现场凭据和人员都仅为测试资料。真实路网是 DFW 小范围图，原始图日期未知；道路可达不能证明真实商业装卸入口已经实地核验。原出发四站路线使用明确标注的合成承运书面依据；只有故障后的两次救援计算属于真实路网集成验收。

## 重跑

```powershell
python -X utf8 -m unittest discover -s tests -p test_recovery.py -v
$env:HH_VALHALLA_URL='http://127.0.0.1:18803'
$env:HH_VROOM_URL='http://127.0.0.1:18803'
python -X utf8 scripts/verify_recovery.py --real-roads --output docs/sim200/recovery-new
```

已完成的目录返回保存结果。新的实际回放应选择新目录；半途失败目录须保留诊断，不以覆盖历史实现伪重跑。
