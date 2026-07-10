import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { readJSON, writeJSON } from "@/composables/useStorage";
import { pushChange, registerSyncEntity } from "@/composables/useSyncBridge";
import type { ActivityLevel, DietGoal, NutritionTarget } from "@/types/health";
import { calcAgeFromBirthday, calcNutritionTarget, calcWaterGoalMl } from "@/types/health";

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
  /** 饮食目标 */
  dietGoal: DietGoal;
  /** 活动水平 */
  activityLevel: ActivityLevel;
}

const USER_KEY = "user-profile";
const USER_REC_ID = "profile";

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
    dietGoal: "maintain",
    activityLevel: "moderate",
  };
}

/** 从生日计算年龄（周岁），无生日返回 0 — 转发到 health.ts 实现 */
export { calcAgeFromBirthday as computeAgeFromBirthday } from "@/types/health";

export const useUserStore = defineStore("user", () => {
  const profile = ref<UserProfile>(defaultProfile());
  const loaded = ref(false);
  const bmi = ref(0);

  const computedAge = computed(() => calcAgeFromBirthday(profile.value.birthday));

  /** 营养目标（热量/碳水/蛋白/脂肪）— 由 profile 推导 */
  const nutritionTarget = computed<NutritionTarget>(() =>
    calcNutritionTarget({
      gender: profile.value.gender,
      height: profile.value.height,
      weight: profile.value.weight,
      birthday: profile.value.birthday,
      dietGoal: profile.value.dietGoal,
      activityLevel: profile.value.activityLevel,
    }),
  );

  /** 每日饮水目标 ml — 体重 kg × 35 */
  const waterGoalMl = computed(() => calcWaterGoalMl(profile.value.weight));

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
    void pushChange(USER_KEY, USER_REC_ID, profile.value);
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
    void pushChange(USER_KEY, USER_REC_ID, profile.value);
  }

  return {
    profile,
    bmi,
    computedAge,
    nutritionTarget,
    waterGoalMl,
    load,
    setProfile,
    clearProfile,
    calculateBmi,
    persist,
    applyRemote,
  };
});

/** 远端同步应用：user-profile 单条（id="profile"） */
async function applyRemote(_id: string, payload: unknown, deleted: boolean): Promise<void> {
  if (deleted) return;
  const store = useUserStore();
  const incoming = payload as UserProfile;
  if (!incoming) return;
  store.profile = { ...defaultProfile(), ...incoming };
  store.calculateBmi();
  await writeJSON(USER_KEY, store.profile);
}

registerSyncEntity<UserProfile>({ kind: USER_KEY, applyRemote });
