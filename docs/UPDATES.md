# Rein 更新与在线服务

> 一页讲清「怎么发一版」「客户端凭什么信它」「服务器上有什么」。
> 相关代码：`server/`（服务端）、`scripts/release/`（发布工具）、`src-tauri/src/modules/update/`（客户端）。

## 1. 一句话模型

**服务端只分发，客户端只认同内置公钥签过名的字节。**

签名私钥只存在于两处：你本机的 `src-tauri/keys/`，和 GitHub Actions 的 Secrets。
服务器上没有任何可以签出「能装上的包」的东西 —— 它被拿下最坏的结果是拒绝服务，
而不是被投毒。这不是设计洁癖：一台同时跑着 QQ 机器人的公网机器，本来就不该是信任根。

## 2. 信任链（三道门，按顺序过）

| # | 验什么 | 用什么 | 不过会怎样 |
| --- | --- | --- | --- |
| 1 | 清单（`latest.json`）本身 | Ed25519(minisign) 签名，`latest.json.sig` | 整个源判为不可信，换下一个源 |
| 2 | 安装包摘要 | 清单里的 `sha256` + `size` | 删掉半成品，换镜像重下 |
| 3 | 安装包本体 | Ed25519(minisign)，**编译进二进制的公钥** | 拒绝安装（这一条是硬底线） |

补充两道：**下载前**比大小挡截断；**安装前**把第 2、3 条重跑一遍（磁盘上的文件下完之后仍可能被替换）。

第 1 条为什么要有：中间人可以改写清单里的版本号与摘要。第 3 条能挡住「装一个假包」，
但挡不住「把版本号改成 9.9.9 让你以为在升级」。另外客户端还记着「见过的最高版本」
（`lastSeenVersion`），发现清单比它低就标 `downgradeBlocked` —— 防回放旧版本。

## 3. 双源与回落

客户端内置两个源，按优先级依次取：

| 源 | 地址 | 清单签名 | 说明 |
| --- | --- | --- | --- |
| Rein 在线服务 | `http://47.100.36.179:8787/updates/latest.json` | 有 | 自建，国内直连快；明文 http 但安装包签名仍是硬校验 |
| GitHub Release | `https://github.com/gozaoo-coder/Rein/releases/latest/download/latest.json` | 有 | 官方出口，海外/备份路径 |

行为细节：

- 每个源都可能失败，失败只记在这次的报告里，不影响别的源（界面「更新源」卡片逐源显示）。
- **通道不符的源直接跳过**：清单里写了 `channel: beta` 的源不会喂给 stable 用户。
- 取版本号最高的那个可用条目；下载失败或验签失败时按 `mirrors` 顺序换地址重试。
- 断点续传：失败后保留下载到一半的 `.part`，下次从断点接着下（范围请求）。

## 4. 发一版（三条路）

### 4.1 本地发（推荐先跑通这条）

```bash
# 1) 一次性：生成签名密钥对（公钥自动写进 keys.rs / tauri.conf.json / 服务端配置）
node scripts/release/keygen.mjs

# 2) 构建产物
npm run app:build                 # Windows → src-tauri/target/release/bundle/nsis/*.exe
build-arm64.cmd                   # Android → src-tauri/gen/android/.../app-universal-release.apk

# 3) 发布（签名 → 组装清单 → 推服务端 + 发 GitHub Release）
node scripts/release/publish.mjs \
  --version 0.2.1 \
  --target windows-x86_64=src-tauri/target/release/bundle/nsis/Rein_0.2.1_x64-setup.exe \
  --target android-aarch64=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk \
  --notes-file RELEASE_NOTES.md \
  --to server,github

# 4) 以客户端视角复核一遍（验签 + 下载 + 摘要）
node scripts/release/verify.mjs --manifest http://47.100.36.179:8787/updates/latest.json
```

只发 GitHub（不推自建服务）：`--to github`。没配 `REIN_UPDATE_TOKEN` 时服务端会被自动跳过。

### 4.2 打 tag 让 CI 发

```bash
git tag v0.2.1 && git push origin v0.2.1
```

`.github/workflows/release.yml` 会构建 Windows NSIS 与 Android APK，然后跑同一份
`publish.mjs` 发布。需要的 Secrets 见 §7。

### 4.3 只镜像 GitHub 到自建服务

服务端提供了镜像接口（不需要在服务器上放私钥 —— 它会先验上游签名，再原样搬字节）：

```bash
curl -X POST http://47.100.36.179:8787/admin/api/mirror \
  -H "Authorization: Bearer $REIN_UPDATE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"channel":"stable","manifestUrl":"https://github.com/gozaoo-coder/Rein/releases/latest/download/latest.json","signatureUrl":"https://github.com/gozaoo-coder/Rein/releases/latest/download/latest.json.sig"}'
```

