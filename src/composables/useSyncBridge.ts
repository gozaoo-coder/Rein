/**
 * useSyncBridge — Pinia store ↔ P2P 同步层桥接
 *
 * 设计：
 * - 每个 store 注册 SyncEntity：kind + applyRemote(id, payload, deleted)
 * - 本地变更：store 调用 pushChange / pushDelete 写入 Rust store（自动 broadcast）
 * - 远端变更：监听 sync-records-updated，按 kind 分发到对应 entity
 * - 配对成功时：backfill 所有 entity 当前数据（首次同步）
 *
 * kind 命名约定 = 各 store 的 STORAGE_KEY：
 *   user-profile / courses / exercises / workout-records / workout-stats /
 *   todo-items / todo-categories / ai-conversations /
 *   health-water / health-food-records / health-food-db / health-body-metrics /
 *   home-card-layout
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauriSync } from "@/composables/useSync";

export interface SyncEntity<T = unknown> {
  kind: string;
  /** 应用一条远端记录到 store（不触发回推） */
  applyRemote: (id: string, payload: T | null, deleted: boolean) => Promise<void>;
}

const REGISTRY = new Map<string, SyncEntity<any>>();
const unlisteners: Array<UnlistenFn> = [];
let initialized = false;

export function registerSyncEntity<T>(entity: SyncEntity<T>): void {
  REGISTRY.set(entity.kind, entity);
  // 桥接已初始化：迟到的 store（如 aiChatStore 懒加载）补拉一次
  if (initialized) void pullAndApply(entity.kind);
}

/** 本地变更推送到 Rust store（自动 broadcast 到所有配对设备） */
export async function pushChange(kind: string, id: string, payload: unknown): Promise<void> {
  if (!isTauriSync) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("sync_data_upsert", { kind, id, payload });
  } catch (e) {
    console.warn(`[syncBridge] pushChange(${kind}/${id}) failed`, e);
  }
}

/** 本地软删除推送 */
export async function pushDelete(kind: string, id: string): Promise<void> {
  if (!isTauriSync) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("sync_data_delete", { kind, id });
  } catch (e) {
    console.warn(`[syncBridge] pushDelete(${kind}/${id}) failed`, e);
  }
}

/** 拉取指定 kind 所有远端记录并分发应用 */
async function pullAndApply(kind: string): Promise<void> {
  if (!isTauriSync) return;
  const entity = REGISTRY.get(kind);
  if (!entity) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const records = await invoke<Array<{
      id: string;
      kind: string;
      payload: unknown;
      deleted_at: number | null;
    }>>("sync_data_list", { kind });
    for (const r of records) {
      try {
        await entity.applyRemote(r.id, r.deleted_at ? null : r.payload, !!r.deleted_at);
      } catch (e) {
        console.warn(`[syncBridge] applyRemote(${kind}/${r.id}) failed`, e);
      }
    }
  } catch (e) {
    console.warn(`[syncBridge] pullAndApply(${kind}) failed`, e);
  }
}

/** 应用所有 kind 的远端记录（全量同步触发后调用） */
async function pullAll(): Promise<void> {
  for (const kind of REGISTRY.keys()) {
    await pullAndApply(kind);
  }
}

/** 初始化：订阅事件 + 首次拉取 */
export async function initSyncBridge(): Promise<void> {
  if (initialized || !isTauriSync) return;
  initialized = true;
  try {
    unlisteners.push(
      await listen("sync-records-updated", () => {
        void pullAll();
      }),
      await listen("sync-pair-success", () => {
        // 配对成功：全量拉取并应用（远端会广播其已有数据）
        void pullAll();
      }),
    );
    // 启动时拉取一次：把 Rust store 中已有数据应用到 store
    void pullAll();
  } catch (e) {
    console.warn("[syncBridge] init failed", e);
  }
}

/** 销毁：取消监听 */
export function destroySyncBridge(): void {
  for (const fn of unlisteners) {
    try {
      fn();
    } catch {
      /* noop */
    }
  }
  unlisteners.length = 0;
  initialized = false;
}

export { isTauriSync };
