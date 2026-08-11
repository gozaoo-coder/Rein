import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Agent,
  AgentMemory,
  AppConfig,
  AppInfo,
  ChatMessage,
  CoreMemory,
  EpisodicMemory,
  LoreEntry,
  Session,
  SessionMeta,
  TavernImportResult,
} from "./types";

export const api = {
  sessionsList: () => invoke<SessionMeta[]>("sessions_list"),
  sessionOpen: (id: string) => invoke<Session>("session_open", { id }),
  sessionCreate: (title: string, agentId: string | null) =>
    invoke<Session>("session_create", { title, agentId }),
  sessionRename: (id: string, title: string) =>
    invoke<void>("session_rename", { id, title }),
  sessionDelete: (id: string) => invoke<void>("session_delete", { id }),
  sessionClear: (id: string) => invoke<void>("session_clear", { id }),

  agentsList: () => invoke<Agent[]>("agents_list"),
  agentSave: (agent: Agent) => invoke<Agent[]>("agent_save", { agent }),
  agentDelete: (id: string) => invoke<Agent[]>("agent_delete", { id }),

  configGet: () => invoke<AppConfig>("config_get"),
  configSave: (config: AppConfig) => invoke<void>("config_save", { config }),
  modelProbe: () => invoke<{ ok: boolean; provider: string; model: string }>("model_probe"),

  chatSend: (sessionId: string, text: string) =>
    invoke<ChatMessage>("chat_send", { sessionId, text }),

  // ---------- 记忆 ----------

  memoryGet: (agentId: string) => invoke<AgentMemory>("memory_get", { agentId }),
  memoryLoreSave: (agentId: string, entry: LoreEntry) =>
    invoke<AgentMemory>("memory_lore_save", { agentId, entry }),
  memoryLoreDelete: (agentId: string, entryId: string) =>
    invoke<AgentMemory>("memory_lore_delete", { agentId, entryId }),
  memoryCoreSave: (agentId: string, entry: CoreMemory) =>
    invoke<AgentMemory>("memory_core_save", { agentId, entry }),
  memoryCoreDelete: (agentId: string, entryId: string) =>
    invoke<AgentMemory>("memory_core_delete", { agentId, entryId }),
  memoryRecall: (agentId: string, query: string, k?: number) =>
    invoke<EpisodicMemory[]>("memory_recall", { agentId, query, k }),

  // ---------- 酒馆导入 ----------

  tavernImport: (path: string) => invoke<TavernImportResult>("tavern_import", { path }),

  appInfo: () => invoke<AppInfo>("app_info"),
  resetAll: () => invoke<void>("reset_all"),
};

export interface StreamEvent {
  session_id: string;
  message_id: string;
  delta?: string;
  content?: string;
  error?: string;
  reason?: string;
}

export function onChatStream(
  handlers: {
    onStart: (e: StreamEvent) => void;
    onDelta: (e: StreamEvent) => void;
    onReasoning: (e: StreamEvent) => void;
    onDone: (e: StreamEvent) => void;
    onError: (e: StreamEvent) => void;
  },
): Promise<() => void>[] {
  return [
    listen<StreamEvent>("chat://start", (ev) => handlers.onStart(ev.payload)),
    listen<StreamEvent>("chat://delta", (ev) => handlers.onDelta(ev.payload)),
    listen<StreamEvent>("chat://reasoning", (ev) => handlers.onReasoning(ev.payload)),
    listen<StreamEvent>("chat://done", (ev) => handlers.onDone(ev.payload)),
    listen<StreamEvent>("chat://error", (ev) => handlers.onError(ev.payload)),
  ];
}
