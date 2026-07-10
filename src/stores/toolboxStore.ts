/**
 * toolboxStore — 百宝箱入口 store
 *
 * - 持久化有序入口列表（key/label/icon/path/pinned/order）
 * - 置顶切换、拖拽换位、重置
 * - 通过 useStorage 持久化 + 远端同步（LWW 整体替换）
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { readJSON, writeJSON } from "@/composables/useStorage";
import { pushChange, registerSyncEntity } from "@/composables/useSyncBridge";

const KEY = "toolbox-entries";
const REC_ID = "entries";

export interface ToolboxEntry {
  key: string;
  label: string;
  icon: string;
  path: string;
  pinned: boolean;
  order: number;
}

/** 默认入口（顺序即默认 order） */
function defaultEntries(): ToolboxEntry[] {
  const defs: Array<Omit<ToolboxEntry, "pinned" | "order">> = [
    { key: "water", label: "饮水记录", icon: "cup-straw", path: "/health/water" },
    { key: "todo", label: "待办", icon: "list-check", path: "/todo" },
    { key: "food", label: "饮食记录", icon: "egg-fried", path: "/health/food" },
    { key: "food-db", label: "食品数据库", icon: "egg", path: "/health/food-db" },
    { key: "courses", label: "课程库", icon: "collection", path: "/sports/courses" },
    { key: "exercises", label: "动作库", icon: "person-arms-up", path: "/sports/exercises" },
    { key: "sports", label: "运动", icon: "activity", path: "/sports" },
    { key: "weight", label: "体重", icon: "speedometer2", path: "/health/weight" },
    { key: "overview", label: "健康概览", icon: "heart-pulse", path: "/health/metrics" },
  ];
  return defs.map((d, i) => ({ ...d, pinned: false, order: i }));
}

/** 规整化存储数据：补全缺失字段、重排 order */
function normalize(entries: ToolboxEntry[]): ToolboxEntry[] {
  const seen = new Set<string>();
  const out: ToolboxEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e.key !== "string" || seen.has(e.key)) continue;
    seen.add(e.key);
    out.push({
      key: e.key,
      label: e.label ?? "",
      icon: e.icon ?? "grid",
      path: e.path ?? "/",
      pinned: !!e.pinned,
      order: typeof e.order === "number" ? e.order : out.length,
    });
  }
  // 合并新增的默认项（老数据缺失时补齐）
  for (const d of defaultEntries()) {
    if (!seen.has(d.key)) {
      out.push({ ...d, order: out.length });
    }
  }
  return out;
}

export const useToolboxStore = defineStore("toolbox", () => {
  const entries = ref<ToolboxEntry[]>(defaultEntries());
  const loaded = ref(false);

  /** 展示顺序：pinned 优先，再按 order */
  const orderedEntries = computed(() => {
    return [...entries.value].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.order - b.order;
    });
  });

  async function load(): Promise<void> {
    if (loaded.value) return;
    const stored = await readJSON<ToolboxEntry[]>(KEY);
    if (stored && Array.isArray(stored)) {
      entries.value = normalize(stored);
      await persist();
    }
    loaded.value = true;
  }

  async function persist(): Promise<void> {
    await writeJSON(KEY, entries.value);
    void pushChange(KEY, REC_ID, entries.value);
  }

  function togglePin(key: string): void {
    const e = entries.value.find((x) => x.key === key);
    if (!e) return;
    e.pinned = !e.pinned;
    void persist();
  }

  /** 在展示顺序中移动（from/to 均为 orderedEntries 索引） */
  function moveItem(from: number, to: number): void {
    const ordered = orderedEntries.value;
    if (from < 0 || from >= ordered.length) return;
    const clamped = Math.max(0, Math.min(to, ordered.length - 1));
    if (from === clamped) return;
    const moved = ordered[from];
    ordered.splice(from, 1);
    ordered.splice(clamped, 0, moved);
    // 按 ordered 顺序重写 entries 的 order
    const byKey = new Map(ordered.map((e, i) => [e.key, i]));
    for (const e of entries.value) {
      e.order = byKey.get(e.key) ?? e.order;
    }
    void persist();
  }

  function reset(): void {
    entries.value = defaultEntries();
    void persist();
  }

  return {
    entries,
    orderedEntries,
    loaded,
    load,
    persist,
    togglePin,
    moveItem,
    reset,
    applyRemote,
  };
});

/** 远端同步应用：toolbox-entries 单条（id="entries"），整体替换（LWW） */
async function applyRemote(_id: string, payload: unknown, deleted: boolean): Promise<void> {
  if (deleted) return;
  const store = useToolboxStore();
  const incoming = payload as ToolboxEntry[];
  if (!Array.isArray(incoming)) return;
  store.entries = normalize(incoming);
  await writeJSON(KEY, store.entries);
}

registerSyncEntity<ToolboxEntry[]>({ kind: KEY, applyRemote });
