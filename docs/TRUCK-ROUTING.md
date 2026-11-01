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
