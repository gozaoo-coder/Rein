/**
 * useStorage — 持久化存储桥接层
 *
 * - Tauri 环境：调用 Rust 层 storage_read/write/delete 写入 app_data_dir
 * - Web 环境（vite 单跑 / 单元测试）：回退到 localStorage，保证可运行
 *
 * 所有持久化数据（课程/动作/记录/统计/设置）都通过该层。
 */

import { invoke } from "@tauri-apps/api/core";
import { ref, type Ref } from "vue";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const memoryCache = new Map<string, unknown>();

export async function readJSON<T>(key: string): Promise<T | null> {
  if (memoryCache.has(key)) {
    return memoryCache.get(key) as T | null;
  }
  let raw: unknown = null;
  try {
    if (isTauri) {
      raw = await invoke<unknown>("storage_read", { key });
    } else if (typeof localStorage !== "undefined") {
      const s = localStorage.getItem(key);
      if (s != null) raw = JSON.parse(s);
    }
  } catch (e) {
    console.warn(`[storage] read failed: ${key}`, e);
  }
  memoryCache.set(key, raw);
  return (raw as T) ?? null;
}

export async function writeJSON<T>(key: string, value: T): Promise<void> {
  memoryCache.set(key, value);
  try {
    if (isTauri) {
      await invoke("storage_write", { key, value });
    } else if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch (e) {
    console.error(`[storage] write failed: ${key}`, e);
  }
}

export async function deleteJSON(key: string): Promise<void> {
  memoryCache.delete(key);
  try {
    if (isTauri) {
      await invoke("storage_delete", { key });
    } else if (typeof localStorage !== "undefined") {
      localStorage.removeItem(key);
    }
  } catch (e) {
    console.error(`[storage] delete failed: ${key}`, e);
  }
}

/** 同步只读 ref：从存储加载，外部修改通过 setter 写回 */
export function usePersistentRef<T>(
  key: string,
  defaultValue: T,
): { value: Ref<T>; save: () => Promise<void> } {
  const value = ref<T>(defaultValue) as Ref<T>;
  let loaded = false;

  async function load(): Promise<void> {
    if (loaded) return;
    const v = await readJSON<T>(key);
    if (v != null) value.value = v;
    loaded = true;
  }

  async function save(): Promise<void> {
    await writeJSON(key, value.value);
  }

  // fire and forget load
  load();
  return { value, save };
}

export function isTauriEnv(): boolean {
  return isTauri;
}
