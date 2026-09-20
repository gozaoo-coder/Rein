# Rein 在线服务（server/）

一台服务器干两件事：

1. **更新分发** —— 清单、安装包、发布/回滚/镜像接口（详见 [`../docs/UPDATES.md`](../docs/UPDATES.md)）
2. **在线大模型 API 网关** —— OpenAI 兼容的 `/v1/*`，上游密钥留在服务端，客户端凭签发密钥换模型清单；
   模型价按官方页价、服务器流量 0.8 元/GB，两端各记一份成本账（见下文「在线模型网关」）

零依赖（只用 Node 标准库），没有构建步骤：`git pull && systemctl restart` 就是全部部署流程。
这是刻意的 —— 它和 OpenClaw、QQ 机器人挤在同一台 2 核 1.6G 的 ECS 上，
任何 `node_modules` 都是对内存和升级路径的额外风险。

## 部署

从仓库根目录跑（会自己 scp + 装 systemd）：

```bash
node scripts/release/deploy-server.mjs                 # 默认 root@47.100.36.179
REIN_SSH_HOST=root@1.2.3.4 node scripts/release/deploy-server.mjs
```

幂等：重复执行即升级，`/etc/rein-services/config.json` 与 `/var/lib/rein-services/` 不会被覆盖
（只会把 `publicBaseUrl`/`port`/更新公钥对齐）。上一版代码留在 `/opt/rein-services/server.prev`。

手工部署（不想用脚本时）：

```bash
mkdir -p /opt/rein-services && cp -r server /opt/rein-services/
install -m 644 /opt/rein-services/server/deploy/rein-services.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now rein-services
```

## 配置

`/etc/rein-services/config.json`（首次安装自动生成，含随机管理令牌，权限 600）：

| 字段 | 说明 |
| --- | --- |
| `port` / `host` | 监听地址，默认 `0.0.0.0:8787` |
| `publicBaseUrl` | 清单里写出去的对外地址（客户端要能访问到的那个） |
| `adminToken` | 管理接口令牌；CI 里用 GitHub Secret `REIN_UPDATE_TOKEN` |
| `update.publicKey` | 发布方公钥（base64），发布时服务端据此验签 |
| `update.requireSignature` | true = 没签名的包一律拒收 |
| `update.keepVersions` | 每通道保留的版本数（默认 8，自动清理旧包） |
| `ai.providers` | 上游模型 provider（`baseUrl` / `apiKey` / `models` / `enabled`，可选 `hidden` / `fallback`） |
| `ai.clients` | 客户端令牌（只存 sha256 摘要）+ 该令牌可用的模型白名单 `models[]`（空 = 全部） |
| `ai.pricing` | 计价：模型价表（元/百万 tokens，官方同价）+ 流量单价与口径（见下） |
| `ai.autoModel` | `auto-model` 别名指向哪款模型（默认 `deepseek-v4.1-flash`；留空 = 不下发该别名） |
| `ai.rate` | 每令牌限流（`rpm` / `burst`） |

环境变量可覆盖端口等单值：`REIN_PORT` / `REIN_HOST` / `REIN_ADMIN_TOKEN` /
`REIN_DATA_DIR` / `REIN_CONFIG` / `REIN_PUBLIC_BASE_URL`。

## 在线模型网关：密钥、模型下发与计价

客户端（Rein 桌面/移动端）**必须带服务端签发的密钥**才能拿到模型：`GET /v1/models`
鉴权后返回「这个密钥能用哪些模型」，并把官方单价、流量单价一起下发；调用时模型不在
白名单内直接 `403 model_not_allowed`。客户端把 `baseUrl` 指到 `http://<服务端>/v1`
即可（OpenAI 协议），设备上不再落上游 provider 的 key。

签发一个客户端密钥（明文只出现这一次）：

```bash
curl -X POST http://127.0.0.1:8787/admin/api/ai/clients \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"我的笔记本","models":["deepseek-flash"],"rpm":60}'
# → {"ok":true,"token":"rein_sk_…"}   ← 填进 Rein 的「管理模型 → Rein 在线服务」
```

计价口径（模型价与官方同价，服务端不溢价）：

```
模型费 = 输入 tokens/1e6 × priceIn + 输出 tokens/1e6 × priceOut   （元）
流量费 = 计费字节 / 1e9 × traffic.perGb                          （元，默认 0.8 元/GB）
合计   = 模型费 + 流量费
```

