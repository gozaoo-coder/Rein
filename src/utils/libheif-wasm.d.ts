/**
 * libheif-js 只给 asm 版本配了 d.ts，我们要用的是免外部 .wasm 的那个 mjs 分包
 * （连带 libde265 的 HEVC 解码器一起，wasm 已内联成 base64），这里补一条最小声明。
 * 真正的形状由 `utils/heif.ts` 里的 HeifDecoder/HeifImage 负责。
 */
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  const createHeifModule: (opts?: Record<string, unknown>) => Promise<unknown>
  export default createHeifModule
}
