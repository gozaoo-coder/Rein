/** 提供商（服务商账号 + 模型目录）IPC 封装 · 对应 modules/ai/providers.rs
 *
 * 拉模型清单是 Rust 发的请求（绕过 CORS、密钥不经过 WebView 的 fetch）。
 * 启用某个模型**不在这里**：那一步要写 ai_models / 语音配置 / 知识库设置，
 * 三个执行位的写入口都在各自的 store 里（见 stores/modelRoles.ts）。
 */

import type {
  AiModelPrefs,
  AiProvider,
  AiProviderInput,
  AiProviderModel,
  ProviderAdapter,
  ProviderCatalog,
} from '@/types'
import { invoke } from './transport'

export const providerService = {
  /** 适配器注册表（Rust 是唯一真源；前端只渲染） */
  adapters: () => invoke<ProviderAdapter[]>('ai_provider_adapters', {}),

  /** 全部提供商账号 + 各自已拉取的模型目录 */
  list: () => invoke<AiProvider[]>('ai_provider_list', {}),

  /** 新建/修改账号：同 adapter + 同地址视为同一个账号（改凭据而不是又建一条） */
  save: (input: AiProviderInput) => invoke<AiProvider>('ai_provider_save', { input }),

  /** 删除账号（连同它的目录；已启用的模型不受影响） */
  remove: (id: number) => invoke<void>('ai_provider_delete', { id }),

  /** 拉模型清单：id 有值 = 顺带落库并更新同步态；无值 = 只拉不存（表单里试一下） */
  fetch: (id: number | null, adapterId: string, baseUrl: string, apiKey: string) =>
    invoke<ProviderCatalog>('ai_provider_fetch', { id, adapterId, baseUrl, apiKey }),

  /** 手填一条模型（接口清单里没有、或该服务商没有 /models 接口时用） */
  modelAdd: (providerId: number, modelId: string, kind: string, meta?: string | null) =>
    invoke<AiProviderModel>('ai_provider_model_add', { providerId, modelId, kind, meta: meta ?? null }),

  /** 从目录里删掉一条（api 拉到的下次同步会回来；手填的删了就没了） */
  modelRemove: (providerId: number, modelId: string) =>
    invoke<void>('ai_provider_model_remove', { providerId, modelId }),

  /** 界面偏好（角色绑定 + 列表渲染声明） */
  prefsGet: () => invoke<AiModelPrefs>('ai_model_prefs_get', {}),
  prefsSave: (prefs: AiModelPrefs) => invoke<AiModelPrefs>('ai_model_prefs_save', { prefs }),
}
