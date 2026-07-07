<script setup lang="ts">
/**
 * ReinIcon — Inline SVG icon with HarmonyOS-style stroke.
 *
 * Uses a built-in path registry (no external icon dependency). Icons are
 * 24x24 viewBox, stroke-based, inherit currentColor.
 *
 * Add new icons to the ICON_PATHS map below.
 *
 * @example
 * <ReinIcon name="heart" :size="22" />
 * <ReinIcon name="activity" :size="22" stroke-width="2.2" />
 */
import { computed } from "vue";

type IconName =
  | "heart"
  | "activity"
  | "sparkles"
  | "user"
  | "run"
  | "walk"
  | "cycle"
  | "swim"
  | "yoga"
  | "strength"
  | "hiit"
  | "stretch"
  | "plus"
  | "edit"
  | "close"
  | "drag"
  | "play"
  | "pause"
  | "stop"
  | "location"
  | "map"
  | "clock"
  | "flame"
  | "drop"
  | "moon"
  | "trending-up"
  | "settings"
  | "chevron-right"
  | "chevron-down";

const ICON_PATHS: Record<IconName, string> = {
  heart:
    "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z",
  activity:
    "M12 8v4M8 12l-2 6M16 12l2 6M7 19h10",
  sparkles:
    "M12 2a7 7 0 0 1 7 7c0 3-1.5 4.5-3 6l-1 1v3h-6v-3l-1-1c-1.5-1.5-3-3-3-6a7 7 0 0 1 7-7z",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2",
  run: "M7 21l3-7 3 3 4-5-2-1-2.5 3-2.5-3-3 7z",
  walk: "M9 21l2-8 3 2v6M14 11l-4-3-2 2",
  swim: "M2 20c2-1 4-1 6 0s4 1 6 0 4-1 6 0M2 16c2-1 4-1 6 0s4 1 6 0 4-1 6 0",
  yoga: "M12 6v6M8 14l4 2 4-2M6 18h12M6 21l6-3 6 3",
  strength: "M6.5 6.5h11v11h-11zM3 9.5v5M21 9.5v5",
  hiit: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  stretch: "M12 7v5M8 20l4-8 4 8",
  plus: "M12 5v14M5 12h14",
  edit: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",
  close: "M18 6L6 18M6 6l12 12",
  drag: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  play: "M5 3l14 9-14 9V3z",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  stop: "M6 6h12v12H6z",
  location: "M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zM12 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  map: "M9 4l-6 2v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2",
  flame: "M12 2c1 3 5 5 5 9a5 5 0 0 1-10 0c0-2 1-3 2-4-1 4 3 5 3 1 0-2-2-4 0-6z",
  drop: "M12 2s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11z",
  moon: "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z",
  "trending-up": "M3 17l6-6 4 4 8-8M14 7h7v7",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  "chevron-right": "M9 18l6-6-6-6",
  "chevron-down": "M6 9l6 6 6-6",
};

const props = withDefaults(
  defineProps<{
    name: IconName;
    size?: number;
    strokeWidth?: number;
  }>(),
  {
    size: 22,
    strokeWidth: 2,
  }
);

const path = computed(() => ICON_PATHS[props.name]);

const hasCircle = computed(
  () =>
    props.name === "activity" ||
    props.name === "user" ||
    props.name === "run" ||
    props.name === "swim" ||
    props.name === "yoga" ||
    props.name === "play" ||
    props.name === "pause" ||
    props.name === "stop" ||
    props.name === "settings"
);

// For icons whose path starts with M and assumes a circle (head), prepend circle.
const circleFor = computed<{ cx: number; cy: number; r: number } | null>(() => {
  switch (props.name) {
    case "activity":
      return { cx: 12, cy: 5, r: 3 };
    case "user":
      return { cx: 12, cy: 8, r: 4 };
    case "run":
      return { cx: 12, cy: 5, r: 2 };
    case "swim":
      return { cx: 12, cy: 8, r: 2 };
    case "yoga":
      return { cx: 12, cy: 4, r: 2 };
    default:
      return null;
  }
});
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <circle
      v-if="circleFor"
      :cx="circleFor.cx"
      :cy="circleFor.cy"
      :r="circleFor.r"
    />
    <path v-if="name === 'drag'" :d="path" fill="currentColor" stroke="none" />
    <path v-else-if="name === 'play'" :d="path" fill="currentColor" stroke="none" />
    <path v-else-if="name === 'pause'" :d="path" fill="currentColor" stroke="none" />
    <path v-else-if="name === 'stop'" :d="path" fill="currentColor" stroke="none" />
    <path v-else :d="path" />
  </svg>
</template>
