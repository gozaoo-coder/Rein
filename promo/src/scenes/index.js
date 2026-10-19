/**
 * 场景注册表。
 *
 * `import.meta.glob` 自动收集同目录下的 NN-*.js —— 加一个爆点就是加一个文件，
 * 不用回来改这里。排序由 main.js 按 `at` 完成。
 *
 * 每个场景模块必须默认导出或具名导出 `createScene()`，返回：
 *   { id, label, at, dur, el, seek(localSeconds) }
 */
const mods = import.meta.glob('./[0-9]*.js', { eager: true })

export function createScenes() {
  return Object.keys(mods)
    .sort()
    .map((key) => {
      const mod = mods[key]
      const make = mod.createScene
      if (typeof make !== 'function') {
        throw new Error(`场景 ${key} 没有导出 createScene()`)
      }
      return make()
    })
}
