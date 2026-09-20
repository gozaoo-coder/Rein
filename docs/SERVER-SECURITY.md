# Rein 服务器安全审计（2026-09-19）

对象：阿里云 ECS `47.100.36.179`（Ubuntu 26.04 LTS / kernel 7.0.0-29，2 vCPU / 1.6 GiB）。
角度：**提权与横向移动** —— 假设某个服务被拿下，看看它能走到哪一步。

复现：把审计脚本传上去跑一遍即可（只读，不改任何东西）：
`scp scripts/…/sec-audit.sh root@47.100.36.179:/tmp/ && ssh root@47.100.36.179 'bash /tmp/sec-audit.sh'`

## 1. 这台机器上跑的是什么

| 组件 | 运行时 | 身份 | 监听 |
| --- | --- | --- | --- |
| Rein 在线服务（本仓库 `server/`） | **Node 22，零依赖（node:http，无框架）** | `rein` (uid 999) | `0.0.0.0:8787` |
| OpenClaw 网关 | Bun 1.4.2 | root | `127.0.0.1:18789`（正确，走隧道访问） |
| NapCat / QQ | 自带 Electron | root | `*:6099`（**所有接口**） |
| Immich 反向隧道 | sshd 转发 | - | `0.0.0.0:2283/2284`（有意为之） |
| office-toolkit 技能 | Python 3.14 | root | 无 |

没有 Docker、没有 nginx。所以「框架」这个词在这里有两层答案：
**Rein 在线服务本身是零依赖 Node 标准库**（刻意不引 express，见 `server/README.md`）；
整台机器则是「systemd + 各语言运行时各自直跑」的形态。

## 2. 已修复（本次改动，均已验证）

### 2.1 Rein 在线服务：从 root 降到专用非特权用户 ⚠️ 本次最重要的一项

审计实测（修复前）：

```
Name: node   Uid: 0   CapEff: 000001fff7fcffff   NoNewPrivs: 1
```

原 unit 只写了 `NoNewPrivileges=true` —— 它只阻止**新增** capability，
进程从 root 继承来的整整一套（含 `CAP_SYS_ADMIN`）原封不动。也就是说
Node 侧任何一个 RCE（HTTP 解析、JSON、将来任何依赖）都是**完整 root，无需提权**。

修复后：

```
Name: node   Uid: 999(rein)   CapEff: 0000000000000000   CapBnd: 0000000000000000
```

- `User=rein` / `Group=rein`（系统用户 + `nologin`，不是可登录账号）
- `CapabilityBoundingSet=` + `AmbientCapabilities=` 显式清空（空值 ≠ 不写）
- 追加 `RestrictAddressFamilies` / `RestrictNamespaces` / `LockPersonality` / `ProtectClock`
  / `ProtectHostname` / `ProtectKernelLogs` / `RemoveIPC`
- `/var/lib/rein-services` 归 `rein`；`/etc/rein-services/config.json` 改 `root:rein 640`
  （原本 `root:root 600`，服务读不到就得提权，现在两边都满足）
- 8787 > 1024，不需要任何 capability —— 清零不影响绑定端口

改动落在 `server/deploy/rein-services.service` 与 `server/deploy/install.sh`，
所以**下次部署也会保持降权**，不会因为手工修过而回退。

### 2.2 部署残留

`/tmp/rein-server-stage` 里躺着整份代码副本（/tmp 全局可读）。已删除，
并让 `install.sh` 在安装结束时自动清理暂存目录。

### 2.3 网络参数加固

`/etc/sysctl.d/99-rein-hardening.conf`（单网卡 ECS，安全）：

| 项 | 改前 | 改后 |
| --- | --- | --- |
| `net.ipv4.conf.all.accept_redirects` | 1 | **0** |
| `net.ipv4.conf.all.rp_filter` | 0 | **1** |
| `accept_source_route` / `send_redirects` / `secure_redirects` | 未设 | 0 |
| `icmp_echo_ignore_broadcasts` / `icmp_ignore_bogus_error_responses` | 未设 | 1 |

### 2.4 sshd 收敛（**未动认证方式**）

