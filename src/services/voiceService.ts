/** 语音对话域 IPC 封装 · 对应 modules/voice/commands.rs。
 *
 * 除命令外还负责把 Rust 的 `voice://asr` 事件桥接成订阅回调：
 * - Tauri 环境：@tauri-apps/api/event listen；
 * - 浏览器 mock：mock/server.ts 的 mockVoice.onAsr 挂钩（伪造识别事件流）。
 * 音频路径统一在本层转成可播放 URL（Tauri 走 asset 协议，mock 直接给 data URL）。 */

import { convertFileSrc } from '@tauri-apps/api/core'

import type { AsrEventPayload, MemoSummaryItem, VoiceConfig, VoiceDraft, VoiceMemo, VoiceMemoInput, VoiceSentence } from '@/types'
import { invoke, isTauri } from './transport'

type AsrListener = (e: AsrEventPayload) => void

const asrListeners = new Set<AsrListener>()
let bridged = false

function dispatchAsr(e: AsrEventPayload): void {
  for (const l of asrListeners) l(e)
}

async function bridgeAsrEvents(): Promise<void> {
  if (bridged) return
  bridged = true
  if (isTauri) {
    const { listen } = await import('@tauri-apps/api/event')
    await listen<AsrEventPayload>('voice://asr', (e) => dispatchAsr(e.payload))
    return
  }
  const { mockVoice } = await import('@/mock/server')
  mockVoice.onAsr = dispatchAsr as (e: unknown) => void
}

/** 音频文件路径 → 可播放 URL（Tauri asset 协议已开 $APPDATA/voice_sessions/* 作用域） */
function resolveAudioUrl(path: string | null | undefined): string | null {
  if (!path) return null
  if (!isTauri) return path // mock 直接给 data URL
  return convertFileSrc(path)
}

/** 事件里带回的音频绝对路径 → 可播放 URL（供 runtime 处理 ended 事件用） */
export function audioUrlFromPath(path: string | null | undefined): string | null {
  return resolveAudioUrl(path)
}

function parseMemo(m: VoiceMemo & { sentences: unknown; summary: unknown }): VoiceMemo {
  return {
    ...m,
    sentences: safeParseArr<VoiceSentence>(m.sentences as unknown as string),
    summary: safeParseArr<MemoSummaryItem>(m.summary as unknown as string),
  }
}

function safeParseArr<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (typeof raw !== 'string' || !raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

export const voiceService = {
  /** 订阅识别事件；返回取消订阅函数 */
  async onAsr(cb: AsrListener): Promise<() => void> {
    await bridgeAsrEvents()
    asrListeners.add(cb)
    return () => asrListeners.delete(cb)
  },

  /* ---- 配置 ---- */

  /** 读取配置并归一化（旧数据缺新字段时补默认值） */
  configGet: async (): Promise<VoiceConfig> => {
    const c = await invoke<Partial<VoiceConfig>>('voice_config_get', {})
    return {
      mode: c.mode ?? 'legacy',
      appKey: c.appKey ?? '',
      accessKey: c.accessKey ?? '',
      asrAdapter: c.asrAdapter ?? 'auto',
      asrAdapterUserPicked: c.asrAdapterUserPicked ?? false,
      asrBaseUrl: c.asrBaseUrl ?? '',
      asrResourceId: c.asrResourceId ?? 'volc.seedasr.sauc.duration',
      ttsResourceId: c.ttsResourceId ?? 'seed-tts-2.0',
      voiceName: c.voiceName ?? '',
      speed: c.speed ?? 1,
    }
  },
  configSave: (config: VoiceConfig) => invoke<void>('voice_config_save', { config }),
  configStatus: () => invoke<boolean>('voice_config_status', {}),

  /* ---- 识别会话 ---- */

  asrStart: (sessionId: string) => invoke<void>('voice_asr_start', { sessionId }),
  /** 推一包 200ms PCM（16k/16bit/mono，base64） */
  asrAudio: (sessionId: string, audioB64: string) => invoke<void>('voice_asr_audio', { sessionId, audioB64 }),
  asrFinish: (sessionId: string) => invoke<void>('voice_asr_finish', { sessionId }),
  asrCancel: (sessionId: string) => invoke<void>('voice_asr_cancel', { sessionId }),

  /* ---- TTS（纪要朗读） ---- */

  ttsSpeak: async (speakId: string, text: string): Promise<{ audioUrl: string | null }> => {
    const r = await invoke<{ audioPath: string }>('voice_tts_speak', { speakId, text })
    return { audioUrl: resolveAudioUrl(r.audioPath) }
  },

  /* ---- 纪要 ---- */

  memoCreate: async (input: VoiceMemoInput) => {
    const m = await invoke<VoiceMemo & { sentences: unknown; summary: unknown }>('voice_memo_create', { input })
    return parseMemo(m)
  },
  memoGet: async (id: string) => {
    const m = await invoke<VoiceMemo & { sentences: unknown; summary: unknown }>('voice_memo_get', { id })
    return parseMemo(m)
  },
  memoList: async (limit?: number) => {
    const rows = await invoke<(VoiceMemo & { sentences: unknown; summary: unknown })[]>('voice_memo_list', { limit: limit ?? null })
    return rows.map(parseMemo)
  },
  memoSetSummary: (id: string, summaryJson: string) => invoke<void>('voice_memo_set_summary', { id, summaryJson }),
  memoRename: (id: string, title: string) => invoke<void>('voice_memo_rename', { id, title }),
  memoDelete: (id: string) => invoke<void>('voice_memo_delete', { id }),

  /* ---- 崩溃恢复草稿 ---- */

  draftSave: (draft: VoiceDraft) => invoke<void>('voice_draft_save', { draftJson: JSON.stringify(draft) }),
  draftGet: async (): Promise<VoiceDraft | null> => {
    const raw = await invoke<string | null>('voice_draft_get', {})
    if (!raw) return null
    try {
      return JSON.parse(raw) as VoiceDraft
    } catch {
      return null
    }
  },
  draftClear: () => invoke<void>('voice_draft_clear', {}),
}
