/** 语音对话域类型 · 与 Rust `modules/voice` 对应 */

/** ASR 适配器：auto = 按 baseURL/模型名关键词自动识别（程序替选）；显式选择后只推荐不强改 */
export type AsrAdapter = 'auto' | 'doubao' | 'qwen'

/** 朗读（豆包 TTS）独立凭据：appKey 为空 = 继承识别凭据 */
export interface TtsCredential {
  mode: 'legacy' | 'new'
  appKey: string
  accessKey: string
}

/** 配置状态摘要（voice_config_status 结构化返回） */
export interface VoiceStatus {
  /** 识别（ASR）凭据已配置 */
  asrReady: boolean
  /** 识别实际走的适配器（auto 解析后）：doubao | qwen */
  asrAdapter: 'doubao' | 'qwen'
  /** 朗读（TTS）凭据与音色已齐，可合成 */
  ttsReady: boolean
  /** 朗读是否使用独立凭据（false = 继承识别凭据） */
  ttsStandalone: boolean
}

/** 豆包语音服务配置（app_meta JSON 单条）。
 * 凭据两种模式对应火山新旧控制台：legacy = App ID + Access Token；new = 仅 API Key。
 * Qwen/DashScope 适配器：appKey 即 DASHSCOPE_API_KEY，单凭据。 */
export interface VoiceConfig {
  mode: 'legacy' | 'new'
  /** legacy = App ID（X-Api-App-Key）／Qwen = API Key；new = API Key（X-Api-Key） */
  appKey: string
  /** legacy = Access Token；new/Qwen 模式留空 */
  accessKey: string
  /** ASR 适配器 */
  asrAdapter: AsrAdapter
  /** 适配器是否由用户手动选定（false = 程序自动替选，保持第一层自动行为） */
  asrAdapterUserPicked: boolean
  /** ASR WebSocket baseURL；空 = 用适配器默认端点（可指向代理/私有化网关） */
  asrBaseUrl: string
  /** 朗读（豆包 TTS）独立凭据；不传 = 继承识别凭据 */
  ttsCredential?: TtsCredential | null
  /** ASR 模型标识：豆包 = Resource-Id（默认 volc.seedasr.sauc.duration）；Qwen = 模型名 */
  asrResourceId: string
  /** TTS Resource-Id（默认 seed-tts-2.0） */
  ttsResourceId: string
  /** 朗读音色（如 zh_female_cancan），空 = 未设置 */
  voiceName: string
  /** 语速 0.2~3.0 */
  speed: number
}

/** 一句已定稿的转写（来自 ASR utterances，definite=true） */
export interface VoiceSentence {
  idx: number
  text: string
  /** 音频内偏移（毫秒），点句 seek 用 */
  startMs: number
  endMs: number
}

/** 纪要总结条目：refs 指向句子 idx（引用角标），written 记录「写入」状态 */
export interface MemoSummaryItem {
  kind: 'food' | 'todo' | 'note'
  text: string
  note?: string
  refs: number[]
  written?: boolean
  /** kind=todo 时写入待办的参数 */
  todo?: { title: string; date?: string; startMin?: number | null }
  /** kind=food 时写入饮食的参数 */
  food?: { name: string; grams?: number }
}

/** 纪要（voice_memos 行；sentences/summary 已解析） */
export interface VoiceMemo {
  id: string
  chatId: string
  messageId: string | null
  title: string
  /** 音频文件绝对路径；null = 无音频（mock 或写入失败） */
  audioPath: string | null
  durationMs: number
  words: number
  sentences: VoiceSentence[]
  summary: MemoSummaryItem[]
  createdAt: string
}

/** 崩溃恢复草稿（voice_draft） */
export interface VoiceDraft {
  sessionId: string
  chatId: string
  startedAt: string
  sentences: VoiceSentence[]
  partial: string
}

/** ASR 事件（Rust `voice://asr`） */
export interface AsrEventPayload {
  sessionId: string
  kind: 'partial' | 'final' | 'ended' | 'error'
  text?: string
  startMs?: number
  endMs?: number
  audioPath?: string
  durationMs?: number
  message?: string
}

export interface VoiceMemoInput {
  id: string
  chatId: string
  messageId: string | null
  title?: string
  audioPath?: string | null
  durationMs?: number
  words?: number
  sentencesJson?: string
  summaryJson?: string
}
