/** 检查/预写 voice_config 到桌面 App DB（App 停止时执行）
 *
 * 数据隔离：设了 REIN_DATA_DIR 就写隔离实例（与 voice-real-release-probe.mjs 拉起
 * 的 exe 同一个值），没设才写生产库 %APPDATA%/com.gozaoo.rein/rein.db。
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const DB = path.join(
  process.env.REIN_DATA_DIR ?? `${process.env.APPDATA}/com.gozaoo.rein`,
  'rein.db',
)
const db = new DatabaseSync(DB)

const cmd = process.argv[2] ?? 'get'

if (cmd === 'get') {
  const keys = db.prepare('SELECT key FROM app_meta').all().map((r) => r.key)
  console.log('app_meta keys:', keys.join(', ') || '(空)')
  const v = db.prepare("SELECT value FROM app_meta WHERE key='voice_config'").get()
  console.log('现有 voice_config:', v ? v.value : '(无)')
} else if (cmd === 'set') {
  const cfg = JSON.parse(readFileSync(process.env.TEMP + '/rein-voice-cfg.json', 'utf8'))
  db.prepare(
    "INSERT INTO app_meta (key, value) VALUES ('voice_config', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify(cfg))
  const v = db.prepare("SELECT value FROM app_meta WHERE key='voice_config'").get()
  writeFileSync(process.env.TEMP + '/rein-voice-cfg-written.txt', v.value)
  console.log('已写入:', v.value)
}
db.close()
