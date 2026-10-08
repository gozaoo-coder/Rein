/**
 * 工作区工具：模态读取 + 目录治理 + 文件挂出（docs/ai-workspace.md §2、§3.3、§5）。
 *
 * 与 notes.ts 的分工：notes 管「写文本文件」，这里管「取原模态」与「整理归类」。
 * 三者的共同约束由后端（files.rs / governance.rs）兜底，工具层只负责把话说清楚：
 * 降级是正常结果、pin 之后别动、保留区不要占。
 */

import { Type } from '@earendil-works/pi-ai'

import { kbService } from '@/services/kbService'
import type { KbEntry } from '@/types'
import { defineTool, type AppTool } from './types'

/** 文本模态直接回给模型的上限；全文要走 read_knowledge 分页读 */
const TEXT_INLINE_CAP = 1200

/**
 * present_file 的路径候选（目录, 完整路径）。
 *
 * **与 Rust `listing::find_entry` 是同一套规则**（浏览器 mock 模式走这里、真机走 Rust）：
 * 原样 → 补 `.md`（笔记的规范后缀）→ 省根目录时归「笔记/」（与 write_note 的归位规则同约定）。
 * 顺序是「越精确越先」，所以同名的目录不会被 `.md` 变体抢走。
 */
function presentCandidates(path: string): { dir: string; full: string }[] {
  const want = path.trim().replace(/^\/+|\/+$/g, '')
  if (!want || want.split('/').some((s) => s === '..')) return []
  const cut = want.lastIndexOf('/')
  const dir = cut > 0 ? want.slice(0, cut) : ''
  const leaf = cut > 0 ? want.slice(cut + 1) : want
  const out = [{ dir, full: want }]
  if (!leaf.toLowerCase().endsWith('.md')) out.push({ dir, full: `${want}.md` })
  if (!dir) out.push({ dir: '笔记', full: `笔记/${leaf.replace(/\.md$/i, '')}.md` })
  return out
}

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

  defineTool({
    name: 'present_file',
    group: 'knowledge',
    label: '挂出文件',
    description:
      '把一个工作区文件作为**文件卡片**挂到聊天里给用户（卡片可点开阅读，目录卡片可跳进文件管理器）。' +
      '用户会想点开看、或需要一份产物的场景才挂：刚写好的笔记、解压 / 导出出来的文件、他一直在找的那份东西 —— ' +
      '讲完内容顺手挂一张，别只在文字里报个路径。path 用 glob_knowledge / write_note / list_archive 结果里的那个 path' +
      '（少写 .md 后缀、或省掉「笔记/」根目录也认）。一次回复挂 1~3 张就够，铺满卡片反而没人看；' +
      '纯内部整理（归类、建目录、钉住）不要挂。',
    parameters: Type.Object({
      path: Type.String({ description: '文件或目录路径，如 笔记/膝盖养护.md、未分类数据/解压/备份' }),
    }),
    async execute(args) {
      const listed = new Map<string, KbEntry[]>()
      for (const cand of presentCandidates(args.path)) {
        if (!listed.has(cand.dir)) {
          const l = await kbService.listDir(cand.dir)
          listed.set(cand.dir, l.entries)
        }
        const hit = listed.get(cand.dir)?.find((e) => e.path === cand.full)
        if (hit) {
          return { ok: true, file: hit, message: `已把「${hit.name}」挂到聊天里，用户可点开` }
        }
      }
      throw new Error(
        `工作区里没有这个路径：${args.path.trim()}。先用 glob_knowledge 查（如 笔记/**、未分类数据/**），再按它返回的 path 调用本工具`,
      )
    },
  }),
]