镜像来的版本 URL 被改写过，清单签名不再成立 —— 服务端会**不带**清单签名发布它，
客户端此时只依赖安装包签名（第 3 道门依然在）。

## 5. 清单格式

与 Tauri 的 static JSON 兼容（官方 `tauri-plugin-updater` 也能直接吃），扩展字段放外面：

```jsonc
{
  "version": "0.2.1",
  "notes": "…",
  "pub_date": "2026-09-19T07:15:02Z",
  "channel": "stable",
  "platforms": {
    "windows-x86_64": {
      "url": "http://47.100.36.179:8787/dl/stable/0.2.1/Rein_0.2.1_x64-setup.exe",
      "signature": "<minisign 签名文本（新版 CLI 即 base64 明文）>",
      "sha256": "…",          // Rein 扩展：摘要
      "size": 13107200,        // Rein 扩展：字节数
      "mirrors": ["https://github.com/…"],   // Rein 扩展：回落地址
      "name": "Rein_0.2.1_x64-setup.exe"
    },
    "android-aarch64": { "…": "…" }
  },
  "x-rein": { "generator": "rein-release", "source": "server", "repo": "gozaoo-coder/Rein" }
}
```

平台键沿用 updater 的 target 命名：`windows-x86_64` / `android-aarch64`（`platform_key()`）。
`signature` 字段的内容是 `.sig` 文件原文，**不要再套一层 base64** ——
新版 tauri CLI 的 `.sig` 文件本身已经是 base64(minisign 文本)，老版本是明文四行，两种客户端都认。

## 6. 服务端（Rein 在线服务）

部署在阿里云 ECS（47.100.36.179，Ubuntu，Node 22，systemd 单元 `rein-services`）。

```
/opt/rein-services/server      代码（部署脚本会保留上一版到 server.prev）
/etc/rein-services/config.json 配置（管理令牌、公钥、AI provider）
/var/lib/rein-services/        数据（安装包、清单、日志）
```

### 公开接口

| 路径 | 用途 |
| --- | --- |
| `GET /health` | 服务状态 + 各通道当前版本 + AI 网关状态 |
| `GET /updates/latest.json` | 默认通道清单（`.sig` 取伴随签名） |
| `GET /updates/{channel}.json` | 指定通道 |
| `GET /updates/{channel}/{target}/{current}` | 兼容 updater 的 `{{target}}` 占位写法 |
| `GET /dl/{channel}/{version}/{file}` | 安装包（支持 Range 断点续传、ETag） |
| `GET /keys/update.pub` | 更新公钥（客户端内置的是同一把，可核对） |
| `GET /api/v1/update/releases` | 发布历史 |
| `GET /v1/models`、`POST /v1/chat/completions` | 在线模型网关（见 §8） |

### 管理接口（`Authorization: Bearer <adminToken>`）

| 方法 + 路径 | 用途 |
| --- | --- |
| `GET /admin/api/state` | 全局状态（通道、数据量、公钥 keyId） |
| `POST /admin/api/artifacts/{channel}/{version}/{file}` | 上传安装包（原始字节流） |
| `POST /admin/api/releases` | 登记并发布（校验 sha256/签名，落清单） |
| `POST /admin/api/releases/{channel}/{version}/publish` | 把某版本设为当前（回滚） |
| `DELETE /admin/api/releases/{channel}/{version}` | 删除版本 |
| `POST /admin/api/mirror` | 镜像远端发布 |
| `POST /admin/api/ai/clients` | 签发模型网关客户端令牌（明文只返回一次） |
| `PUT /admin/api/ai/providers` | 配置上游 provider |

服务端**会**在自己这边重新校验一次安装包签名与摘要：签不过的包根本进不了目录。
保留最近 `keepVersions`（默认 8）个版本，自动清理旧包。

### 运维

```bash
systemctl status rein-services
journalctl -u rein-services -n 50 --no-pager
curl -s http://127.0.0.1:8787/health | python3 -m json.tool
```

重新部署：`node scripts/release/deploy-server.mjs`（幂等，配置与数据不动）。

**安全组**：入方向需要放行 TCP 8787（授权对象建议先只放自己的常用出口 IP，验证后再放开）。
端口没放行前，发布与校验收可以用 SSH 隧道：

```bash
ssh -N -L 18787:127.0.0.1:8787 root@47.100.36.179
REIN_UPDATE_UPLOAD_URL=http://127.0.0.1:18787 node scripts/release/publish.mjs …
node scripts/release/verify.mjs --manifest http://127.0.0.1:18787/updates/latest.json --via http://127.0.0.1:18787
```

## 7. GitHub Secrets / Variables