`/etc/ssh/sshd_config.d/98-rein-hardening.conf`：`X11Forwarding no`、`AllowAgentForwarding no`。
agent 转发是横向移动的常见跳板，无头服务器不需要；改完 `sshd -t` 校验通过才 reload。

刻意**没有**动 `PasswordAuthentication` 与 `PermitRootLogin` —— 见第 3 节。

### 2.5 密钥登录已铺好

已生成 `~/.ssh/rein_ecs`（Windows 侧）并把公钥追加进服务器 `authorized_keys`
（保留原有 `wsl-immich-tunnel` 条目，**追加不是覆盖**）。
已验证：`ssh -i ~/.ssh/rein_ecs -o PasswordAuthentication=no root@47.100.36.179` 可免密登录。
这是「敢不敢关口令登录」的前置条件。

### 2.6 源码里的真实口令（本次审计最该修的一条）⚠️

审计时按「已知口令」在仓库里反查，命中两处 —— **服务器 root 口令同时也是校园教务口令，
而它被硬编码在即将入库的源码里**：

| 文件 | 形态 |
| --- | --- |
| `modules/campus/http.rs`（单测 `rsa_matches_jsencrypt_layout`） | 真实口令作为 RSA 加密的测试输入 |
| `modules/campus/provider.rs` | 注释里为了让「不做 trim」这条经验具体，把口令原样写了进去 |

这条比 3.1 更要紧：3.1 是「口令弱、可被爆破」，这条是**口令一字不差地写在代码里**，
而仓库是要推到 GitHub 的。

处置：
- 两处都换成合成值（`synthetic-passphrase.` / 全零 GUID），保留测试原意
  （断言的是密文长度 172 字符、128 字节，PKCS#1 v1.5 会补齐，换任何输入都成立）；
- `provider.rs` 的注释改为记录经验本身（「结尾句点是口令的一部分，不做 trim」）而不再复述口令，
  并注明联调走 `REIN_GUET_USER` / `REIN_GUET_PASS` 环境变量（项目里本来就是这么做的）；
- `cargo test --lib campus::http` 复跑通过（4 passed）。

**影响面已确认可控**：`campus/` 整个模块是未跟踪目录，`git log --all -- src-tauri/src/modules/campus`
为空、`git grep` 无命中 —— 也就是说**这段口令从未进入 git 历史**，不需要改写提交历史，
只需（也必须）在下次 `git add` 前改掉。已复查全仓库无其他残留。

> 顺带一提：这台服务器的口令、教务口令、以及可能的其他系统共用同一个串。
> **一处泄露即处处泄露** —— 这比口令本身弱更要命。见 3.1 的方案 C。

## 3. 待决（需要你拍板，我没有擅自动）

### 3.1 SSH：root + 口令登录 + 口令本身是弱口令 🔴 **当前最高风险**

> **处置决定（2026-09-19）：暂不改动，只记录在案。** 密钥已铺好并验证可用，
> 所以将来要关只需一条命令（见文末），不必重新准备条件。

```
permitrootlogin yes          passwordauthentication yes
maxauthtries 6               logingracetime 120
```

口令强度不足：它由「用户名 + 手机号」派生，长度够但可被社工直接推测
（具体口令不在此文档记录 —— 本文件入库，任何口令/token 都不该写进来）。

近 7 天日志：失败口令尝试 7 次（来自 5 个不同 IP，是常规扫描强度），成功登录 204 次
（其中 183 次来自你自己的 182.91.47.73）。**没有入侵迹象**，但 22 端口确实在被扫，
弱口令 + root 直登的组合迟早会中。

将来要收紧时（按强度）：

```bash
# 方案 A：关门令登录，只认密钥（最强；已具备条件，随时可执行）
printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\n' \
  > /etc/ssh/sshd_config.d/97-rein-no-password.conf
sshd -t && systemctl reload ssh

# 方案 B：保留口令登录，只收紧重试窗口（不改变登录方式，不会锁死）
printf 'MaxAuthTries 3\nLoginGraceTime 30\n' \
  > /etc/ssh/sshd_config.d/96-rein-rate.conf
sshd -t && systemctl reload ssh

# 方案 C：换口令（需要先从阿里云 VNC 或已登录会话改）
#   —— 优先级已被 2.6 抬高：同一个串同时守着服务器、教务系统与源码副本，
#      应该拆开成三个互不相同的口令，服务器那个用 20+ 位随机串
```

