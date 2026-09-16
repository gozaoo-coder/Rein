/**
 * 语音服务域工具：AI 可查看、修改语音对话（ASR/TTS）配置，并做连通性探测与诊断。
 *
 * 支持的对话场景：
 * - 「帮我看看语音为什么用不了」→ get_voice_status 诊断 + test_voice_asr/test_voice_tts 验证 + 给修复建议；
 * - 「我拿了个豆包 API Key，帮我配上」→ update_voice_config 填入 + test 验证 + 引导设置音色；
 * - 「识别用 Qwen 但朗读用豆包」→ update_voice_config 分别填两份凭据；
 * - 「推荐个音色」→ list_voice_presets 查询 + update_voice_config 更新。
 *
 * 隐私约定：工具结果一律不回传密钥明文（与模型配置工具同一隐私约定），只给末 4 位 keyTail。
 */

import { Type } from '@earendil-works/pi-ai'

import { voiceService } from '@/services/voiceService'
import { defineTool, type AppTool } from './types'

/** 官方文档已验证可用的 2.0 音色（试听后可换） */
const VOICE_PRESETS = [
  { id: 'zh_female_cancan_uranus_bigtts', label: '灿灿 · 女声 · 活泼清亮' },
  { id: 'zh_female_wanqudashu_emo_v2_mars_bigtts', label: '湾曲大叔 · 女声 · 沉稳磁性' },
  { id: 'zh_male_rouyi_jupiter_bigtts', label: '柔一 · 男声 · 温润自然' },
  { id: 'zh_male_beijingxiaoye_emo_v2_mars_bigtts', label: '北京小爷 · 男声 · 京味儿' },
  { id: 'zh_female_sichuan_niuniu_mars_bigtts', label: '川妹子 · 女声 · 四川口音' },
] as const

/** 音色 ID 掩码（不回传完整凭据，只回传末 4 位） */
function keyTail(v: string | undefined | null): string {
  const t = (v ?? '').trim()
  return t ? `****${t.slice(-4)}` : ''
}

/** 掩码后的配置投影（不回传密钥明文） */
function brief(c: Awaited<ReturnType<typeof voiceService.configGet>>) {
  return {
    asrAdapter: c.asrAdapter,
    asrAdapterUserPicked: c.asrAdapterUserPicked,
    asrBaseUrl: c.asrBaseUrl || null,
    asrResourceId: c.asrResourceId,
    asrMode: c.mode,
    asrKeyTail: keyTail(c.appKey),
    asrAccessKeyTail: keyTail(c.accessKey),
    ttsStandalone: !!c.ttsCredential?.appKey,
    ttsKeyTail: keyTail(c.ttsCredential?.appKey),
    ttsResourceId: c.ttsResourceId,
    voiceName: c.voiceName || null,
    speed: c.speed,
  }
}

