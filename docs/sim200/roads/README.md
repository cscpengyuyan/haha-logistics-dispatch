# 四地区真实道路集成证据

本目录记录原生 Valhalla 3.8.3 与 VROOM 的实际执行结果，与 `../acceptance/` 中使用受控承运依据的业务演练分开。没有把直线连线或预计算回放记作道路求解。

| 地区 | 订单点数 | 不重复吸附点（含仓站） | 方向矩阵对数 | 非对称点对 | 最大吸附距离 |
| --- | ---: | ---: | ---: | ---: | ---: |
| DFW | 120 | 36 | 1296 | 619 | 35.5 m |
| Houston | 30 | 31 | 961 | 457 | 88.3 m |
| Los Angeles | 30 | 31 | 961 | 442 | 53.2 m |
| Atlanta | 20 | 21 | 441 | 207 | 48.1 m |

四地区共 3,659 对距离/行时均有非负有效返回。每地区实际计算一条三段含回程路线并返回几何，VROOM 使用同一真实矩阵将两项任务分配给两台容量各为 1 的物理车，均无未分配项。`*-native.json` 保存原始请求选项、完整矩阵、路线及 VROOM 输入输出；`road-integration.json` 保存版本、耗时、哈希及汇总。车型为长 8 m、宽 2.5 m、高 3.5 m、总重 10 t、轴荷 6 t。

`coordinate-snap-map.json` 保存 200 订单及 8 仓站的原网格点、道路吸附点、偏移距离、OSM way ID 与街道名称。原业务演练记录未被覆盖。吸附至道路只证明该位置对应 OSM 货车可达边，不代表客户入口、月台、停车权限已实地核验。

数据与构建文件在 `data/road-sim200/`：

- Houston 来自公开 Kumi Overpass 实际返回，OSM 基准为 `2026-07-24T11:04:51Z`，没有冒充最新路网。
- Los Angeles、Atlanta 来自 `overpass-api.de` 的较小道路范围查询，基准为 `2026-11-01T15:30:32Z`。
- DFW 使用已有本地道路图，源数据日期没有可靠记录，明确为未知；配置哈希用于追溯。
- 三地 `.source.json` 保存边界、真实来源、节点/道路数与 SHA256；`.osm.pbf`、`*-graph/`、`*-build.log` 保留构建材料。数据遵循 OpenStreetMap/ODbL 来源要求，署名 OpenStreetMap contributors。

多图服务：

```powershell
python -X utf8 road_host.py --regions data/road-sim200/regions.json --port 18803
```

需使用已安装 Valhalla / VROOM 的 Python 环境。`HH_VALHALLA_URL` 与 `HH_VROOM_URL` 均指向 `http://127.0.0.1:18803`。服务仅监听本机；`/status` 报告四个真实边界、各图日期和引擎版本；所有路线或矩阵点必须落在同一地区，否则返回 422，禁止把互不连通的城市小图伪装成跨城道路。

`multi-region-http.json` 另存四地区真实 HTTP 矩阵与回程的 8 项返回，以及 DFW→Houston 跨区域请求被 422 拒绝的证据。`tests/test_road_regions.py` 的 3 项测试覆盖同图选择、跨图拒绝与非法坐标。

复现构建和核验：

```powershell
python -X utf8 scripts/build_sim200_roads.py --base-config <原生Valhalla配置路径> Houston Los_Angeles Atlanta
python -X utf8 scripts/verify_sim200_roads.py --dfw-config <DFW配置路径>
```

这是一组城市小范围道路验收图，未包含实时交通、完整跨城路网、地方临时限行许可或权威运营数据。该证据不等于 200 票全流程已采用真实道路全局优化；业务、求解器和浏览器各自的完整验收需分别核对。
