/** Rein 在线服务 IPC 封装 · 对应 modules/ai/online.rs
 *
 * 与 updateService.onlineServiceStatus 的分工：那条链路探测「更新分发 + 服务是否在线」，
 * 这里管「用服务密钥换模型目录、按服务端清单落库、与服务端对账成本」。
 */

import type {
  OnlineCatalog,
  OnlineServiceSettings,
  OnlineSyncResult,
  OnlineUsage,
} from '@/types'
import { invoke } from './transport'

export const onlineService = {
  /** 读本机保存的服务地址与密钥 */
  settingsGet: () => invoke<OnlineServiceSettings>('online_service_settings_get', {}),

  /** 保存服务地址与密钥（密钥是访问在线模型的唯一凭据） */
  settingsSave: (settings: OnlineServiceSettings) =>
    invoke<OnlineServiceSettings>('online_service_settings_save', { settings }),

  /** 用密钥换模型目录：服务端指定「这个密钥能用哪些模型 + 官方单价 + 流量价」 */
  catalog: (baseUrl: string | null, apiKey: string) =>
    invoke<OnlineCatalog>('online_service_catalog', { baseUrl, apiKey }),

  /** 服务端记的账（权威口径，用来跟本机账本对账） */
  usage: (baseUrl: string | null, apiKey: string, days = 30) =>
    invoke<OnlineUsage>('online_service_usage', { baseUrl, apiKey, days }),

  /** 把服务端清单落库成可用模型；prune = 清掉服务端已撤下的同源模型 */
  sync: (baseUrl: string | null, apiKey: string, modelIds: string[], prune = true) =>
    invoke<OnlineSyncResult>('online_service_sync', {
      baseUrl,
      apiKey,
      modelIds,
      prune,
    }),
}
