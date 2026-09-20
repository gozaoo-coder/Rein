#!/usr/bin/env bash
# Rein 在线服务安装/升级脚本（在 ECS 上以 root 执行）。
#
# 幂等：重复执行 = 升级。配置只在缺失时创建，已有配置与已发布的数据一律不动。
#
#   bash install.sh --stage /tmp/rein-server-stage --base-url http://47.100.36.179:8787
set -euo pipefail

STAGE=""
BASE_URL="http://47.100.36.179:8787"
PORT="8787"
PUBLIC_KEY=""
for arg in "$@"; do
  case "$arg" in
    --stage=*) STAGE="${arg#*=}" ;;
    --base-url=*) BASE_URL="${arg#*=}" ;;
    --port=*) PORT="${arg#*=}" ;;
    --public-key=*) PUBLIC_KEY="${arg#*=}" ;;
  esac
done
# 也接受位置参数：install.sh <stage>
if [[ -z "$STAGE" && $# -gt 0 && "${1}" != --* ]]; then STAGE="$1"; fi

APP_DIR=/opt/rein-services
DATA_DIR=/var/lib/rein-services
CONF_DIR=/etc/rein-services
SERVICE=rein-services

log() { printf '\033[36m▸ %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "请用 root 执行"; exit 1; }
command -v node >/dev/null || { echo "缺少 node（≥18）"; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 18 ]] || { echo "node 版本过低：$(node -v)"; exit 1; }

if [[ -z "$STAGE" || ! -d "$STAGE" ]]; then
  echo "缺少 --stage=<已上传的目录>"
  exit 1
fi

log "安装目录 $APP_DIR"
mkdir -p "$APP_DIR" "$DATA_DIR" "$CONF_DIR" "$DATA_DIR/logs"

# 专用非特权用户（服务不以 root 运行；见 unit 里的说明）。
# 系统用户 + nologin：它只是个「跑进程的身份」，不是一个能登录的账号。
if ! id -u rein >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin rein
  log "已创建系统用户 rein"
fi
chown -R rein:rein "$DATA_DIR"

# 代码整目录替换，但保留上一版以便回滚（server.bak）
rm -rf "$APP_DIR/server.prev"
[[ -d "$APP_DIR/server" ]] && mv "$APP_DIR/server" "$APP_DIR/server.prev"
cp -r "$STAGE/server" "$APP_DIR/server"
rm -rf "$APP_DIR/server/data" "$APP_DIR/server/config.json"   # 数据与配置属于 /var 与 /etc
# 从 Windows 部署时 scp 带下来的目录是 700，cp -r 会原样保留 —— 服务以 rein 用户跑，
# 连 chdir 都进不去就会起不来。这里统一放开「读 + 目录穿越」（代码本来就不该是私有的）。
chmod -R a+rX "$APP_DIR/server"

log "配置 $CONF_DIR/config.json"
if [[ ! -f "$CONF_DIR/config.json" ]]; then
  cp "$APP_DIR/server/config.example.json" "$CONF_DIR/config.json"
  # 用 python 改 JSON 比 sed 稳（值里可能带斜杠）
  python3 - "$CONF_DIR/config.json" "$BASE_URL" "$PORT" "$PUBLIC_KEY" <<'PY'
import json, sys, secrets
path, base_url, port, pubkey = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
cfg = json.load(open(path, encoding='utf-8'))
cfg['publicBaseUrl'] = base_url
cfg['port'] = int(port)
cfg['adminToken'] = 'rein_' + secrets.token_hex(24)
if pubkey:
    cfg['update']['publicKey'] = pubkey
json.dump(cfg, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
  chmod 600 "$CONF_DIR/config.json"
  log "已生成新配置（含随机管理令牌）"
else
  python3 - "$CONF_DIR/config.json" "$BASE_URL" "$PORT" "$PUBLIC_KEY" <<'PY'
import json, sys
path, base_url, port, pubkey = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
cfg = json.load(open(path, encoding='utf-8'))
cfg['publicBaseUrl'] = base_url
cfg['port'] = int(port)
if pubkey and cfg.get('update', {}).get('publicKey') != pubkey:
    cfg.setdefault('update', {})['publicKey'] = pubkey
    print('  （更新公钥已对齐）')
json.dump(cfg, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
  log "沿用已有配置（同步 baseUrl/port/公钥，令牌保持原样）"
fi

log "systemd 单元 $SERVICE"
install -m 644 "$APP_DIR/server/deploy/rein-services.service" "/etc/systemd/system/$SERVICE.service"
# 配置：root 可写、rein 组可读（服务要读它，但不对其他用户开放）
chown root:rein "$CONF_DIR/config.json"
chmod 640 "$CONF_DIR/config.json"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

sleep 1
if systemctl is-active --quiet "$SERVICE"; then
  log "服务已启动"
else
  echo "服务启动失败，最近日志："
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  exit 1
fi

# 本机自检（不依赖外网通不通）
if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null; then
  log "健康检查通过 http://127.0.0.1:$PORT/health"
else
  echo "健康检查未通过"
  exit 1
fi

TOKEN="$(python3 -c "import json;print(json.load(open('$CONF_DIR/config.json'))['adminToken'])")"

# 部署暂存目录里有一份完整代码副本，且落在 /tmp（全局可读）——用完就删
rm -rf "$STAGE"
log "已清理部署暂存目录 $STAGE"

cat <<EOF

────────────────────────────────────────────────────────────
Rein 在线服务已就绪
  监听       0.0.0.0:$PORT
  对外地址   $BASE_URL
  清单       $BASE_URL/updates/latest.json
  管理令牌   $TOKEN
  数据目录   $DATA_DIR
  配置       $CONF_DIR/config.json

⚠ 还需要在阿里云控制台放行入方向 TCP $PORT，公网才访问得到：
  https://ecs.console.aliyun.com/ → 实例 → 安全组 → 配置规则 → 入方向 → 添加入方向规则
  协议类型 TCP，端口范围 $PORT/$PORT，授权对象 0.0.0.0/0

  验证：curl -s $BASE_URL/health
────────────────────────────────────────────────────────────
EOF
