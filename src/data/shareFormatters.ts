/**
 * shareFormatters — 各类业务数据 → ShareContent 的纯函数格式化器
 *
 * 每个格式化器返回：
 *   title: 简短标题（系统面板标题）
 *   text:  纯文本正文（含换行，便于微信/QQ 粘贴）
 *   svg:   1080x1920 海报 SVG（图片模式）
 *
 * SVG 模板使用沉浸光感设计 token：暖橙渐变 + 玻璃白卡 + HarmonyOS Sans。
 */

import type { ShareContent, ShareKind } from "@/types/share";
import type { Conversation } from "@/types/ai";
import type { Course, CourseStep } from "@/types/course";
import {
  CATEGORY_LABEL,
  DIFFICULTY_LABEL,
} from "@/types/course";
import type { Exercise } from "@/types/exercise";
import {
  EXERCISE_CATEGORY_LABEL,
  EXERCISE_DIFFICULTY_LABEL,
  MUSCLE_GROUP_LABEL,
} from "@/types/exercise";
import type { WorkoutRecord } from "@/types/workout-stats";

const APP_BRAND = "Rein";

/** HTML 转义，避免 SVG/文本注入 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 多行文本 → SVG <text> 多行（每行 dy 偏移） */
function svgMultiline(
  lines: string[],
  x: number,
  y: number,
  fontSize: number,
  color: string,
  lineHeight = 1.5,
  weight = 400,
  anchor: "start" | "middle" = "start",
): string {
  return lines
    .map((line, i) => {
      const dy = i === 0 ? 0 : fontSize * lineHeight;
      return `<text x="${x}" y="${y}" font-size="${fontSize}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}" dy="${dy * i}">${esc(line)}</text>`;
    })
    .join("");
}

/** SVG 海报外壳 — 渐变背景 + 顶部品牌 + 底部水印 */
function svgPoster(body: string, accent = "#ff6633"): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920" font-family="HarmonyOS Sans, PingFang SC, Microsoft YaHei, sans-serif">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff3ee"/>
    <stop offset="1" stop-color="#ffe2d6"/>
  </linearGradient>
  <radialGradient id="halo" cx="0.5" cy="0.2" r="0.8">
    <stop offset="0" stop-color="${accent}" stop-opacity="0.25"/>
    <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
  </radialGradient>
  <filter id="cardShadow" x="-10%" y="-10%" width="120%" height="120%">
    <feDropShadow dx="0" dy="8" stdDeviation="20" flood-color="#000" flood-opacity="0.10"/>
  </filter>