export const voiceTools: AppTool[] = [
  defineTool({
    name: 'get_voice_status',
    group: 'voice',
    label: '查看语音服务状态',
    description:
      '查看语音对话（识别 ASR + 朗读 TTS）的配置状态与连通能力：识别/朗读各自是否就绪、实际适配器、凭据末 4 位（不回传明文）、音色、语速。诊断语音对话异常时先调用本工具。',
    parameters: Type.Object({}),
    async execute() {
      const [config, status] = await Promise.all([voiceService.configGet(), voiceService.configStatus().catch(() => null)])
      const hints: string[] = []
      if (!status) {
        hints.push('无法读取语音服务状态')
      } else {
        if (!status.asrReady) hints.push('识别凭据未配置：语音转写不可用，需要在设置里填入豆包或 Qwen 凭据')
        if (!status.ttsReady) {
          hints.push(
            status.asrAdapter === 'qwen' && !status.ttsStandalone
              ? '朗读凭据不可用：识别配了 Qwen，豆包 TTS 无法继承其凭据，需要单独配置豆包凭据（ttsStandalone）'
              : '朗读未就绪：缺少豆包凭据或未设置朗读音色',
          )
        }
      }
      return { status: status ?? null, config: brief(config), hints }
    },
  }),

  defineTool({
    name: 'update_voice_config',
    group: 'voice',
    label: '修改语音服务配置',
    description:
      '更新语音对话配置（合并式：只传要改的字段，未传保持原值）。识别凭据：doubao 用 asrMode=legacy（appKey=App ID + accessKey=Token）或 new（appKey=API Key）、qwen 用 appKey=百炼 Key；ttsStandalone=true 时用 ttsAppKey/ttsAccessKey 单独填豆包朗读凭据。凭据只存本地不回显。改完建议 test_voice_asr / test_voice_tts 验证连通。',
    parameters: Type.Object({
      adapter: Type.Optional(
        Type.Union(
          [Type.Literal('auto'), Type.Literal('doubao'), Type.Literal('qwen')],
          { description: '识别适配器：auto 按关键词自动识别' },
        ),
      ),
      asrMode: Type.Optional(Type.Union([Type.Literal('legacy'), Type.Literal('new')], { description: '豆包凭据模式' })),
      appKey: Type.Optional(Type.String({ description: '识别凭据：豆包 App ID / API Key，或 Qwen 百炼 API Key（明文，仅存本地）' })),
      accessKey: Type.Optional(Type.String({ description: '豆包旧版 Access Token（legacy 模式需要）' })),
      asrBaseUrl: Type.Optional(Type.String({ description: 'ASR WebSocket 端点，留空用默认' })),
      asrResourceId: Type.Optional(Type.String({ description: '豆包 Resource-Id 或 Qwen 模型名' })),
      ttsResourceId: Type.Optional(Type.String({ description: 'TTS Resource-Id，默认 seed-tts-2.0' })),
      voiceName: Type.Optional(Type.String({ description: '朗读音色（豆包 2.0 音色 ID，如 zh_female_cancan_uranus_bigtts）' })),
      speed: Type.Optional(Type.Number({ description: '语速 0.2~3.0，默认 1' })),
      ttsStandalone: Type.Optional(
        Type.Boolean({ description: '朗读是否用独立豆包凭据；true 时需再传 ttsAppKey（识别配 Qwen 时朗读必须独立凭据）' }),
      ),
      ttsMode: Type.Optional(Type.Union([Type.Literal('legacy'), Type.Literal('new')], { description: '朗读独立凭据的模式' })),
      ttsAppKey: Type.Optional(Type.String({ description: '朗读独立凭据：豆包 App ID / API Key' })),
      ttsAccessKey: Type.Optional(Type.String({ description: '朗读独立凭据：豆包旧版 Access Token' })),
    }),
    async execute(args) {
      const cur = await voiceService.configGet()
      const adapter = args.adapter ?? cur.asrAdapter
      const mode = args.asrMode ?? cur.mode
      const appKey = args.appKey !== undefined ? args.appKey.trim() : cur.appKey
      const accessKey = args.accessKey !== undefined ? args.accessKey.trim() : cur.accessKey
      if (!appKey) throw new Error('识别凭据（appKey）不能为空；豆包 App ID / API Key 或 Qwen 百炼 API Key 至少要有一个')
      if (adapter === 'doubao' && mode === 'legacy' && !accessKey) {
        throw new Error('豆包旧版凭据模式（legacy）需要 App ID + Access Token 两个凭据，accessKey 缺失')
      }
      // 朗读独立凭据合并：本次传了新 Key 用新值，否则保留旧独立凭据
      const prevTts = cur.ttsCredential
      const ttsStandaloneOn = args.ttsStandalone ?? !!prevTts?.appKey
      const ttsAppKey = args.ttsAppKey !== undefined ? args.ttsAppKey.trim() : (prevTts?.appKey ?? '')
      const ttsAccessKey = args.ttsAccessKey !== undefined ? args.ttsAccessKey.trim() : (prevTts?.accessKey ?? '')
      let ttsCredential = null
      if (ttsStandaloneOn && ttsAppKey) {
        ttsCredential = {
          mode: args.ttsMode ?? prevTts?.mode ?? 'legacy',
          appKey: ttsAppKey,
          accessKey: ttsAccessKey,
        }
        if (ttsCredential.mode === 'legacy' && !ttsCredential.accessKey) {
          throw new Error('朗读独立凭据为旧版模式（legacy）时 Access Token 必填（ttsAccessKey）')
        }
      }
      const config = {
        mode,
        appKey,
        accessKey,
        asrAdapter: adapter,
        asrAdapterUserPicked: adapter !== 'auto',
        asrBaseUrl: args.asrBaseUrl !== undefined ? args.asrBaseUrl.trim() : cur.asrBaseUrl,
        ttsCredential,
        asrResourceId: args.asrResourceId?.trim() || cur.asrResourceId || 'volc.seedasr.sauc.duration',
        ttsResourceId: args.ttsResourceId?.trim() || cur.ttsResourceId || 'seed-tts-2.0',
        voiceName: args.voiceName !== undefined ? args.voiceName.trim() : cur.voiceName,
        speed: Math.min(3, Math.max(0.2, args.speed ?? cur.speed ?? 1)),
      }
      await voiceService.configSave(config)
      const status = await voiceService.configStatus().catch(() => null)
      return {
        config: brief(config),
        status,
        message: `语音配置已保存（适配器 ${adapter}）。建议接着调用 test_voice_asr / test_voice_tts 验证连通。`,
      }
    },
  }),

  defineTool({
    name: 'test_voice_asr',
    group: 'voice',
    label: '测试语音识别连通',
    description:
      '用当前配置对识别服务发起一次短连接测试（建连+鉴权+立即结束，不消耗识别时长），验证凭据/端点/资源 ID 是否可用。语音转写异常时用它定位问题；失败会返回具体原因（鉴权失败、模型名不对、网络超时等）。',
    parameters: Type.Object({}),
    async execute() {
      await voiceService.asrProbe()
      const status = await voiceService.configStatus().catch(() => null)
      return {
        ok: true,
        adapter: status?.asrAdapter ?? null,
        message: '识别服务连通正常：凭据、端点与资源 ID 均有效。',
      }
    },
  }),

  defineTool({
    name: 'test_voice_tts',
    group: 'voice',
    label: '测试语音合成（试听）',
    description:
      '用当前朗读配置合成一句短文本验证连通（等同「试听音色」，音频在手机上自动播放给用户）。不消耗朗读量也可以确认凭据与音色有效；失败会返回具体原因（音色 ID 不对、凭据无效等）。',
    parameters: Type.Object({
      voiceName: Type.Optional(Type.String({ description: '临时用某个音色试听（不改变配置）' })),
    }),
    async execute(args) {
      const { audioUrl } = await voiceService.ttsProbe(args.voiceName?.trim() || undefined)
      if (!audioUrl) throw new Error('未获得音频')
      return {
        ok: true,
        playedToUser: true,
        voiceName: args.voiceName?.trim() || null,
        message: '合成成功，试听音频已播放给用户。',
      }
    },
  }),

  defineTool({
    name: 'list_voice_presets',
    group: 'voice',
    label: '查询推荐音色',
    description: '查询豆包语音合成 2.0 的推荐音色 ID 清单（官方文档验证可用）。用户想换朗读声音、或还没设置音色时调用。',
    parameters: Type.Object({}),
    async execute() {
      return {
        presets: VOICE_PRESETS,
        message: '以上为已验证可用的 2.0 音色 ID；用 test_voice_tts 传 voiceName 可先试听，确认后再 update_voice_config 更新。',
      }
    },
  }),
]
