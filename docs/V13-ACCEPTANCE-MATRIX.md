# V13 地图调度验收矩阵

审查日期：2026-11-01 至 2026-11-02。基线：`bd564c6e9c9b28c682cee8057b43ceba7cb9f62e`。本表逐项对应《V13地图调度_完整设计与Codex修改方案》第 17 节。状态只覆盖“实际证据与边界”所写范围，不能据此宣称 S0–S6 全部验收完成。

- **已验证**：对应核心行为存在实际通过的断言或逐票轨迹；仍须遵守该行注明的模型、业务 API 或道路集成范围。
- **部分**：已有实现和部分验证，但未完整触发规定场景，或仅证明某一层。
- **未验证**：尚未取得该场景的直接运行证据；可能仍需实现。

三类证据不能互相替代：SIM200 业务链使用标记明确的受控承运商依据；真实路网另有固定版本城市样本集成；浏览器交互与前端状态另行验证。**200 票业务终态达成不等于 200 票真实道路联合优化完成。**

## 证据索引

| 编号 | 文件及范围 |
| --- | --- |
| E1 | `docs/verification/v13/regression.txt`：最终全量200项Python回归全部通过、0跳过，63.863秒，包含真实Valhalla/VROOM道路及批量F04。该数字不是本表44项覆盖数；须逐项看实际断言和业务边界。 |
| E2 | `docs/verification/v13/road-live.txt`：4 项道路测试实际通过；DFW Valhalla truck / VROOM 两组结果分别 3,334 米 / 351 秒、4,365 米 / 412 秒。 |
| E3 | `docs/sim200/roads/road-integration.json` 与四个 `*-native.json`：Valhalla 3.8.3，DFW/Houston/Los Angeles/Atlanta 的方向性矩阵与双车 VROOM 城市小样本。坐标吸附不证明真实客户入口，也不证明跨城/全国限行覆盖。 |
| E4 | `docs/sim200/acceptance/result.json`、`results.csv`、`trace.jsonl`：200 唯一主单；192 settled（180 运输、12 自提）、8 cancelled；252 唯一首交 SN；20 原 SN 售后回送并结算；2,591 条轨迹；`full_acceptance=false`。 |
| E5 | `docs/sim200/planning-public/cases-summary.json`、`C1.json`、`L5.json`、`C2-stage.json`、`station-delay.json`：完整C1两段、L5独立技师、C2已授权阶段及600分钟站内处理阻断后程的明确算例。业务/承诺依据为合成；200票算例覆盖156/200，44票未排，不能冒充全200覆盖。`docs/verification/v13/optimizer-live/summary.json`：6票真实Valhalla/VROOM+CP-SAT，60候选/24可行，6/6覆盖；冷23.0秒/热21.187秒，采用及幂等通过。最优性只适用已生成候选集合。 |
| E6 | `tests/unified-workspace.test.cjs`：最新22项前端状态/接口契约测试通过，覆盖选单持久性、时区、迟到结果、恢复/取消、幂等重试、嵌套诊断及采用竞态；新增多段/未来段/L5共享时间轴、自提/承诺只读、不伪造人车、原生道路几何与过期版本校验、输出转义。JS语法检查通过。 |
| E7 | `docs/verification/v13/jobs-http.json`：本机 HTTP 任务结果；`tests/test_v13_jobs.py`：排队快照、调用者隔离、幂等与取消后迟到结果。 |
| E8 | `docs/sim200/ready-public/PUBLIC-SNAPSHOT-AUDIT.json`：公开待排快照来源及虚构数据检查；与 E4 的终态证据库分开。 |
| E9 | `tests/test_v13_migrations.py`、`docs/verification/v13/migrations.txt`：15 项迁移测试通过，真实 SQLite 文件与合成旧格式记录；整库备份/恢复、原回执与 SN、未知终点待补、旧草案重核、故障回滚、后续业务修改保护及重启不复活旧附项。操作说明 `docs/V13-LEGACY-MIGRATION.md`；非实际客户生产库迁移声明。 |
| E10 | `docs/sim200/edge-cases/result.json`、`trace.jsonl` 与 `tests/test_sim200_edges.py`：独立演练副本59步、9次预期拒绝；低/基/高补货、独立批准、真实调拨实收、短少/替代/隔离与重新分配后交付。 |
| E11 | `tests/test_v13_release_edges.py`、`docs/verification/v13/release-edges.txt`：5 项通过。实际多路线草案采用回滚/幂等、两 worker 租约竞争及晚成功/晚失败围栏、明确完工窗、门高/地板隔离负例。 |
| E12 | `tests/map-mount.test.cjs`：真实 Edge DOM 执行生产脚本，非空候选从 localStorage 恢复后 mount、时间轴切换时区、390px 日期重绘和地图离线退化；1 项通过、0 pageerror。覆盖 shared 变量遮蔽导致的 TDZ，不代替最终线上 CUA 视觉验收。 |
| E13 | `tests/test_v13_mixed_load.py`16项、`docs/verification/v13/T06-mixed-load.json`：真实业务API先交付再授权RMA，同址先送后收峰值2台/452kg，先收后送3台/678kg触发台数、重量、地板、固定托位限制；明确required_collections不会被省略，合法混载42500分包含授权回收价。 |
| E14 | `docs/sim200/recovery-final/recovery-result.json`、`recovery-trace.json`、`recovery-real-roads.json`：65轨迹、14拒绝；原车两站完成后故障，冻结前缀原行/原授权字节不变，另车现场逐台交接后余两站完成；故障后两次真实Valhalla/VROOM路由。范围与拒绝边界见该目录README。 |
| E15 | `docs/verification/v13/job-process-restart.json`：真实子worker首次claim后被terminate，等待真实45秒租约、未改expires，重启attempt2完成6/6，同键返回同job，46.17秒；结合E11两个旧worker迟到结果围栏。 |
| E16 | `tests/test_v13_batch_release.py`、`docs/verification/v13/batch-release.txt`：6项正式跨票F04原子签发与HTTP并发重试通过。第二票缺凭据/资源冲突时，第一票实际订单、gate、booking、event写入均回滚；同键只签一次、异payload409、计划关联严查。 |
| E17 | `docs/verification/v13/browser-1440.jpg`、`browser-1024.jpg`、`browser-390.jpg`及主代理CUA观察：三宽度无横向溢出、11月2日地图/日期17票、图层关开保留计算200/筛选外183、自提只读无配送车。`full-package-health.json`确认本机V13入口、CP-SAT和四区域道路；公开版本200票、6票试排与采用已有browser-online专项记录。 |