</defs>
<rect width="1080" height="1920" fill="url(#bg)"/>
<rect width="1080" height="1920" fill="url(#halo)"/>
${body}
<text x="540" y="1820" font-size="28" fill="#8e8e93" text-anchor="middle" font-weight="500">— 由 ${APP_BRAND} 生成 —</text>
</svg>`;
}

function posterHeader(title: string, subtitle: string, accent: string): string {
  return `
  <text x="540" y="180" font-size="36" fill="#8e8e93" text-anchor="middle" font-weight="600" letter-spacing="6">${APP_BRAND.toUpperCase()}</text>
  <text x="540" y="280" font-size="80" fill="#1c1c1e" text-anchor="middle" font-weight="700">${esc(title)}</text>
  <text x="540" y="340" font-size="32" fill="#636366" text-anchor="middle" font-weight="500">${esc(subtitle)}</text>
  <rect x="490" y="370" width="100" height="6" rx="3" fill="${accent}"/>
  `;
}

function posterCard(y: number, body: string): string {
  return `<g filter="url(#cardShadow)">
    <rect x="80" y="${y}" width="920" height="auto" rx="32" fill="#ffffff" fill-opacity="0.92"/>
  </g>
  ${body}`;
}

/* ============ AI 聊天 ============ */

export function formatAiChat(conversation: Conversation): ShareContent {
  const lines: string[] = [`【${conversation.title}】`];
  for (const m of conversation.messages) {
    if (m.role === "system" || m.role === "tool") continue;
    const tag = m.role === "user" ? "我" : "AI";
    const txt =
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("");
    if (!txt.trim()) continue;
    // 每条消息限 300 字，避免超长分享
    const trimmed = txt.length > 300 ? txt.slice(0, 300) + "…" : txt;
    lines.push(`\n${tag}：${trimmed}`);
  }
  lines.push(`\n— 由 ${APP_BRAND} AI 助手生成`);

  const text = lines.join("\n");

  // 图片模式：仅展示前 4 轮对话摘要
  const dialogueLines: string[] = [];
  let shown = 0;
  for (const m of conversation.messages) {
    if (shown >= 4) {
      dialogueLines.push("…（更多请见对话）");
      break;
    }
    if (m.role === "system" || m.role === "tool") continue;
    const tag = m.role === "user" ? "我" : "AI";
    const txt =
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("");
    if (!txt.trim()) continue;
    const trimmed = txt.length > 80 ? txt.slice(0, 80) + "…" : txt;
    dialogueLines.push(`${tag}：${trimmed}`);
    shown += 1;
  }
  if (dialogueLines.length === 0) dialogueLines.push("（无消息）");

  const dialogueSvg = svgMultiline(dialogueLines, 130, 560, 36, "#1c1c1e", 1.7, 500);
  const svg = svgPoster(`
    ${posterHeader(conversation.title, "AI 对话摘录", "#ac49f5")}
    <g filter="url(#cardShadow)">
      <rect x="80" y="480" width="920" height="${160 + dialogueLines.length * 60}" rx="32" fill="#ffffff" fill-opacity="0.92"/>
    </g>
    ${dialogueSvg}
  `, "#ac49f5");

  return {
    kind: "ai-chat" as ShareKind,
    title: `${conversation.title} — ${APP_BRAND} AI`,
    text,
    svg,
    imageName: `rein-ai-${conversation.id}`,
  };
}

/* ============ 课程详情 ============ */

function stepBrief(s: CourseStep): string {
  const parts: string[] = [s.exerciseName];
  parts.push(`${s.sets}组`);
  if (s.reps != null) parts.push(`${s.reps}次`);
  else if (s.durationSec != null) parts.push(`${s.durationSec}秒`);
  if (s.weight) parts.push(`配重 ${s.weight}`);
  return parts.join(" · ");
}

export function formatCourseDetail(course: Course): ShareContent {
  const lines: string[] = [
    `《${course.name}》`,
    `${CATEGORY_LABEL[course.category]} · ${DIFFICULTY_LABEL[course.difficulty]}`,
    `预计 ${course.estimatedMinutes} 分钟 · ${course.estimatedCalories} 千卡`,
  ];
  if (course.description) lines.push(`\n${course.description}`);
  lines.push(`\n训练组（${course.steps.length}）：`);
  course.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${stepBrief(s)}`);
  });
  lines.push(`\n— 来自 ${APP_BRAND} 训练计划`);
  const text = lines.join("\n");

  // 图片模式：仅展示前 5 组
  const stepLines = course.steps.slice(0, 5).map((s, i) => `${i + 1}. ${stepBrief(s)}`);
  if (course.steps.length > 5) stepLines.push(`… 共 ${course.steps.length} 组`);

  const stepsSvg = svgMultiline(stepLines, 130, 700, 34, "#1c1c1e", 1.8, 500);
  const subtitle = `${CATEGORY_LABEL[course.category]} · ${DIFFICULTY_LABEL[course.difficulty]} · ${course.estimatedMinutes} 分钟`;
  const svg = svgPoster(`
    ${posterHeader(course.name, subtitle, "#ff6633")}
    <g filter="url(#cardShadow)">
      <rect x="80" y="620" width="920" height="${180 + stepLines.length * 62}" rx="32" fill="#ffffff" fill-opacity="0.92"/>
    </g>
    <text x="130" y="680" font-size="32" fill="#8e8e93" font-weight="600">训练组（${course.steps.length}）</text>
    ${stepsSvg}
  `, "#ff6633");

  return {
    kind: "course-detail" as ShareKind,
    title: `《${course.name}》— ${APP_BRAND}`,
    text,
    svg,
    imageName: `rein-course-${course.id}`,
  };
}

/* ============ 动作详情 ============ */

export function formatExerciseDetail(exercise: Exercise): ShareContent {
  const lines: string[] = [
    `【${exercise.name}】`,
    `${EXERCISE_CATEGORY_LABEL[exercise.category]} · ${MUSCLE_GROUP_LABEL[exercise.muscleGroup]} · ${EXERCISE_DIFFICULTY_LABEL[exercise.difficulty]}`,
  ];
  if (exercise.equipment) lines.push(`器械：${exercise.equipment}`);
  if (exercise.description) lines.push(`\n${exercise.description}`);
  if (exercise.executionDetails) lines.push(`\n动作要领：\n${exercise.executionDetails}`);
  if (exercise.cautions) lines.push(`\n注意事项：\n${exercise.cautions}`);
  lines.push(`\n— 来自 ${APP_BRAND} 动作库`);
  const text = lines.join("\n");

  // 图片模式：精简展示
  const cardLines: string[] = [];
  if (exercise.equipment) cardLines.push(`器械：${exercise.equipment}`);
  if (exercise.description) {
    const d = exercise.description.length > 100 ? exercise.description.slice(0, 100) + "…" : exercise.description;
    cardLines.push(d);
  }
  if (exercise.executionDetails) {
    const d = exercise.executionDetails.length > 120 ? exercise.executionDetails.slice(0, 120) + "…" : exercise.executionDetails;
    cardLines.push(`要领：${d}`);
  }
  if (exercise.cautions) {
    const d = exercise.cautions.length > 80 ? exercise.cautions.slice(0, 80) + "…" : exercise.cautions;
    cardLines.push(`注意：${d}`);
  }

  const cardSvg = svgMultiline(cardLines, 130, 700, 34, "#1c1c1e", 1.8, 500);
  const subtitle = `${EXERCISE_CATEGORY_LABEL[exercise.category]} · ${MUSCLE_GROUP_LABEL[exercise.muscleGroup]}`;
  const svg = svgPoster(`
    ${posterHeader(exercise.name, subtitle, "#3da9ff")}
    <g filter="url(#cardShadow)">
      <rect x="80" y="620" width="920" height="${180 + cardLines.length * 62}" rx="32" fill="#ffffff" fill-opacity="0.92"/>
    </g>
    ${cardSvg}
  `, "#3da9ff");

  return {
    kind: "exercise-detail" as ShareKind,
    title: `【${exercise.name}】— ${APP_BRAND}`,
    text,
    svg,
    imageName: `rein-exercise-${exercise.id}`,
  };
}

