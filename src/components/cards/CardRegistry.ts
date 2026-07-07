import { markRaw, type Component } from "vue";

/**
 * Global card component registry.
 * Maps card component string names to actual Vue components.
 * Used by EditableCard and StaticCard for dynamic :is resolution.
 */
const cardComponentMap = new Map<string, Component>();

export function registerCardComponents(components: Record<string, Component>) {
  for (const [name, comp] of Object.entries(components)) {
    cardComponentMap.set(name, markRaw(comp));
  }
}

export function getCardComponent(name: string): Component | undefined {
  return cardComponentMap.get(name);
}

export function hasCardComponent(name: string): boolean {
  return cardComponentMap.has(name);
}
