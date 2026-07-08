/**
 * usePairRequest — 全局 P2P 配对请求处理
 *
 * - 全局监听 sync-pair-request 事件，不依赖 SyncPage 是否打开
 * - 通过 BottomSheet 弹出请求，调用 sync_pair_respond 回应
 * - Web 环境降级：什么都不做
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { isTauriSync } from "@/composables/useSync";
import type { PairRequestPayload } from "@/composables/useSync";

const current = ref<PairRequestPayload | null>(null);
const responding = ref(false);
let initialized = false;
const unlisteners: Array<UnlistenFn> = [];

function start(): void {
  if (initialized || !isTauriSync) return;
  initialized = true;
  void listen<PairRequestPayload>("sync-pair-request", (e) => {
    if (current.value) return; // 已有待处理请求，忽略新的
    current.value = e.payload;
  }).then((fn) => unlisteners.push(fn));
}

function close(): void {
  current.value = null;
}

async function respond(accept: boolean): Promise<void> {
  const req = current.value;
  if (!req || responding.value) return;
  responding.value = true;
  try {
    await invoke("sync_pair_respond", {
      fromId: req.from_id,
      fromName: req.from_name,
      fromIp: req.from_ip,
      fromPort: req.from_port,
      accept,
    });
  } catch (e) {
    console.warn("[pairRequest] respond failed", e);
  } finally {
    responding.value = false;
    close();
  }
}

export function usePairRequest() {
  return { current, responding, start, close, respond };
}

export function initPairRequest(): void {
  start();
}

export function destroyPairRequest(): void {
  for (const fn of unlisteners) {
    try { fn(); } catch { /* noop */ }
  }
  unlisteners.length = 0;
  initialized = false;
  current.value = null;
}
