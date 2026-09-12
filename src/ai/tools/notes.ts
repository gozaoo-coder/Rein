/** 笔记工具：知识库里唯一可由 AI 创建/编辑/删除的真实文件（kb_files） */

import { Type } from '@earendil-works/pi-ai'

import { kbService } from '@/services/kbService'
import { defineTool, type AppTool } from './types'

/** 笔记统一落在「笔记/」命名空间，规范（规范/）是系统文件不可写 */
const PATH_DESC =
  '文件路径，自动归到「笔记/」下（写「膝盖」会存为 笔记/膝盖.md，.md 可省略）。' +
  '可用子目录分层，如「训练/膝盖注意」。'

export const noteTools: AppTool[] = [
  defineTool({
    name: 'write_note',
    group: 'knowledge',
    label: '写笔记',
    description:
      '在知识库里新建或覆盖一篇 markdown 笔记（按路径幂等：同路径即覆盖）。' +
      '**仅当用户明确要求「记下来/写个笔记/帮我存一下」时调用**；对话里的偏好由系统在会话结束时自动提炼，不要用笔记代替记忆。' +
      '内容写 markdown；要记住的是「关于用户的认知」时改用 remember。',
    parameters: Type.Object({
      path: Type.String({ description: PATH_DESC }),
      content: Type.String({ description: 'markdown 正文，不能为空' }),
    }),
    async execute(args) {
      const content = args.content.trim()
      if (!content) throw new Error('笔记内容不能为空')
      const f = await kbService.fileWrite({ path: args.path.trim(), content })
      return { ok: true, id: f.id, path: f.path, message: `已保存到 ${f.path}` }
    },
  }),

  defineTool({
    name: 'rename_note',
    group: 'knowledge',
    label: '笔记改名',
    description:
      '给笔记改名或移动到子目录（先 glob_knowledge 查路径）。**仅当用户明确要求时调用。**',
    parameters: Type.Object({
      docId: Type.Number({ description: 'glob_knowledge / search_knowledge 返回的 id' }),
      path: Type.String({ description: PATH_DESC }),
    }),
    async execute(args) {
      const f = await kbService.fileRename(args.docId, args.path.trim())
      return { ok: true, path: f.path, message: `已改名为 ${f.path}` }
    },
  }),

  defineTool({
    name: 'delete_note',
    group: 'knowledge',
    label: '删笔记',
    description: '删除一篇笔记。**仅当用户明确要求删除时调用**（先 glob_knowledge 查 id）。',
    parameters: Type.Object({
      docId: Type.Number({ description: '笔记的 id' }),
    }),
    dangerous: true,
    async execute(args) {
      await kbService.fileDelete(args.docId)
      return { ok: true, message: '已删除该笔记' }
    },
  }),
]
