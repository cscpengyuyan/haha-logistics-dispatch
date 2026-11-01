# V12 网页部署与回退

[公开演练](https://cscpengyuyan.github.io/haha-logistics-dispatch/v12/#dock) 的数据保存在每位访客自己的浏览器内。员工服务由同一份代码启动，登录后各岗位读写同一个 SQLite 库。业务人员只需要自己的 HTTPS 地址和分配的账号。

## 在公司主机启用

1. 运营方提供持久卷、域名及 HTTPS 反向代理。将源码放在非 Web 静态宿主目录，数据库和备份目录放在站点目录以外，仅服务账号可读写。使用一个应用实例。
2. 用 Python 3.11 或更新版本运行以下命令。按相同步骤为 warehouse、dispatch、driver、finance 等岗位创建独立账号。
   ```sh
   python server.py --db /srv/haha-data/production.sqlite3 add-user lead --name 试点主管 --role admin
   ```
3. 将域名指向反代并配置 TLS。以下域名为配置占位符。使用 Caddy 时，站点内容为 `logistics.example.com { reverse_proxy 127.0.0.1:8765 }`，实际 Caddyfile 把两个花括号之间的指令独立放一行。保持原始 Host。在反代上限制上传体积和请求频率，保留 Range、Content-Range，禁用对 pmtiles 的整文件压缩。
   ```sh
   python server.py --db /srv/haha-data/production.sqlite3 --port 8765 --behind-https --public-host logistics.example.com
   ```
4. 将这个域名的根链接发给同事。根路径进入隔离访客演练。左侧「员工登录」进入 `/v12/#dock`。共享服务会拒绝未登录的业务请求。公司域名的浏览器演练与员工工作库分开；GitHub Pages 只部署演练。
5. 配置 HH_VALHALLA_URL、HH_VROOM_URL 和 HH_ROAD_COVERAGE，再重启服务并验证两组地址。两个 URL 指向公司管理的 HTTP 服务，普通访问者无需申请 key。配置细节、车型字段、底图范围与拒派条件见 [调度部署](TRUCK-ROUTING.md)。
6. 可用随附的 `road_host.py` 在同机回环端口提供两种接口。创建独立虚拟环境，安装 `pyvalhalla==3.8.3 pyvroom==1.15.2`。以 Valhalla 配置文件和完整区域路网启动 `python road_host.py valhalla.json --port 18802`。演练源码中的 6 个市区瓦片也可用于小范围验收，原生配置须将 mjolnir.tile_dir 指向包含 0/1/2 三级子目录的 tiles，禁用 tile_extract 和远程 tile_url。生产区域由运营方明确。SQLite、路由进程及反代由运营方的系统服务管理器守护，另安排数据库快照及恢复演练。

## 数据迁移

先停止旧库写入，再做预检、备份和还原到新路径。旧库继续留存。不要把 V8 的 workspace 全量快照作为员工共享库写接口。

```sh
python maintenance.py preflight /srv/haha-data/old.sqlite3
python maintenance.py backup /srv/haha-data/old.sqlite3 /srv/haha-backup/before-v12.sqlite3
python maintenance.py restore /srv/haha-backup/before-v12.sqlite3 /srv/haha-data/upgrade.sqlite3
```

用新代码对恢复副本启动一次，核对订单、SN、附件、历史、角色及拆分承运记录。模式标识须匹配。旧在途单如缺承接依据，按预检清单人工复核。V8 单票可通过既有订单导入接口关联旧号，历史费用、授权和 POD 不能由导入自动认定。回退时停写，记录升级后新增事件，用旧代码和未改动的升级前备份启动，再逐条对账。浏览器演练第一次载入旧库时在同一 IndexedDB 留下升级前快照。使用手册提供演练重置。

## 验收入口

- 员工服务回归可运行 `python -B -m unittest discover -s tests -v`。真实路网回归需要另设 HH_LIVE_DFW=1 和两个服务 URL。
- 桌面与手机浏览器回归使用 Playwright 和 Edge。运行 `node tests/ticket-desk-browser.cjs`、`node tests/dfw-browser.cjs` 和 `node tests/station-browser.cjs`。
- 浏览器独立模式和员工共享模式均使用同一套 Python 领域规则。机房网络、真实员工设备和运营合同数据须由公司部署后验证。
