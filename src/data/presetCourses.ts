/**
 * 预设课程 — 健身房三分化 (Push / Pull / Legs)
 *
 * 每个课程包含：热身 → 正式组（按动作）→ 拉伸
 * estimatedMinutes 与 estimatedCalories 按组数*平均耗时粗略估算。
 */

import type { Course, CourseStep } from "@/types/course";

const now = Date.now();

let stepSeq = 0;
function step(
  exerciseId: string,
  exerciseName: string,
  sets: number,
  reps?: number,
  durationSec?: number,
  restSec = 90,
  phase: CourseStep["phase"] = "main",
  note?: string,
  weight?: string,
  cautions?: string,
): CourseStep {
  stepSeq += 1;
  return {
    id: `cs-preset-${stepSeq}`,
    exerciseId,
    exerciseName,
    sets,
    reps,
    durationSec,
    restSec,
    phase,
    note,
    weight,
    cautions,
  };
}

function buildCourse(
  id: string,
  name: string,
  description: string,
  difficulty: Course["difficulty"],
  category: Course["category"],
  estimatedMinutes: number,
  estimatedCalories: number,
  steps: CourseStep[],
): Course {
  return {
    id,
    name,
    description,
    difficulty,
    category,
    estimatedMinutes,
    estimatedCalories,
    steps,
    pinned: false,
    custom: false,
    createdAt: now,
    updatedAt: now,
    practiceCount: 0,
  };
}

export const presetCourses: Course[] = [
  // ===== 推日 =====
  buildCourse(
    "course-push-day",
    "推日：胸/肩/三头",
    "经典健身房推日训练，胸大肌为主，肩与三头辅助。",
    "intermediate",
    "push",
    65,
    420,
    [
      step("ex-jumping-jacks", "开合跳", 3, undefined, 30, 30, "warmup", "全身激活", "自重"),
      step("ex-cat-cow", "猫牛式", 2, undefined, 30, 20, "warmup", "肩胛活动", "徒手"),
      step("ex-barbell-bench-press", "杠铃卧推", 4, 8, undefined, 120, "main", "主项，重量递增", "60kg 起，逐组加片"),
      step("ex-incline-dumbbell-press", "上斜哑铃推举", 3, 10, undefined, 90, "main", "上胸", "12kg/只"),
      step("ex-dumbbell-shoulder-press", "哑铃肩推", 3, 10, undefined, 90, "main", "三角肌前束", "10kg/只"),
      step("ex-lateral-raise", "哑铃侧平举", 3, 12, undefined, 60, "main", "中束孤立", "6kg/只"),
      step("ex-tricep-pushdown", "绳索下压", 3, 12, undefined, 60, "main", "三头", "20kg"),
      step("ex-overhead-tricep-extension", "颈后臂屈伸", 2, 12, undefined, 60, "main", "三头长头", "12kg"),
      step("ex-pec-deck", "蝴蝶机夹胸", 2, 15, undefined, 45, "main", "胸肌收尾", "25kg"),
      step("ex-chest-stretch", "胸部拉伸", 2, undefined, 30, 15, "stretch", undefined, "徒手"),
      step("ex-shoulder-stretch", "肩部拉伸", 2, undefined, 30, 15, "stretch", undefined, "徒手"),
    ],
  ),

  // ===== 拉日 =====
  buildCourse(
    "course-pull-day",
    "拉日：背/二头",
    "经典健身房拉日训练，背阔为主，背部厚度与二头辅助。",
    "intermediate",
    "pull",
    65,
    440,
    [
      step("ex-jumping-jacks", "开合跳", 3, undefined, 30, 30, "warmup", undefined, "自重"),
      step("ex-cat-cow", "猫牛式", 2, undefined, 30, 20, "warmup", "脊柱活动", "徒手"),
      step("ex-lat-pulldown", "高位下拉", 4, 10, undefined, 90, "main", "背阔宽度", "45kg"),
      step("ex-barbell-row", "杠铃划船", 4, 8, undefined, 120, "main", "背部厚度", "50kg"),
      step("ex-seated-cable-row", "坐姿绳索划船", 3, 10, undefined, 90, "main", "中背", "40kg"),
      step("ex-dumbbell-row", "单臂哑铃划船", 3, 10, undefined, 60, "main", "单侧背阔", "18kg"),
      step("ex-face-pull", "面拉", 3, 15, undefined, 60, "main", "后束与肩袖", "15kg"),
      step("ex-barbell-curl", "杠铃弯举", 3, 10, undefined, 60, "main", "二头主项", "25kg"),
      step("ex-dumbbell-curl", "哑铃交替弯举", 2, 12, undefined, 45, "main", "二头孤立", "8kg/只"),
      step("ex-lat-stretch", "背阔拉伸", 2, undefined, 30, 15, "stretch", undefined, "徒手"),
      step("ex-shoulder-stretch", "肩部拉伸", 2, undefined, 30, 15, "stretch", undefined, "徒手"),
    ],
  ),

  // ===== 腿日 =====
  buildCourse(
    "course-legs-day",
    "腿日：大腿/小腿",
    "经典健身房腿日训练，股四为主，腿后侧与小腿辅助。",
    "intermediate",
    "legs",
    70,
    520,
    [
      step("ex-jumping-jacks", "开合跳", 3, undefined, 30, 30, "warmup", undefined, "自重"),
      step("ex-cat-cow", "猫牛式", 2, undefined, 30, 20, "warmup", undefined, "徒手"),
      step("ex-barbell-squat", "杠铃深蹲", 4, 8, undefined, 150, "main", "主项，重量递增", "70kg 起，需护腰"),
      step("ex-romanian-deadlift", "罗马尼亚硬拉", 3, 10, undefined, 120, "main", "腿后侧", "60kg"),
      step("ex-leg-press", "倒蹬", 3, 12, undefined, 90, "main", "大腿前侧", "100kg"),
      step("ex-walking-lunge", "行走箭步蹲", 3, 12, undefined, 60, "main", "腿与臀", "10kg/只"),
      step("ex-leg-extension", "坐姿腿屈伸", 2, 15, undefined, 60, "main", "股四孤立", "30kg"),
      step("ex-leg-curl", "俯卧腿弯举", 2, 12, undefined, 60, "main", "股二头孤立", "25kg"),
      step("ex-calf-raise", "站姿提踵", 3, 15, undefined, 45, "main", "小腿", "40kg"),
      step("ex-quad-stretch", "股四头拉伸", 2, undefined, 30, 15, "stretch", undefined, "徒手"),
      step("ex-hamstring-stretch", "腿后侧拉伸", 2, undefined, 30, 15, "stretch", undefined, "徒手"),
      step("ex-hip-flexor-stretch", "髂腰肌拉伸", 2, undefined, 30, 15, "stretch", undefined, "徒手"),
      step("ex-calf-stretch", "小腿拉伸", 2, undefined, 30, 15, "stretch", undefined, "徒手"),
    ],
  ),
];
