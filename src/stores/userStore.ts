import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { readJSON, writeJSON } from "@/composables/useStorage";

export interface UserProfile {
  id: string;
  nickname: string;
  avatar: string;
  gender: "male" | "female" | "other";
  /** 生日 YYYY-MM-DD（空串表示未设置） */
  birthday: string;
  height: number;
  weight: number;
  targetWeight: number;
}

const USER_KEY = "user-profile";

function defaultProfile(): UserProfile {
  return {
    id: "",
    nickname: "",
    avatar: "",
    gender: "other",
    birthday: "",
    height: 0,
    weight: 0,
    targetWeight: 0,
  };
}

/** 从生日计算年龄（周岁），无生日返回 0 */
export function computeAgeFromBirthday(birthday: string): number {
  if (!birthday) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday.trim());
  if (!m) return 0;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return 0;
  const now = new Date();
  let age = now.getFullYear() - y;
  if (
    now.getMonth() + 1 < mo ||
    (now.getMonth() + 1 === mo && now.getDate() < d)
  ) {
    age -= 1;
  }
  return age > 0 ? age : 0;
}

export const useUserStore = defineStore("user", () => {
  const profile = ref<UserProfile>(defaultProfile());
  const loaded = ref(false);
  const bmi = ref(0);

  const computedAge = computed(() => computeAgeFromBirthday(profile.value.birthday));

  async function load(): Promise<void> {
    if (loaded.value) return;
    const v = await readJSON<UserProfile>(USER_KEY);
    if (v) {
      // 兼容旧版 age 字段：旧版无 birthday 时无法回填
      profile.value = { ...defaultProfile(), ...v };
    }
    loaded.value = true;
    calculateBmi();
  }

  async function persist(): Promise<void> {
    await writeJSON(USER_KEY, profile.value);
  }

  function setProfile(data: Partial<UserProfile>): void {
    Object.assign(profile.value, data);
    calculateBmi();
    // fire-and-forget 持久化
    void persist();
  }

  function calculateBmi(): void {
    if (profile.value.height > 0 && profile.value.weight > 0) {
      const heightM = profile.value.height / 100;
      bmi.value = parseFloat((profile.value.weight / (heightM * heightM)).toFixed(1));
    } else {
      bmi.value = 0;
    }
  }

  async function clearProfile(): Promise<void> {
    profile.value = defaultProfile();
    bmi.value = 0;
    await persist();
  }

  return {
    profile,
    bmi,
    computedAge,
    load,
    setProfile,
    clearProfile,
    calculateBmi,
    persist,
  };
});