/* ============ 运动结束 ============ */

export interface WorkoutEndPayload {
  courseName: string;
  durationSec: number;
  caloriesBurned: number;
  completedSets: number;
  totalSets: number;
  avgHeartRate?: number;
  finished: boolean;
}

export function formatWorkoutEnd(p: WorkoutEndPayload): ShareContent {
  const mm = Math.floor(p.durationSec / 60);
  const ss = p.durationSec % 60;
  const duration = `${mm}:${String(ss).padStart(2, "0")}`;
  const status = p.finished ? "训练完成" : "训练结束";

  const text = [
    `${status}！`,
    `课程：${p.courseName}`,
    `时长：${duration}`,
    `消耗：${Math.round(p.caloriesBurned)} 千卡`,
    `组数：${p.completedSets}/${p.totalSets}`,
    p.avgHeartRate ? `平均心率：${p.avgHeartRate} BPM` : "",
    `\n我在 ${APP_BRAND} 完成了一次训练，继续坚持！`,
  ]
    .filter(Boolean)
    .join("\n");

  const cardLines = [
    `时长  ${duration}`,
    `消耗  ${Math.round(p.caloriesBurned)} 千卡`,
    `组数  ${p.completedSets}/${p.totalSets}`,
    p.avgHeartRate ? `心率  ${p.avgHeartRate} BPM` : "",
  ].filter(Boolean);

  const cardSvg = svgMultiline(cardLines, 130, 980, 42, "#1c1c1e", 2.0, 600);
  const svg = svgPoster(`
    ${posterHeader(status + "！", p.courseName, "#64bb5c")}
    <g filter="url(#cardShadow)">
      <rect x="80" y="900" width="920" height="${180 + cardLines.length * 84}" rx="32" fill="#ffffff" fill-opacity="0.92"/>
    </g>
    ${cardSvg}
  `, "#64bb5c");

  return {
    kind: "workout-end" as ShareKind,
    title: `${status} — ${APP_BRAND}`,
    text,
    svg,
    imageName: `rein-workout-end-${Date.now().toString(36)}`,
  };
}

/* ============ 历史运动详情 ============ */

export function formatWorkoutHistory(record: WorkoutRecord): ShareContent {
  const startDate = new Date(record.startedAt);
  const mm = Math.floor(record.durationSec / 60);
  const ss = record.durationSec % 60;
  const duration = `${mm}:${String(ss).padStart(2, "0")}`;
  const dateStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")} ${String(startDate.getHours()).padStart(2, "0")}:${String(startDate.getMinutes()).padStart(2, "0")}`;

  const text = [
    `历史运动记录`,
    `课程：${record.courseName}`,
    `时间：${dateStr}`,
    `时长：${duration}`,
    `消耗：${Math.round(record.caloriesBurned)} 千卡`,
    `组数：${record.completedSets}/${record.totalSets}`,
    record.avgHeartRate ? `平均心率：${record.avgHeartRate} BPM` : "",
    record.maxHeartRate ? `最大心率：${record.maxHeartRate} BPM` : "",
    `状态：${record.finished ? "已完成" : "中途退出"}`,
    `\n— 来自 ${APP_BRAND} 运动记录`,
  ]
    .filter(Boolean)
    .join("\n");

  const cardLines = [
    `时间  ${dateStr}`,
    `时长  ${duration}`,
    `消耗  ${Math.round(record.caloriesBurned)} 千卡`,
    `组数  ${record.completedSets}/${record.totalSets}`,
    record.avgHeartRate ? `均心率  ${record.avgHeartRate} BPM` : "",
    `状态  ${record.finished ? "已完成" : "中途退出"}`,
  ].filter(Boolean);

  const cardSvg = svgMultiline(cardLines, 130, 980, 38, "#1c1c1e", 1.9, 500);
  const svg = svgPoster(`
    ${posterHeader(record.courseName, "历史运动记录", "#ff8c3a")}
    <g filter="url(#cardShadow)">
      <rect x="80" y="900" width="920" height="${180 + cardLines.length * 76}" rx="32" fill="#ffffff" fill-opacity="0.92"/>
    </g>
    ${cardSvg}
  `, "#ff8c3a");

  return {
    kind: "workout-history" as ShareKind,
    title: `${record.courseName} 历史记录 — ${APP_BRAND}`,
    text,
    svg,
    imageName: `rein-history-${record.id}`,
  };
}
