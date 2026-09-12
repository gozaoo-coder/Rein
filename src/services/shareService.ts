/** 分享收件箱域 IPC 封装 · 命令名与 src-tauri/src/modules/share/commands.rs 一一对应。
 *  Android 端 ShareReceiver.kt 把系统分享/打开的文件拷入缓存收件箱，
 *  前端启动（及收到 rein-share 事件）时 poll 列出、read 取走（读后即删）。 */

import { invoke } from './transport'

export interface SharedFileMeta {
  /** inbox 内的原始文件名（`<ts>_<name>`，shareRead 的入参） */
  file: string
  /** 剥离时间戳前缀后的展示名 */
  name: string
  mime: string
  size: number
}

export interface SharedFileData {
  name: string
  mime: string
  /** 文件内容（base64，无 data: 前缀） */
  dataBase64: string
}

export const shareService = {
  /** 列出收件箱文件（按时间倒序；超过 7 天的残留由 Rust 侧自动清理） */
  sharePoll: () => invoke<SharedFileMeta[]>('share_poll', {}),

  /** 读取并删除一个收件箱文件（一次性消费） */
  shareRead: (file: string) => invoke<SharedFileData>('share_read', { file }),
}
