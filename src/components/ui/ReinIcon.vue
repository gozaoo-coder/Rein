<script setup lang="ts">
/**
 * ReinIcon — Bootstrap Icons wrapper.
 *
 * Renders a Bootstrap Icon <i> element with configurable size.
 * IconName maps to Bootstrap icon classes via the BI_MAP below.
 *
 * @example
 * <ReinIcon name="heart" :size="22" />
 * <ReinIcon name="activity" :size="22" />
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

const BI_MAP: Record<IconName, string> = {
  heart: "heart-fill",
  activity: "activity",
  sparkles: "stars",
  user: "person-circle",
  run: "universal-access",
  walk: "universal-access",
  cycle: "bicycle",
  swim: "universal-access",
  yoga: "universal-access",
  strength: "bullseye",
  hiit: "lightning-charge",
  stretch: "universal-access",
  plus: "plus-lg",
  edit: "pencil-square",
  close: "x-lg",
  drag: "grip-vertical",
  play: "play-fill",
  pause: "pause-fill",
  stop: "stop-fill",
  location: "geo-alt-fill",
  map: "map",
  clock: "clock",
  flame: "fire",
  drop: "droplet-fill",
  moon: "moon-stars-fill",
  "trending-up": "graph-up-arrow",
  settings: "gear-fill",
  "chevron-right": "chevron-right",
  "chevron-down": "chevron-down",
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

const biName = computed(() => BI_MAP[props.name]);
</script>

<template>
  <i
    :class="['bi', `bi-${biName}`]"
    :style="{ fontSize: size + 'px', lineHeight: 1 }"
    aria-hidden="true"
  ></i>
</template>
