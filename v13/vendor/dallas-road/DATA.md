# Dallas 公共演练路网

本目录使用 valhalla-browser 0.2.1、Valhalla 3.8.3 和 OpenStreetMap。路网以独立 gph 瓦片在本域按需加载。区域限于经度 −96.94 至 −96.73、纬度 32.73 至 32.88，覆盖 Dallas 市区的一部分。仓和客户为虚构练习点，正式卸货入口须另行核实。

2026-10-31 的 Dallas 数据来自 [BBBike](https://download.bbbike.org/osm/bbbike/Dallas/Dallas.osm.pbf)。[发布所用区域 OSM PBF](dallas-20261031/source.osm.pbf) 和派生路网按 ODbL 1.0 提供。© OpenStreetMap contributors。[许可与署名](https://www.openstreetmap.org/copyright)

每次试排按当前车辆的轴荷、总重、长宽高计算道路，随后在 1 至 6 站的小队列中枚举满足载重、停靠作业、班次和完工窗的顺序，以行驶时间最短者绘图。时间不含实时交通信息。正式服务使用 Valhalla 货车矩阵和 VROOM，另行核验人员、包装、服务证据和各票状态。

浏览器 SDK 源自 [valhalla-wasm](https://github.com/tobilg/valhalla-wasm)。本发布保留 dist/licenses/、NOTICE.md 和 LICENSE。针对静态托管对 worker.js 做了一处适配。完整瓦片的响应读完后按 manifest 中的 SHA-256 校验。分段下载仍核对原强 ETag 和 Content-Range。本版本使用 individual-tiles，未部署 indexed-tar。