| 字段 | 说明 |
| --- | --- |
| `ai.pricing.models["<模型名>"]` | `{ in, out }`，元 / 百万 tokens，照抄各家官方页价；可加 `cacheIn` 给缓存命中价 |
| `ai.pricing.default` | 未登记模型的价格（默认 0 = 只计流量费，不是免费而误报） |
| `ai.pricing.traffic.perGb` | 服务器流量单价，默认 `0.8` |
| `ai.pricing.traffic.scope` | `egress`（默认，只算出方向，同云厂商按流量计费）/ `ingress` / `both` |

DeepSeek 分时定价：配置里按**高峰时段**价预置（`deepseek-flash` 2/8、`deepseek-v4-pro` 9/27），
要按空闲价计就自行下调；价格以官网为准，改配置文件 + 重启，或用
`PUT /admin/api/ai/pricing` 热更新：

```bash
curl -X PUT http://127.0.0.1:8787/admin/api/ai/pricing \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"models":{"deepseek-v4-pro":{"in":4.5,"out":13.5}},"traffic":{"perGb":0.8}}'
```

账本与对账：

| 接口 | 谁看 | 内容 |
| --- | --- | --- |
| `GET /api/v1/ai/usage?days=7` | 客户端密钥 | 这个密钥的调用数、tokens、字节、**总成本**（服务端为权威口径） |
| `GET /admin/api/ai/usage?days=7` | 管理令牌 | 全局总量 + 按天 / 按模型 / 按令牌拆分，含模型费与流量费 |
| `GET /admin/api/ai/state` | 管理令牌 | 价目表 + 每个令牌最近 7 天的花费 |
| `GET /api/v1/ai/health` | 公开 | 是否就绪、provider 列表（含退路与冷却状态）、计价口径、`autoModel` |

明细落在 `data/logs/ai-usage-<日期>.jsonl`，每条含 `usage` 与 `cost`（`tokenCost` /
`trafficCost` / `total`），按天聚合时不再重新取价 —— 改价只影响之后的调用。

客户端那边同样按这个公式记一份本机账本（`ai_usage` 表），两边可对账；本机是估算，
服务端为准。

## 默认模型别名：`auto-model`

客户端不必知道后台在用哪家模型：`ai.autoModel` 指定一款模型，`/v1/models` 就会在清单
最前面下发一个 `auto-model`（`rein.auto = true` / `rein.target = 真实模型名`，单价照抄
目标模型），客户端拿它当默认项即可。后台换模型只改这一行，客户端与用户设置都不用动。

两条硬约束，都是为了不让别名变成绕过白名单的后门：

- **只在该令牌能用目标模型时才下发**：令牌白名单里没有 `ai.autoModel` 就不出现这个别名，
  调用它同样回 `403 model_not_allowed`；
- **目标模型必须挂在一个启用中的 provider 上**，否则不下发。

别名在服务端就地落定成真实模型名再转发，账本也记在真实模型名下（不会出现 `auto-model`
这条账）。`GET /api/v1/ai/health` 的 `autoModel` 字段能看到当前指向。

## 欠费兜底：`fallback`

上游账户级故障（欠费/超额）会持续到充值，干等只会让客户端一直报错。给 provider 配一条
退路，撞上这类故障时自动换一家：

```json
{
  "id": "ark", "name": "火山方舟", "enabled": true,
  "baseUrl": "https://ark.cn-beijing.volces.com/api/plan/v3",
  "models": ["deepseek-v4.1-flash", "glm-5.3-flash"],
  "fallback": {
    "providerId": "deepseek",
    "cooldownSec": 120,
    "models": { "deepseek-v4.1-flash": "deepseek-flash" }
  }
}
```

- `models` 是**模型名映射**：同一款模型各家叫法不同（方舟 `deepseek-v4.1-flash`，
  DeepSeek 官方 `deepseek-flash`），换家时必须改写模型名；
- 只有**账户级**故障才换（403/429 且报文含 `insufficient|balance|overdue|欠费|余额` 等，
  或 402）。参数写错、模型没开通这类换到哪都一样，一律原样透传，不烧备选额度；
