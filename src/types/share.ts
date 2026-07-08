/**
 * Share — 分享功能类型定义
 *
 * 适配 QQ / 微信 等发送端：通过 Web Share API 触发系统分享面板，
 * 由系统列出 QQ / 微信 等目标应用；不支持时回退到剪贴板复制。
 *
 * 支持文本与图片两种模式：图片由 SVG 模板 + Canvas 光栅化生成。
 */

/** 分享内容种类 — 决定文本/图片模板 */
export type ShareKind =
  | "ai-chat"
  | "course-detail"
  | "exercise-detail"
  | "workout-end"
  | "workout-history";

/** 分享模式 */
export type ShareMode = "text" | "image";

/** 分享目标渠道提示（仅 UI 提示，实际由系统面板路由） */
export type ShareChannel = "system" | "qq" | "wechat" | "copy" | "save";

/** 已格式化的分享内容 */
export interface ShareContent {
  kind: ShareKind;
  /** 标题（系统分享面板标题、图片大字） */
  title: string;
  /** 正文文本（用于文本模式） */
  text: string;
  /** 图片 SVG 模板（用于图片模式），未提供则不支持图片分享 */
  svg?: string;
  /** 图片文件名（不含扩展名） */
  imageName?: string;
}

/** useShare 返回值 */
export interface UseShareResult {
  /** 是否支持原生 Web Share API */
  canShareNative: boolean;
  /** 是否支持文件分享（图片） */
  canShareFiles: boolean;
  /** 分享文本 */
  shareText: (content: ShareContent) => Promise<boolean>;
  /** 分享图片（自动光栅化 SVG） */
  shareImage: (content: ShareContent) => Promise<boolean>;
  /** 复制文本到剪贴板 */
  copyText: (content: ShareContent) => Promise<boolean>;
  /** 保存图片到本地（通过下载） */
  saveImage: (content: ShareContent) => Promise<boolean>;
}