浏览器补充记录：主代理在实际 CUA/IAB 会话载入 SIM200 200 票，执行加入完整批次、11 月 2 日筛选、切换日期计划，计划 ID 与 200 票范围保持不变。最新复核地图和日期视图均为该日17票；日期标签统计全部订单，用 title 单列可直接排车数量，C 链日期保留 `dispatch_view_day`。地图恢复非空车次的 shared 变量遮蔽异常已修，E12 直接覆盖其真实 DOM 路径。公开版本已通过主代理CUA实测，线上截图、DOM记录及版本信息另见browser-online证据。

## T01–T44

| 场景 | 状态 | 实际证据与边界 / 剩余工作 |
| --- | --- | --- |
| T01 三票竞争唯一上楼班组 | 已验证 | `tests/test_v13_capacity_origin_acceptance.py`：三张真实 addon_l4 订单、实际专项资格与报价，普通班组因缺上楼工具被排除；唯一合格班组以三站路线覆盖全部三票，实际采用、F04及逐台验放通过。旅行时距使用明确SIM承运依据，不冒充真实道路。 |
| T02 大小车分别按真实容量 | 已验证 | 同上专项：1/2/3台需求竞争2台/452kg小车和4台/904kg大车；小车只接2台票，大车接1+3台，超载草案排除，generated也按各车容量生成。实际采用、F04、6台SN验放通过。 |
| T03 一车同时两路线 | 已验证 | `test_routing.test_only_vehicle_overlaps`、`test_two_accounts_compete_then_multistop_and_nonoverlap` 实际 HTTP 竞争及非重叠签发；`Selection.test_nonoverlap_requires_reposition_between_origins` 校验异仓调位。E1。 |
| T04 同班组服务两车辆 | 已验证 | `Selection.test_same_crew_across_vehicles_conflicts` 独立班组占用排除重叠组合；不把车组组合 ID 当唯一资源。模型断言，E1。 |
| T05 重量合格但门高/地板不合格 | 已验证 | E11 `test_t05_weight_passes_while_door_height_and_floor_independently_fail`：重量明确低于载重，门高单独超限被拒；门高恢复后仍因地板净长不足被拒；包装长度修正后通过。范围为已核尺寸的保守整行占地模型，不宣称一般三维装箱。 |
| T06 送收顺序改变峰值载荷 | 已验证 | E13：同址已授权RMA，先送后收峰值2台/452kg可行；先收后送3台/678kg并超地板/托位而淘汰。16项回归包括真实F04预订、RMA版本变更失效、回收实收释放与required_collections防漏排，混载费用42500分。范围是同一已核装卸点；异址回收缺独立路段会明确拒绝，不宣称一般异址取送优化。 |
| T07 单行/货车限制的方向性道路 | 部分 | E3 四区域实际矩阵均有非对称路段；`VersionAndRoad.test_cache_direction_truck_version` 验证方向与车型缓存分离；E2 实际引擎路线。未以特定限高/单行违规道路作为负例验证全部最终几何。 |
| T08 末站返场超班 | 已验证 | `VersionAndRoad.test_return_is_inside_shift` 与 `Selection.test_return_is_included_in_occupancy` 验证回程进入班次与资源占用。E1；属于模型/适配器边界断言。 |
| T09 中国浏览器跨美国时区 | 部分 | E6 对同 UTC 时刻在 Chicago / Shanghai 的日期分界有断言；服务使用 UTC；实际 IAB 可打开跨区数据。未完成两种浏览器时区端到端输出逐项相等的自动化对照。 |
| T10 夏令时重复/不存在时刻 | 已验证 | `Contracts.test_dst_repeated_and_missing_wall_time_rejected` 覆盖 2026-11-01 01:30 重复、2026-03-08 02:30 不存在及显式偏移通过；`test_coverage_rejects_nj_crew_and_timezone_needs_unique_instant` 同时回归。E1。 |
| T11 窗内完工而非仅到场 | 已验证 | E11 `test_t11_arrival_and_start_inside_window_but_finish_after_explicit_cutoff`：到场、开工均在明确 finish_by 完工窗内、late=0，但离场超时，仅出现完工约束错误；缩短作业后通过。不同到场/开工/完工窗须明确登记，不把任意到场窗自动当作完工窗。 |
| T12 同址合停且逐票保持 SN | 已验证 | `test_routing.test_confirmed_shared_stop_keeps_each_ticket_sn_and_labor` 检查确认同停、逐票 SN 与劳动时间。E1。 |
| T13 不同实际仓不能只改标签混排 | 已验证 | 同上专项：两实际仓独立SN，混仓和只改起仓标签的草案均被拒；选中两条各自起仓路线，逐票SN与原仓一致，采用/F04/逐台验放通过。此证据证明拆车，不宣称任意多仓连续提货已实现。 |
| T14 同 SN 并发争抢 | 已验证 | `test_shared.test_two_named_warehouse_accounts_race_same_sn` 实际两账号竞争；`Selection.test_same_sn_cannot_be_reserved_twice` 检查候选互斥。E1。 |
| T15 D 前置库存隔离/锁定 | 部分 | `test_supply.test_stock_count_isolates_one_unit_and_requires_independent_approval`、`test_handoff_branches.test_d_sale_at_approved_destination`；SIM200-094 的 `quarantined_reservation_rejected`。尚未把隔离 D 库存与跨仓替代候选放入一次全局选择直接验证。 |
| T16 C2 合法先到站后补二程 | 已验证 | E4的C2站内实收/缺后程阻断/后程采购业务链；E5 `C2-stage.json` 为authorized_stage，阶段覆盖1/1、整票完成0/1，未把到站当客户交付。已授权首程与后续采购责任分开；证据为明确合成承运商承诺，不宣称跨城真实道路全链已覆盖。 |
| T17 C1 缺二程委托 | 已验证 | `tests/test_v13_version_cost_acceptance.py`：真实C1合同、接站及库存，仅移除second_leg时首程签发409，订单/事件/库存/锁/授权均不变；按原委托API补齐后首程签发成功。 |
| T18 接站处理赶不上二程班次 | 已验证 | E5正常C1有两段完整可行链；`scripts/verify_v13_public_plans.py`将station_processing_minutes改为600，`station-delay.json`直接得到assigned=0及CHAIN_INCOMPLETE，未输出断链可执行方案。范围为固定站内处理与已核容量/班次算例，非复杂排队模型或真实全网站场调度。 |
| T19 二程撤销重派 | 已验证 | `test_station_commission.test_revoke_reprice_reissue_only_second_leg`；E4 SIM200-159–163 `revoke_second_leg` / `replace_second_leg` / `resign_second_leg`，短存记录、首程历史保留。 |
| T20 L3 完成但 L5 未完成 | 已验证 | 既有逐台物理/技术独立完成回归、E4的35票技术验收；E5 `L5.json` 同一候选包含2物理运段与独立technical_tasks，技师时段位于物理交付后，另有缺授权技师阻断测试。前端共享时间轴单列技术预排及独立结果，不把物理POD当L5完成。范围为有限候选与已登记技师。 |
| T21 具体车与承诺共享容量池 | 已验证 | `tests/test_v13_capacity_pool_acceptance.py`：同供应商同日真实A平台承诺/B具体车订单，经实际资源及承诺profile登记同pool；容量1时各自可行但仅覆盖1且拒绝采用；容量2时2/2采用，保留一条车辆路线和一份无虚构车组的承诺。 |
| T22 包干/同址/最低价/尾板去重与分摊 | 已验证 | `tests/test_v13_price_card_acceptance.py`：实际同停核验，完整采购价卡替代旧含尾板价格，最低12001分按6000/6001分摊；去掉最低价后，同停2100分、分停2600分。两路线共享7000分日启用只计一次，31002分优于35000分组合，原生/浏览器求解均选正确组合。范围为明确完整替代价卡和整数金额，未声称任意阶梯/非线性合同。 |
| T23 低价缺 L4 价格不得获胜 | 已验证 | `tests/test_v13_version_cost_acceptance.py`：真实L4单原全价400美元；1美元基础低价但缺special_cost被比较与中选排除，计划仍为400美元；专项明确补500美元后，经正式审批的新价为501美元。 |
| T24 少覆盖不能冒充全范围低价 | 已验证 | `Selection.test_complete_coverage_precedes_low_partial_cost` 在已知小模型中选择全覆盖；统一 UI 显示整票/阶段覆盖和未排原因。E1、E6。 |
| T25 订单/包装/报价变更失效 | 已验证 | 同上专项三例：真实解锁/编辑/重备货修改时间窗或包装版本，旧计划发布/采用和旧费用被拒，不能仅刷新order_versions洗白旧道路。报价独立加25美元而不改订单，旧计划/费用被拒；重新审批后为425美元。纯改价不改变物理路段时允许复用有效方向矩阵；道路供应商IO为明确测试适配器，非实路声明。 |
| T26 人工锁定无解并解释 | 已验证 | `tests/test_v13_lock_timeout_acceptance.py`：最终候选所有segment统一核验vehicle/crew/date/相对station_order锁，承诺及未来二程不绕过；冲突含指定值、候选值及可由调度确认的调整提示，automatic_relaxation=false，原锁不变。另验证客户端派生字段注入被拒、当前与未来采用覆盖一致、真实末端位置及原生二阶段劣解不替换较优解。仅诊断生成候选；站序锁约束路线内部，不宣称跨车辆总先后或数学最小冲突集。 |
| T27 超时有解/无解分开 | 已验证 | 同上28项锁定/超时/输入边界专项：超时验证：确定性deadline分别触发有解/无解、保留最后可行解、跨目标pass保留原目标下较优可行结果；原生一期FEASIBLE不误报已证最优，二期UNKNOWN保留一期结果；重试不会覆盖既有可行计划。仅截止点注入，原生约束真实求解，非性能基准。 |
| T28 道路离线/null/缓存过期 | 已验证 | `VersionAndRoad.test_null_never_zero`、`test_cache_direction_truck_version`、`TestPlannerContract.test_provider_contract_changes_rollback_and_fail_closed` 与 E2。故障注入属于适配器测试；成功路线另有真实引擎记录。 |
| T29 批量签发/断网重试无假成功 | 已验证 | E11原子采用草案；E16新增正式`/api/ops/dispatch-batches/release`，每票原core与12项实据，第一票已产生真实订单/gate/booking/event后，第二票缺papers或争抢人车均全批回滚。双并发HTTP同actor/key/payload返回同批次/提货号，每票只签一次；异payload409，失败可补正重试。可选计划关联严查已采用版本、集合和真实路线。范围为两票正式dispatch；200票性能及所有station_release组合未声称已测。 |
| T30 两站后故障冻结前缀重排 | 已验证 | E14真实4票运行：前2站完成原行和原gate_grants字节不变；余2票实际在途SN在现场冻结，原合同内合格另车从明确故障点经Valhalla/VROOM校验、取消重签及逐台现场交接后交付。65轨迹14拒绝，旧码/旧版本不通，故障车暂停保留至主管凭据复运。范围限纯全SN终端配送、同执行方；混收货、部分SN、换承运/新增费用严格拒绝。站序由调度确认并校验可行，不宣称通用自动最优恢复。 |
| T31 维修未放行不能原机回送 | 已验证 | E4 SIM200-053–072 各有 `aftercare_premature_redelivery_rejected`，随后 repair_test_release / redelivery_order / customer_restored / rma_closed；20 个原 SN 重送并结算。 |
| T32 取消仅释放相关资源 | 已验证 | E4 SIM200-001–004、049–052 取消，`cancelled_sn_locks=0`、`orphan_bookings=0`；T19 二程撤销保留首程。注意200票取消发生在正式出库前，不宣称执行中整批撤销已覆盖。 |
| T33 错执行方/车牌/SN/旧码 | 已验证 | `tests/test_v13_gate_identity_acceptance.py`：同一真实订单与SN，错误执行方已保存路线被F04拒绝，错误车牌/错误SN被仓口拒绝；正式撤销重签后原真实提货码和原签发版本均被拒，库存始终reserved；完全匹配新授权才进入transit。另有E4逐票错误SN及E14执行中旧码阻断证据。 |
| T34 外包零担/平台/自提 | 已验证 | `test_handoff_branches.test_amazon_handoff_and_platform_receipt` / `test_dealer_endpoint` / `test_authorized_pickup_ends_at_origin`；E4 12平台回执、12自提仓口、A普通业务分支，无虚构自提配送车辆。 |
| T35 日期/筛选/图层不静默丢批次 | 已验证 | E6/E12状态与真实DOM；E17 CUA实际1440/1024/390无横向溢出，11月2日地图/日期均17票，关开交接点图层仍为计算200/筛选外183，计划与选单保持。全局批次不会自动塞入本车编辑，自提只读无虚构车辆。当前证据为本机/预览；最终线上版本另见T38。 |
| T36 旧 L4/L5 与缺字段迁移 | 已验证 | E9：15 项真实 SQLite 迁移/恢复回归通过。旧 L4/L5 拆为待补终点与附项，不猜未知终点；原 JSON、POD、SN 和委托可追溯；旧草案可读且重新核验。整库恢复撤销会话且不覆盖现有目标，故障整批回滚、重复执行、后续业务编辑保护、重启不覆盖新附项选择均有断言。范围为合成旧格式数据库；服务和浏览器初始化已接入，实际生产库仍须副本验收。 |
| T37 200导入/重复/坏行 | 已验证 | `test_sim200.test_all_cross_distributions_and_serial_conservation` / `test_real_sales_import_idempotent_and_dispatch_handoff` / `test_bad_row_reports_source_line_and_cannot_mutate` / `test_fixed_create_id_rejects_conflicting_retry`；E4 sales_import / sales_duplicate。 |
| T38 公开/本机正确V13入口 | 已验证 | `VersionAndRoad.test_binding`及E17本机健康；`browser-online.txt/jpg/json`为实际公开URL CUA观察：200/200已导入，“新建6票试排”6/6、240000分、采用后v2/已采用。GitHub Pages构建成功；公网为独立浏览器演练，本机完整包启用原生CP-SAT及四区域道路。 |
| T39 D未来补货建议/调拨实收 | 已验证 | E10 实际 stock_plan 低/基/高建议 1/3/5；3 SN 经独立批准、调拨、实收后目标库存才增加到3，批准/在途均不增库存，建议降为0。既有 `test_replenishment_and_age_across_transfer` / `test_unsold_position_requires_separate_signoff` / `test_short_wrong_code_never_increases_stock` 亦通过。范围为业务 API；资金/滞留成本综合测算界面未完整验收。 |
| T40 财务终态、费用与SN守恒 | 已验证 | E4：200主单终态、252唯一首交SN、8可用库存、20原SN回送结算；主单USD72,060、售后USD8,000；孤立预订/未关闭售后均0。范围为合成业务API，不把独立小样本道路算作同一200票全局优化。 |
| T41 海运延迟/暂扣/解除 | 已验证 | `test_supply.test_delay_only_unlocked_supply_dependent_orders`；E4 四海运批次 eta，SIM-OCEAN-2 hold / held_pickup_rejected / clear_hold，实际货源经入仓后才可分配。 |
| T42 实收短少/隔离/再配 | 已验证 | E10 对 SIM200-094 独立副本：manifest 3、实际收2（含合法替代）；原 SN 短少无实物、receipt 为 null；替代货损强制隔离且预留拒绝，QC放行后换配、签发、验放、签收并结算。`test_sim200_edges` 整链与幂等复跑通过。此为独立边界用例，不能把主200票证据库改写成已包含该分支。 |
| T43 崩溃/取消/迟到/幂等 | 已验证 | E15实际操作系统terminate子worker，等待真实45秒租约后重启，attempt2完成6/6、同键同job，46.17秒；E11旧租约线程晚成功/晚失败均不能覆盖新结果；Jobs取消/输入快照与E6恢复/丢响应重试通过。范围为本机持久队列故障恢复，不宣称跨主机分布式共识。 |
| T44 组合价改变最优选择 | 已验证 | `Selection.test_activation_cost_changes_actual_best_choice` 的两车共享日启用成本计一次，选中真实较低组合；非显示层修价。范围为已知小模型，复杂阶梯价/非线性合同仍须另测。 |

