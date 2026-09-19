/**
 * 工作区工具：模态读取 + 目录治理（docs/ai-workspace.md §2、§3.3）。
 *
 * 与 notes.ts 的分工：notes 管「写文本文件」，这里管「取原模态」与「整理归类」。
 * 三者的共同约束由后端（files.rs / governance.rs）兜底，工具层只负责把话说清楚：
 * 降级是正常结果、pin 之后别动、保留区不要占。
 */

import { Type } from '@earendil-works/pi-ai'

import { kbService } from '@/services/kbService'
import { defineTool, type AppTool } from './types'

/** 文本模态直接回给模型的上限；全文要走 read_knowledge 分页读 */
const TEXT_INLINE_CAP = 1200

export const workspaceTools: AppTool[] = [
  defineTool({
    name: 'read_modal',
    group: 'knowledge',
    label: '取文件模态',
    description:
      '读取一个文件节点的模态清单，或指定模态取本体。音频/视频/图片的**字节不会进上下文**：' +
      '可用时返回元信息（mime、大小、时长）与「已把本体交给界面」的标记，不可用时**降级为文本**并给出原因。' +
      '先 glob_knowledge / search_knowledge 拿到 id；用户问「这段录音/视频里说了什么」时用它取文本模态，' +
      '需要完整文本再用 read_knowledge 分页读。',
    parameters: Type.Object({
      docId: Type.Number({ description: 'glob_knowledge / search_knowledge 返回的 id' }),
      modal: Type.Optional(
        Type.String({
          description: 'text | image | audio | video；不传只返回模态清单',
        }),
      ),
    }),
    async execute(args) {
      const m = await kbService.mediaGet(args.docId, args.modal?.trim() || undefined)
      const text =
        m.text && m.text.length > TEXT_INLINE_CAP
          ? `${m.text.slice(0, TEXT_INLINE_CAP)}…（还有更多，用 read_knowledge 分页读）`
          : m.text
      return {
        ok: true,
        path: m.path,
        title: m.title,
        kind: m.kind,
        modalities: m.modalities.map((x) => ({
          modal: x.modal,
          mime: x.mime,
          bytes: x.bytes,
          durationMs: x.durationMs,
          transcriptState: x.transcriptState,
        })),
        requested: m.requested,
        degraded: m.degraded,
        degradeReason: m.degradeReason,
        hasBody: !!m.dataUrl,
        tooLarge: m.tooLarge,
        hint: m.hint,
        text,
      }
    },
  }),

  defineTool({
    name: 'classify_move',
    group: 'knowledge',
    label: '归类文件',
    description:
      '把用户文件（笔记 / 上传 / 未分类内容）移进语义合适的目录（如「运动」「饮食」「日程」「用户记忆」）。' +
      '**这是你的整理职责**：新内容落在「未分类数据/」时，看内容判断归属并调用它，reason 写清依据。' +
      '约束：派生文档（目录里带日期或 -编号的）不可移动；被用户 pin 的文件会拒绝；一天内自动移动过的同一文件会被防抖挡住。' +
      '用户手动放好的东西不要动。',
    parameters: Type.Object({
      docId: Type.Number({ description: '要移动的文件 id（glob_knowledge 查）' }),
      toDir: Type.String({ description: '目标目录，如「运动」「饮食/知识」「笔记/训练」' }),
      reason: Type.String({ description: '为什么归到这里（一句话）' }),
    }),
    async execute(args) {
      const r = await kbService.fsMove(args.docId, args.toDir.trim(), args.reason.trim(), 'ai')
      return {
        ok: true,
        from: r.from,
        path: r.to,
        batchId: r.batchId,
        message: `已从 ${r.from} 归类到 ${r.to}`,
      }
    },
  }),

  defineTool({
    name: 'pin_file',
    group: 'knowledge',
    label: '钉住文件',
    description:
      '把文件钉住（pin）或取消钉住。钉住后 AI 的自动整理不再移动它——用户说「这个别乱动/固定在这里」时调用；' +
      '用户说「可以整理了」再取消。',
    parameters: Type.Object({
      docId: Type.Number({ description: '文件 id' }),
      pinned: Type.Boolean({ description: 'true 钉住，false 取消' }),
    }),
    async execute(args) {
      const f = await kbService.fsPin(args.docId, args.pinned, 'user')
      return { ok: true, path: f.path, pinned: f.pinned }
    },
  }),

  defineTool({
    name: 'make_folder',
    group: 'knowledge',
    label: '建目录',
    description:
      '在工作区里建一个目录（空目录也会显示在文件树里）。确实需要新的分类层级时才建，别为一次归类建一堆空目录；' +
      '深度最多 4 层。派生命名空间（日期目录、附件/）不能建。',
    parameters: Type.Object({
      path: Type.String({ description: '目录路径，如「运动/知识」' }),
      reason: Type.String({ description: '为什么需要这个目录' }),
    }),
    async execute(args) {
      const f = await kbService.fsMkdir(args.path.trim(), args.reason.trim(), 'ai')
      return { ok: true, path: f.path, message: `已建目录 ${f.path}` }
    },
  }),
]
