# 调度路网和达拉斯试点

## 地图和可算路范围

地图用 Leaflet 保留订单点、仓点、订单池和选中状态。MapLibre GL 5.7.1 在同一地图实例内渲染达拉斯街道、道路名称、水体、建筑和城市。浏览器从当前站点读取 Protomaps 2026-10-31 的试点归档、Noto Sans 标签字形和渲染器。全美概览使用项目原有 Census 州界、地名与主干路数据。美国主干路概览覆盖范围大于 DFW 街道底图和已验证货车路网。

Protomaps 归档范围是西经 97.12 至 96.65、北纬 32.68 至 32.98，包含 557 个瓦片，原生层级 7–14。单块请求失败保留已加载区域，可以点「重试街道底图」。自托管时对 `v12/vendor/basemap/dfw.pmtiles` 的 Range GET 应答 206 和正确的 Content-Range，禁止由反代压缩整个归档。当前应用、档案与字形同源。若运营方改为独立域名，须同步配置浏览器 CSP、允许 GET / HEAD 与 Range 的 CORS 及 Content-Range 暴露策略，并复测。

底图下载和署名见 [Protomaps 下载说明](https://docs.protomaps.com/basemaps/downloads) 和 [OpenStreetMap 版权说明](https://www.openstreetmap.org/copyright)。样式、符号和前端许可随 `v12/vendor/basemap` 发布。切图使用官方 go-pmtiles 1.31.2。提取命令如下。

```sh
pmtiles extract https://build.protomaps.com/20261031.pmtiles dfw.pmtiles --bbox=-97.12,32.68,-96.65,32.98 --minzoom=7 --maxzoom=14
pmtiles verify dfw.pmtiles
```

## 运营方配置

在共享 Python 服务进程的环境中设置三项值。浏览器不接收服务地址或密钥。

| 变量 | 用途 |
| --- | --- |
| HH_VALHALLA_URL | 运营方自管端点，支持 POST /sources_to_targets、POST /route 与 GET /status |
| HH_VROOM_URL | 运营方自管 VROOM HTTP 端点，支持 POST / 和按车型指定传入矩阵 |
| HH_ROAD_COVERAGE | 运营方实际导入且经过验证的路网范围说明，展示给调度 |

同主机回环服务可用 HTTP。跨主机应通过受控私网或带 HTTPS 的反向代理，限制只有业务服务器能访问。修改地址或路网覆盖后重启共享服务并重跑两组 DFW 验收。本项目支持 [Valhalla 货车矩阵](https://valhalla.github.io/valhalla/api/matrix/)、[Valhalla 道路几何](https://valhalla.github.io/valhalla/api/route/api-reference/) 和 [VROOM 自定义矩阵](https://github.com/VROOM-Project/vroom/blob/master/docs/API.md)。

进入「地图调度」，选仓、勾票，在「车辆、班次及逐段承运依据」选择司机、车组和车辆，登记装卸及约窗。共享演练的调度岗可点「装入达拉斯三站」直接得到合成输入。点「规划货车路线」按车组能力排序。需要按指定站序行驶时，拖动或用上下箭头调整，再点「按当前站序重算」。保存后在原单 F04 核对凭据并签发，可继续在仓口按签发版验放。

正式路线使用车长、车宽、车高、总重、轴荷计算货车时距矩阵。VROOM 以已核停靠点、台数、重量、直立托盘占用地板长度、工具技能、班次和作业窗求解。装载保守地为每票划整排，同一票可横向并列，禁止叠放、拼占另一票的地板行。包装高宽、托位、尾板核载、人员和工具均需匹配。预约若要求完成交付，填「合同最晚完工」。物业最晚开工另列。道路路线再次按最终站序取得。开工、完工和返仓／班次由共享库复核。施工、低桥、门禁和未登记的 OSM 限制须由车组据实复核。

本地草案、仅显示直线的记录、旧 OSRM 驾车参考和 Dallas 固定双站缓存均保留来源；它们不能按地图路线确认派车。历史人工承运单仍可按原逐段承运凭据独立核验，不会生成道路规划结果。路线失效后仍能查阅订单和草案。共享库拒绝不存在的道路结果，签发时检查资源版本、订单版本、服务状态及一小时有效期。

## 复测

```powershell
python -m unittest discover -s tests -p test_road_service.py -v
$env:HH_LIVE_DFW='1'
$env:HH_VALHALLA_URL='http://127.0.0.1:18802'
$env:HH_VROOM_URL='http://127.0.0.1:18802'
python -m unittest discover -s tests -p test_road_service.py -v
node tests/road-map-browser.cjs
```

上面的回环端口是本次验收的服务地址；应先部署相应路网服务。第一条运行供应商协议、角色权限、入口精度、伪造计划、改约、未接网和旧版草案门禁测试。启用真实 DFW 服务后，另外覆盖两组三站、锁定手工反序、完整几何及草案恢复。共享演练和真实员工服务各自使用独立 SQLite 库。所有验收地址、仓、车、员工名、货物和客户均为演示数据，不对应经过现场验证的真实客户。

## 本次覆盖验收与扩容

2026-11-01 以《TIGER/Line 2025 Primary Roads》公路中心线选取 50 州和 DC 各一对非私人道路坐标，TX 采用本票的达拉斯演练路口。每州两点在同州同一路段；四组额外检查为 TX–OK、NJ–NY、夏威夷跨岛、AK–本土。样点不是客户仓址、实地验过的装卸入口或车辆通行保证。坐标见 `tests/road-sample-pairs.json`，请求结果见 `docs/verification/road-coverage.csv`。一组计算成功只能说明样本覆盖。

当前现有 Dallas 数据日期为 2026-10-31。本次直接向本机运营方图发出 55 个 Valhalla 3.8.3 truck 请求，TX 市内 1.7175 英里，其余 54 组无匹配道路，未通过全国货车服务验收。跨海或须穿越加拿大的任务可保存草案，在业务服务器另行拦截签发。AK 州内、HI 同岛现阶段仍缺已部署的货车图。图源 OSM 在项目中按 ODbL 署名，图构建、持久卷、备份、传输费用由运营方承担。

两个地图的「范围」均可选美国全国、48州、AK、HI、当前仓和全线。默认使用本地 Census 州界、Dallas PMTiles。浅色样式省略地类和建筑，以低对比度绘制道路。另可主动选用 [OpenFreeMap 官方全国街道和浅色样式](https://openfreemap.org/quick_start/)，浏览器仅向图源请求视野瓦片、图标和字形。在线样式依赖图源网络；加载失败时可重试或切回本地。业务算路始终使用独立货车引擎，底图不能用于派车放行。

**运营方更换图数据**

1. 在另一个有持久盘的 Linux 主机建立单独的版本目录。下载 [Geofabrik US](https://download.geofabrik.de/north-america/us.html) 的固定日期美国 PBF 并校验发布校验和，确认含 AK、HI、DC。2026-10-31 快照的压缩 PBF 约 11.4 GiB，建图临时文件、大于源数据的图及前版备份另计。可选用多个州合并，但须在同一次构建中保留跨州拓扑。
2. 在新目录生成与运行服务同版本的 Valhalla 配置和图。以下命令在已安装对应版本的 Valhalla CLI、pyvalhalla 和 pyvroom 的新版本目录执行。仓库内 `road_host.py` 使用本机绑定，无公网业务数据端口。

   ```sh
   valhalla_build_config --mjolnir-tile-dir "$PWD/tiles" --mjolnir-tile-extract "$PWD/graph.tar" > valhalla.json
   mkdir -p tiles
   valhalla_build_tiles -c valhalla.json us.osm.pbf
   valhalla_build_extract -c valhalla.json
   export HH_ROAD_DATA_DATE=2026-10-31
   export HH_ROAD_COVERAGE='US OSM candidate; verification pending'
   python /srv/haha/road_host.py valhalla.json --port 18803
   ```

3. 从应用所在的主机运行采样，保留服务版本、与 PBF 对应的日期、几何及英里数。分别检查跨海/跨境禁发，复测两组 Dallas 三站、排程、断网、可写草案和重新签发。当前 Windows 本机没有构建或托管全国图。

   ```sh
   python tests/probe_truck_coverage.py --base http://127.0.0.1:18803 --out coverage-candidate.csv
   ```

4. 合格后将业务进程 `HH_VALHALLA_URL` 与 `HH_VROOM_URL` 指向已验证的新端口，同时登记 `HH_ROAD_DATA_DATE` 和实测 `HH_ROAD_COVERAGE`。保留旧图、旧服务及上次采样报告。回滚时将两个 URL 与图日期/覆盖说明一并切回上一版，再复测后重新计算待签路线。请勿将公共测试路由端点用作生产依赖。

本地无痕 Edge 通过 `node tests/map-interaction-browser.cjs` 发送真实滚轮和 Chromium 双触点，检查两个入口的缩放及图层、视野和底图保存。部署后可设置 `HH_PUBLIC_MAP_URL` 为以 `/v12/` 结尾的 HTTPS 地址再跑同一组。该测试验证触屏输入事件，不等同于真机手指操作。
