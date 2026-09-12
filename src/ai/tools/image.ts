/** 图片域工具：查看图片细节（放大镜）· 基于 imageZoom 会话注册表 */

import { Type } from '@earendil-works/pi-ai'

import { zoomImage } from '@/ai/imageZoom'
import { defineTool, type AppTool, type RawToolResult } from './types'

export const imageTools: AppTool[] = [
  defineTool({
    name: 'view_image_detail',
    group: 'image',
    label: '查看图片细节',
    description:
      '放大查看图片的局部区域，返回放大后的图片。当图片里文字太小、细节看不清时调用。' +
      'imageId 用图片清单里的编号（如 img-m1abc-0）；x/y 是区域左上角坐标、w/h 是区域宽高，' +
      '单位都是当前所见图片上的像素（每张图的视图尺寸见图片清单）。' +
      '返回的放大图会作为新图片（新编号）出现，可对它继续放大（最多 3 层）；坐标永远基于当前那张图，越界部分自动裁到边界内。',
    parameters: Type.Object({
      imageId: Type.String({ description: '要放大的图片编号，见消息图片清单' }),
      x: Type.Number({ description: '区域左上角 x（当前图片像素，从 0 开始）' }),
      y: Type.Number({ description: '区域左上角 y（当前图片像素，从 0 开始）' }),
      w: Type.Number({ description: '区域宽度（当前图片像素）' }),
      h: Type.Optional(Type.Number({ description: '区域高度（当前图片像素）；缺省与 w 相同（正方形）' })),
    }),
    rawContent: true,
    async execute(args) {
      const r = await zoomImage(args)
      const result: RawToolResult = {
        content: [
          { type: 'text', text: r.text },
          { type: 'image', data: r.imageBase64, mimeType: r.mime },
        ],
        // 元数据供 UI 持久化（放大图 id/尺寸/根图区域），历史重建时恢复可继续放大
        details: { zoomId: r.id, zoomW: r.viewW, zoomH: r.viewH, zoomDepth: r.depth, zoomRect: r.rect },
      }
      return result
    },
  }),
]
