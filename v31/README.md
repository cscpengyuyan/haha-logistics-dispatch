# V3.1 公开演示站

这是 `v3/` 的静态公开演示版本，由 `v31-site/` 发布到 GitHub Pages 子目录。

- 本目录不包含 Node 服务端、SQLite、真实附件存储或真实客户数据。
- 打开后会自动进入演示账号（logistics 角色）。
- 地图、筛选、路线、批次保存在浏览器 localStorage；正式审核/承诺/派车/库存写操作已关闭。
- 真实业务请运行本地 `v3/src/server.mjs`，不要使用本静态站处理生产数据。
- 数据快照由 `v3/scripts/export-demo.mjs` 生成。