- 撞上之后主上游进入 `cooldownSec` 秒冷却，期内直接走备选，不再每个请求都去撞一遍；
  冷却结束自动回来试，成功即恢复；
- 备选 provider 建议配 `"hidden": true`：它只做退路，不摆到模型清单里让用户直接挑；
- `GET /api/v1/ai/health` 的 `fallbackTo` / `coolingDown` 能看出退路是谁、此刻是否已经切走。

兜底调用按**备选模型**的单价计费，所以价格表里两个名字都要有（官方同价，只是叫法不同）。

## 目录

```
/opt/rein-services/server       代码
/etc/rein-services/config.json  配置（含管理令牌）
/var/lib/rein-services/         数据
  channels/<通道>/latest.json   当前清单（+ latest.json.sig）
  channels/<通道>/<版本>/        该版本的安装包与发布记录
  logs/                         访问与用量日志（jsonl）
```

## 常见命令

```bash
systemctl status rein-services
journalctl -u rein-services -n 50 --no-pager
curl -s http://127.0.0.1:8787/health | python3 -m json.tool
curl -s http://127.0.0.1:8787/admin/api/state -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 回滚到上一个版本（不重新上传字节）
curl -X POST http://127.0.0.1:8787/admin/api/releases/stable/0.2.0/publish \
  -H "Authorization: Bearer $TOKEN"
```

### 排障：管理接口 500 / `EROFS ... config.json.tmp-…`

**症状**：`/health` 一切正常、模型也能用，但任何**写配置**的管理接口（签发客户端密钥
`POST /admin/api/ai/clients`、热更新价目表、改 provider）都回 500，错误里带
`EROFS: read-only file system` 或 `EACCES`，路径是 `/etc/rein-services/config.json.tmp-…`。

**成因**：配置是运行时可改的，而写入是「同目录建临时文件 + rename」。两道门都可能挡住：

1. systemd 单元 `ProtectSystem=strict` 只放行了 `/var/lib/rein-services` →
   `/etc/rein-services` 对进程只读。需要 `ReadWritePaths=/var/lib/rein-services /etc/rein-services`。
2. 文件/目录权限是 `640 root:rein` + `755 root:root` → `rein` 用户读得到、写不进去。
   需要目录 `775 root:rein`、文件 `664 root:rein`（只对 rein 组开放，别人读不到管理令牌）。

**修**：两者都已在 `deploy/install.sh` 与 `deploy/rein-services.service` 里修好，
在本地跑一次 `node scripts/release/deploy-server.mjs` 即会重装单元、放权限、重启服务。
只想手工改的话：

```bash
sed -i 's#^ReadWritePaths=.*#ReadWritePaths=/var/lib/rein-services /etc/rein-services#' \
  /etc/systemd/system/rein-services.service
install -d -o root -g rein -m 775 /etc/rein-services
chown root:rein /etc/rein-services/config.json && chmod 664 /etc/rein-services/config.json
systemctl daemon-reload && systemctl restart rein-services
```

线上体检（会临时签发一把密钥、跑完目录/对话/流式/用量，然后删掉它）：

```bash
node scripts/verify-online.mjs
```

## 自测

```bash
node scripts/release/e2e.mjs        # 起临时服务端，跑完发布→验签→下载→篡改必拒
```

## 安全边界

- **服务端不持有签名私钥**。它只能分发别人签过名的字节，被拿下不等于能投毒更新。
- **以专用非特权用户 `rein` 运行**，且 capability 全清零
  （`User=rein` + `CapabilityBoundingSet=` 空）：服务只需要读代码、写数据目录，
  8787 > 1024 不需要绑定特权端口。审计前后的实测对比见 `docs/SERVER-SECURITY.md`。
- 管理接口只认 Bearer 令牌（定时安全比较）；上传路径逐段校验通道/版本/文件名，拒绝路径穿越。
- systemd 加固：`NoNewPrivileges` / `CapabilityBoundingSet=`（空）/ `ProtectSystem=strict` /
  `ProtectHome` / `PrivateTmp` / `RestrictAddressFamilies` / `MemoryMax=320M`
  （这台机器还要养 OpenClaw 与 QQ）。
- 明文 http 是有意为之（没有域名与证书），安全性由安装包签名保证 —— 详见 `docs/UPDATES.md` §9。
  要上 TLS 就在前面加一层 nginx 反代，客户端地址换 https 即可。