救急通道：阿里云控制台 → 实例 → 远程连接（VNC），不需要 SSH。

### 3.2 其余栈全部以 root 跑且持有全量 capability 🟠

```
bun (openclaw)  Uid: 0  CapEff: 000001ffffffffff  NoNewPrivs: 0  Seccomp: 0
qq  (napcat)    Uid: 0  CapEff: 000001ffffffffff  NoNewPrivs: 0  Seccomp: 0
```

OpenClaw 处理来自 QQ 的不可信输入、NapCat 是 Electron 且监听 `*:6099` ——
这两个是这台机器上最大的攻击面，而且**一旦被拿下就是 root，不需要提权**。
我没有动它们：改运行身份可能影响 QQ 登录态与网关行为，这是你的既有部署。
可选的下一步（择一，按收益排序）：
- NapCat WebUI 从 `*:6099` 改成 `127.0.0.1:6099`（需要重启 QQ，可能要重新扫码）
- 给这两个服务也加 `NoNewPrivileges` / `CapabilityBoundingSet=`（先别降权，先砍 capability）
- 长期：用 `systemd` 的 `User=` 把 openclaw 也降到一个专用用户

### 3.3 系统补丁：34 个待升级 + 需要重启 🟡

`unattended-upgrades` 是 active 的，但内核安全更新显然还没生效窗口。
重启会中断 QQ 机器人与 OpenClaw（QQ 可能需要重新扫码登录），**什么时候重启请你定**。

### 3.4 其他（低优先）

- `ufw` 未启用：目前完全依赖阿里云安全组。安全组在云外、更难被绕过，可以接受；
  但开了 ufw 就多一道本地保险。**注意**：若启用必须放行 22/2283/2284（+8787），
  否则会当场切断 Immich 公网映射与更新服务。
- `/root/Napcat/.../webui.json`（含 WebUI token）是 644。实际被 `/root` 的 700 保护着，
  非 root 进不去，所以风险很低；若将来给这台机器加运维账号，它就会变成真问题。
- `snapd` 在跑且 `snap-confine` 带着一大串 capability，但并没有安装任何 snap 包。
  用不上就可以卸（`apt purge snapd`），少一个 SUID 面。

## 4. 排除项（查过，没问题）

- **SUID/SGID**：全部是发行版自带（`su`/`mount`/`passwd`/`chsh`/`newgrp`/`fusermount3`/`ntfs-3g`/
  `dbus-daemon-launch-helper`/`ssh-keysign`/`pam_*`）。`/usr/lib/cargo/bin/{su,sudo}` 看着可疑，
  实为 Ubuntu 26.04 的 **sudo-rs**（Rust 版 sudo）的正常布局，非异常。
- **sudo**：`NOPASSWD` 规则 0 条，`sudo` 组为空（没人能用 sudo）。
- **账户**：uid 0 只有 `root`；除 root 外只有 `sync`（发行版标准），无其他可登录账户。
- **权限**：无世界可写文件、无缺 sticky 位的世界可写目录；`/etc/shadow` 640、`/root` 700 ✓
- **内核加固 sysctl**：ASLR=2、`dmesg_restrict`=1、`kptr_restrict`=1、`protected_symlinks/hardlinks`=1 ✓
- **日志**：journald 持久化开启；`btmp` 为 0 字节（Ubuntu 26.04 下失败登录没落 btmp，
  不是被清空 —— 文件 mtime 停留在 8 月 10 日创建时），交叉核对 journal 一致，**无掩盖痕迹**。
- OpenClaw 网关只绑 `127.0.0.1` ✓、`~/.openclaw/openclaw.json` 600 ✓

## 5. 一句话结论

**没有发现被入侵的迹象，也不存在「低权用户提权到 root」的经典路径**（SUID 干净、无 sudo 规则、单账户）。
真正的风险是另一种形状：**几乎所有服务都以 root 跑**，所以「提权」这一步根本不需要 ——
任何一个服务的 RCE 就是完整的 root。本次把我自己的服务从这条路上摘了出来（2.1），
剩下的三个（SSH 弱口令、openclaw、napcat）都在第 3 节，等你决定。