| 名称 | 用途 | 必需 |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | 更新签名私钥全文（`src-tauri/keys/rein-update.key`） | 是 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥口令（`rein-update.key.password`） | 是 |
| `REIN_UPDATE_TOKEN` | 服务端管理令牌；不配则只发 GitHub | 否 |
| `REIN_ANDROID_KEYSTORE_BASE64` | `src-tauri/rein-release.keystore` 的 base64 | 否 |
| `REIN_ANDROID_KEYSTORE_PASSWORD` / `REIN_ANDROID_KEY_ALIAS` / `REIN_ANDROID_KEY_PASSWORD` | 安卓发布签名 | 否 |
| `REIN_UPDATE_BASE_URL`（Variable） | 服务端公网地址 | 否 |

Android 那四个不配时，CI 仍会构建 APK 但**不带发布签名**（装了覆盖不上，只用于验证可编译）。

生成 keystore 的 base64：

```bash
base64 -w0 src-tauri/rein-release.keystore
```

## 8. 在线大模型 API（模型下发 · 服务密钥 · 双端成本）

服务端跑着一个 **OpenAI 兼容网关**，客户端凭服务密钥换模型清单：

- `POST /v1/chat/completions`（流式 SSE 透传）、`GET /v1/models`、`GET /api/v1/ai/usage`
- 未配置 provider 时返回 `503 ai_not_configured`，而不是假装成功
- 上游 provider 的 key 留在服务端，客户端设备上不再落明文 key
- 鉴权走客户端密钥（`POST /admin/api/ai/clients` 签发，配置里只存 sha256 摘要），
  且**密钥决定能用哪些模型**：`clients[].models` 白名单，越权直接 `403 model_not_allowed`
- **模型由服务端指定**：`GET /v1/models` 只列该密钥可用模型，并带 `rein` 扩展字段
  （`priceIn` / `priceOut` / `currency` / `unit`）与信封里的 `trafficPerGb` / `trafficScope`
- **成本两端各算一份**：服务端按真实 usage + 真实字节数记账（权威），
  客户端按同一公式记本机账本（`ai_usage`，离线可看），UI 里并排展示以便对账

计价口径（模型价与官方同价，服务端不溢价；流量默认只算出方向）：

```
模型费 = 输入 tokens/1e6 × priceIn + 输出 tokens/1e6 × priceOut
流量费 = 计费字节 / 1e9 × traffic.perGb          # 默认 0.8 元/GB
```

接入一台 provider：

```bash
curl -X PUT http://47.100.36.179:8787/admin/api/ai/providers \
  -H "Authorization: Bearer $REIN_UPDATE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"providers":[{"id":"ark","name":"火山方舟","baseUrl":"https://ark.cn-beijing.volces.com/api/v3","apiKey":"<key>","models":["doubao-seed-1-6-250615"],"enabled":true}]}'
```

签发客户端密钥（明文只出现这一次，直接填进客户端的「管理模型 → Rein 在线服务」）：

```bash
curl -X POST http://47.100.36.179:8787/admin/api/ai/clients \
  -H "Authorization: Bearer $REIN_UPDATE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"我的笔记本","models":["doubao-seed-1-6-250615"],"rpm":60}'
```

客户端侧：**管理模型**页顶部有「Rein 在线服务」卡 —— 填服务地址 + 服务密钥 → 拉清单 →
勾选导入，落库为 `source='online'` 的模型（地址、密钥、单价、流量价全部来自服务端，
不需要也不允许手填模型 ID）。同步时服务端已撤下的同源模型会被清掉，自己填 key 的模型不受影响。
卡片底部并排显示「本机累计（估算）」与「服务端累计（权威）」的成本，含模型费/流量费拆分。

价格表更新（不必重启）：

```bash
curl -X PUT http://47.100.36.179:8787/admin/api/ai/pricing \
  -H "Authorization: Bearer $REIN_UPDATE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"models":{"doubao-seed-1-6-250615":{"in":0.8,"out":8}},"traffic":{"perGb":0.8}}'
```


## 9. 已知取舍

- **自建源走明文 http**：没有域名与证书（国内域名要备案）。安全性由签名保证，不依赖 TLS；
  真要上 TLS，加个 nginx 反代即可，客户端地址换成 https 就行。
- **Ed25519 验签要把文件读进内存**（官方签名是预哈希模式，但 `minisign-verify` 的 API 要完整字节）。
  客户端设了 512MB 上限兜底；安装包几十 MB 量级，实际不是问题。
- **更新只对 Windows / Android 生效**：其余平台给出「复制下载地址手动装」的提示。
- **不自动重启到新版本以外的事**：Windows 由安装器 `/R` 重启；Android 交给系统安装器。
