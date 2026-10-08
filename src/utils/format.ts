/**
 * 体积格式化。全应用共用一份：同一个体积在两个页面显示成不同精度（0 位 vs 1 位）
 * 是小事，但会让用户以为数据对不上。
 *
 * `decimals` 只影响 MB 档；GB 固定两位、KB 取整（档位之间差别本来就够大）。
 */
export function humanBytes(n: number, decimals = 1): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1073741824).toFixed(2)} GB`
  if (n >= 1024 * 1024) return `${(n / 1048576).toFixed(decimals)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}
