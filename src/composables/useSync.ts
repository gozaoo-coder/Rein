/**
 * useSync — P2P 局域网同步前端桥
 *
 * - 仅 Tauri 环境调用 Rust commands；Web 环境返回空数据
 * - 监听 Tauri 事件：sync-device-discovered / sync-pair-request /
 *   sync-pair-success / sync-pair-rejected / sync-records-updated
 */
import { invoke } from "@tauri-apps/api/core";
import { ref } from "vue";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface DiscoveredDevice {
  device_id: string;
  name: string;
  ip: string;
  port: number;
  paired: boolean;
}

export interface PairedDevice {
  device_id: string;
  name: string;
  ip: string;
  port: number;
  paired_at: number;
}

export interface SyncRecord {
  id: string;
  content: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface PairCodeInfo {
  code: string;
  remaining_secs: number;
  ttl: number;
}

export interface DeviceInfo {
  device_id: string;
  device_name: string;
}

export function useSync() {
  const onlineDevices = ref<DiscoveredDevice[]>([]);
  const pairedDevices = ref<PairedDevice[]>([]);
  const records = ref<SyncRecord[]>([]);
  const deviceInfo = ref<DeviceInfo | null>(null);
  const pairCode = ref<PairCodeInfo | null>(null);

  async function refreshAll() {
    if (!isTauri) return;
    try {
      const [info, online, paired, recs] = await Promise.all([
        invoke<DeviceInfo>("sync_device_info"),
        invoke<DiscoveredDevice[]>("sync_online_list"),
        invoke<PairedDevice[]>("sync_paired_list"),
        invoke<SyncRecord[]>("sync_records_list"),
      ]);
      deviceInfo.value = info;
      onlineDevices.value = online;
      pairedDevices.value = paired;
      records.value = recs;
    } catch (e) {
      console.warn("sync refresh failed", e);
    }
  }

  async function refreshPairCode() {
    if (!isTauri) return;
    try {
      pairCode.value = await invoke<PairCodeInfo>("sync_pair_code");
    } catch (e) {
      console.warn("pair code failed", e);
    }
  }

  async function pairRequest(
    targetDeviceId: string,
    targetIp: string,
    targetPort: number,
    targetCode: string,
  ): Promise<void> {
    if (!isTauri) return;
    await invoke("sync_pair_request", {
      targetDeviceId,
      targetIp,
      targetPort,
      targetCode,
    });
  }

  async function pairRespond(
    fromId: string,
    fromName: string,
    fromIp: string,
    fromPort: number,
    accept: boolean,
  ): Promise<void> {
    if (!isTauri) return;
    await invoke("sync_pair_respond", {
      fromId,
      fromName,
      fromIp,
      fromPort,
      accept,
    });
  }

  async function unpair(deviceId: string): Promise<void> {
    if (!isTauri) return;
    await invoke("sync_unpair", { deviceId });
    await refreshAll();
  }

  async function upsertRecord(id: string, content: string): Promise<SyncRecord | null> {
    if (!isTauri) return null;
    const rec = await invoke<SyncRecord>("sync_record_upsert", { id, content });
    await refreshAll();
    return rec;
  }

  async function deleteRecord(id: string): Promise<void> {
    if (!isTauri) return;
    await invoke("sync_record_delete", { id });
    await refreshAll();
  }

  return {
    onlineDevices,
    pairedDevices,
    records,
    deviceInfo,
    pairCode,
    refreshAll,
    refreshPairCode,
    pairRequest,
    pairRespond,
    unpair,
    upsertRecord,
    deleteRecord,
  };
}
