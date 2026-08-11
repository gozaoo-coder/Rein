export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export interface Session {
  id: string;
  title: string;
  agent_id: string | null;
  agent_name: string;
  agent_emoji: string;
  agent_color: string;
  created_at: number;
  updated_at: number;
  messages: ChatMessage[];
}

export interface SessionMeta {
  id: string;
  title: string;
  agent_name: string;
  agent_emoji: string;
  agent_color: string;
  last_msg: string;
  last_ts: number;
  unread: number;
}

export interface Agent {
  id: string;
  name: string;
  emoji: string;
  color: string;
  desc: string;
  system_prompt: string;
  greeting: string;
}

export interface AppConfig {
  provider: string;
  api_key: string;
  base_url: string;
  model: string;
  temperature: number;
  system_prompt: string;
  memory_provider: string;
  memory_base_url: string;
  memory_api_key: string;
  memory_model: string;
  embedding_model: string;
}

export interface AppInfo {
  name: string;
  version: string;
  data_dir: string;
  session_count: number;
  provider: string;
  model: string;
  framework: string;
}

// ---------- 记忆 ----------

export interface LoreEntry {
  id: string;
  name: string;
  keys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  insertion_order: number;
  created_at: number;
  updated_at: number;
}

export interface CoreMemory {
  id: string;
  category: string;
  content: string;
  importance: number;
  created_at: number;
  updated_at: number;
  accessed_at: number;
}

export interface Summary {
  id: string;
  content: string;
  from_ts: number;
  to_ts: number;
  created_at: number;
}

export interface EpisodicMemory {
  id: string;
  session_id: string;
  condensed: string;
  keywords: string[];
  embedding: number[] | null;
  ts: number;
  importance: number;
}

export interface AgentMemory {
  agent_id: string;
  lore: LoreEntry[];
  core: CoreMemory[];
  summaries: Summary[];
  episodic: EpisodicMemory[];
  marks: { session_id: string; msg_count: number; summary_id: string | null }[];
  last_extract_at: number;
}

export interface TavernImportResult {
  agents: Agent[];
  imported: Agent;
  lore_count: number;
}
