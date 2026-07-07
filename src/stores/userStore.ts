import { defineStore } from "pinia";
import { ref } from "vue";

export interface UserProfile {
  id: string;
  nickname: string;
  avatar: string;
  gender: "male" | "female" | "other";
  age: number;
  height: number;
  weight: number;
  targetWeight: number;
}

export const useUserStore = defineStore("user", () => {
  const profile = ref<UserProfile>({
    id: "",
    nickname: "",
    avatar: "",
    gender: "other",
    age: 0,
    height: 0,
    weight: 0,
    targetWeight: 0,
  });

  function setProfile(data: Partial<UserProfile>) {
    Object.assign(profile.value, data);
  }

  function clearProfile() {
    profile.value = {
      id: "",
      nickname: "",
      avatar: "",
      gender: "other",
      age: 0,
      height: 0,
      weight: 0,
      targetWeight: 0,
    };
  }

  const bmi = ref(0);
  function calculateBmi() {
    if (profile.value.height > 0 && profile.value.weight > 0) {
      const heightM = profile.value.height / 100;
      bmi.value = parseFloat((profile.value.weight / (heightM * heightM)).toFixed(1));
    }
  }

  return { profile, bmi, setProfile, clearProfile, calculateBmi };
});
