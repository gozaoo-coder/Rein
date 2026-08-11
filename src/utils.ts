export function formatSessionTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfDay) / 86400000);
  if (diffDays <= 0) return hm;
  if (diffDays === 1) return `昨天 ${hm}`;
  if (diffDays < 7) {
    const w = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return `${w[d.getDay()]} ${hm}`;
  }
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

export function formatMessageTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function shouldShowTime(prev: { ts: number } | undefined, cur: { ts: number }): boolean {
  if (!prev) return true;
  return cur.ts - prev.ts > 5 * 60 * 1000;
}

export function previewText(s: string): string {
  const t = s.replace(/\n+/g, " ");
  return t.length > 40 ? t.slice(0, 40) + "…" : t;
}

export function newId(): string {
  return `fe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseSends(text: string): string[] {
  const blocks = text.match(/<send>[\s\S]*?<\/send>/g);
  if (!blocks || blocks.length === 0) return [text];
  return blocks.map((b) =>
    b
      .replace(/<\/?send>/g, "")
      .replace(/^\s+/, "")
      .replace(/\s+$/, ""),
  );
}
