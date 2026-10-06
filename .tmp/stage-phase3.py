# 只暂存本会话的改动：新文件整文件 + 共享文件按 hunk 关键词过滤。
# 背景：工作区里还有并行会话的 healthsync 等未提交改动，不能整文件 git add。
# 用法（仓库根目录）：python .tmp/stage-phase3.py
import subprocess
import sys

# 整文件新增/我独占的文件
WHOLE = [
    'src/ai/rustAgent.ts',
    'src/services/agentService.ts',
    'src/ai/chat.ts',
    'src/ai/json.ts',
    'src/ai/probe.ts',
    'src/ai/smartGen.ts',
    'src/ai/todoGen.ts',
    'src/ai/recipeGen.ts',
    'src/ai/programReview.ts',
    'src/ai/autoSchedule.ts',
    'src/ai/memoryExtract.ts',
    'src/ai/memoryConsolidate.ts',
    'src/types/ai.ts',
    'scripts/e2e-ai-stream.mjs',
    'src-tauri/src/modules/ai/agent',
]

# 共享文件：只暂存含这些关键词的 hunk
SHARED = {
    'src/mock/server.ts': (
        'mockAgent', 'MockAgent', 'ai_agent', 'AI 内核', 'chunkMs',
        '__REIN_MOCK_AGENT_LOG__', 'playMockRun', 'waitMockToolResult',
        'splitChunks', 'defaultAgentScript',
    ),
    'src-tauri/src/lib.rs': (
        'ai_agent', 'AgentHub', 'AI 内核', 'modules::ai::agent', 'ai_probe',
    ),
}


def sh(*args, check=True):
    r = subprocess.run(args, capture_output=True, text=True, check=False)
    if check and r.returncode != 0:
        sys.exit(f'FAILED: {" ".join(args)}\n{r.stdout}\n{r.stderr}')
    return r.stdout


if WHOLE:
    sh('git', 'add', *WHOLE)

for path, keys in SHARED.items():
    diff = sh('git', 'diff', '--', path)
    if not diff.strip():
        print(f'{path}: 无改动')
        continue
    lines = diff.splitlines(keepends=True)
    out, buf, keep = [], [], False

    def flush():
        if keep:
            out.extend(buf)

    for l in lines:
        if l.startswith('@@'):
            flush()
            buf, keep = [l], False
            continue
        if l.startswith(('diff ', 'index ', '--- ', '+++ ')):
            out.append(l)
            continue
        buf.append(l)
        if l.startswith('+') and not l.startswith('+++') and any(k in l for k in keys):
            keep = True
    flush()
    hunks = sum(1 for l in out if l.startswith('@@'))
    if hunks == 0:
        print(f'{path}: 没有属于本会话的 hunk')
        continue
    patch = f'.tmp/{path.replace("/", "_")}.patch'
    open(patch, 'w', encoding='utf-8', newline='').write(''.join(out))
    sh('git', 'apply', '--cached', patch)
    print(f'{path}: 暂存 {hunks} 个 hunk')