## 必须继续追踪的缺口

按上述证据范围，当前41项已验证、3项部分；此数量不代表通用生产能力或所有模型扩展已完成。

1. T07仍缺特定限高/单行道路负例逐段复核；T09仍缺两种浏览器宿主时区的完整对照；T15仍缺隔离D库存与跨仓替代候选联合选择。已有精确输入锁定及实际库存门禁不允许自行改SN/起仓。
2. 已验证能力有边界：T06仅同址授权取送，T30仅同执行方整SN终端换车；异址混收、部分SN、换承运商和新增费用不在这些入口范围。C1/C2/L5已有有限候选专项，复杂站场排队、通用取送全局搜索仍未宣称完成。
3. 200票真实路网、全路径联合选择、采用、正式签发尚未在同一输入快照下一次贯通。公开合成200票原生算例覆盖156/200，其余44明确未排；浏览器预算内算例154/200。200票业务终态、四区域道路样本、6票真实CP-SAT分别记录，不互相替代。
4. T29已有两票正式F04原子失败/并发重试，T43已有真实进程kill/restart，T36有15项备份迁移恢复；200票批量签发性能、全部二程批量组合、真实生产库副本迁移仍需单独验收。
5. 200项后端、22项前端通过；本机CUA三宽度及公网200导入、六票计算与采用已验证。公开页是各访客独立演练库，不是共享生产员工库。真实路网只覆盖提供的四城市小范围，不能据此宣称全国调度或全200真实路网全局最优。

本表应作为待办依据持续修订。最终对外说明应明确已交付能力与这些限制；公开演练只能使用合成数据。
