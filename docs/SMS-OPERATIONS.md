# 员工配送短信

公开演练用虚构号码模拟送达，费用为零。员工库可以登记预约、预览正文和撤销预发。只有已配置 HTTPS 接口、独立发送进程及有效发送身份的员工服务可以提交收费短信。

## 运营配置

1. 在 Twilio 账户中为目标国家或地区配置可用、已完成相应注册的 SMS 发送号码。核实套餐、短信分段、运营商附加费，并保留联系人许可、用途及撤回凭据。
2. 在员工 HTTPS 服务和专用 worker 的受控进程环境中配置以下变量。账户令牌仅由两个服务进程读取，不写入工作库、Git、前端或请求日志。

| 变量 | 内容 |
|---|---|
| `HH_SMS_LIVE` | `1` 启用正式通道，默认关闭 |
| `HH_SMS_PUBLIC_ORIGIN` | 员工服务对 Twilio 公网可达的准确 HTTPS 源，如 `https://dispatch.example.org`，不含路径 |
| `TWILIO_ACCOUNT_SID` | SMS 账户 SID |
| `TWILIO_AUTH_TOKEN` | 账户认证令牌，也用于验证 Twilio 回调 |
| `TWILIO_FROM_NUMBER` | 上述账户获准发 SMS 的 E.164 号码 |

3. 为该号码配置入站 POST 到 `{HH_SMS_PUBLIC_ORIGIN}/api/twilio/incoming`。共享 HTTPS 服务的反代应保留 Host，使上述源与对外地址一致。发件请求会逐条指定 `/api/twilio/status/{job}` 作为送达回执。入口以外部完整 URL 和所有表单字段验签，并核对账户、发送身份或对应的消息 SID。
4. 启动共享服务完成数据库迁移，再用低权限服务账号运行以下 worker，指向同一员工 SQLite 库。程序需要到 Twilio 的 HTTPS 出站连接，以及正确的 UTC 系统时钟。保持进程常驻。

```sh
python sms_worker.py --db /private/dispatch/production.sqlite3
```

## 一条通知的处理

调度在「预约与短信」保存许可和窗口，把通知责任人填为实际员工登录名。该员工预览本条预约版本、收件人、时区、当地执行时间与全文，再点「明确授权此条付费短信到时发送」。仅生成预发或查看页面不会触发投递。

任务在本地保存到可发送时刻。每次提交前复核预约、订单、员工身份、许可、退订、静默时段和每日三条频控。改约后，新版预发需重新授权。错过授权时段十五分钟转人工。运营方停用发送时先停止 worker，并在两个进程取消 `HH_SMS_LIVE` 后重启。

每个作业只允许一次网络提交。超时或进程停止时存在供应方已经受理的可能，作业转人工。员工可在 Twilio 控制台根据相关时间和收件人核对，待签名回调关联 SID。送达回执只更新短信状态。客户回复需要人工确认具体票与约定。STOP 按号码抑制未来任务，服务商失败码和客户改约请求留在通讯工作台。即时提交的消息进入运营商网络后可能无法撤回。

实现与计费依据可查 [Twilio Message API](https://www.twilio.com/docs/messaging/api/message-resource)、[Twilio webhook 验签](https://www.twilio.com/docs/usage/webhooks/webhooks-security) 和 [美国 SMS 费率](https://www.twilio.com/en-us/sms/pricing/us)。正式运营需另行实证首条已获许可的付费投递、回执与账户实际费用。
