# 只暂存本会话的 AI 内核改动：agent 模块新文件 + lib.rs 中属于我的 hunk。
# 用途：工作区里还有并行会话的 healthsync 等未提交改动，不能整文件 git add。
# 用法（仓库根目录）：python .tmp/stage-mine.py
import re
import subprocess
import sys

LIB = 'src-tauri/src/lib.rs'
MINE = ('ai_agent', 'AgentHub', 'AI 内核', 'modules::ai::agent', 'ai_probe')

def sh(*args, check=True):
    r = subprocess.run(args, capture_output=True, text=True, check=False)
    if check and r.returncode != 0:
        sys.exit(f'FAILED: {" ".join(args)}\n{r.stdout}\n{r.stderr}')
    return r.stdout

sh('git', 'add', 'src-tauri/src/modules/ai/agent')

diff = sh('git', 'diff', '--', LIB)
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
    if l.startswith('+') and not l.startswith('+++') and any(k in l for k in MINE):
        keep = True
flush()

if not out:
    print('lib.rs: 没有属于本会话的 hunk（可能已提交）')
    sys.exit(0)

patch = '.tmp/libmine.patch'
open(patch, 'w', encoding='utf-8', newline='').write(''.join(out))
sh('git', 'apply', '--cached', patch)
print('已暂存 agent 模块 + lib.rs 的', sum(1 for l in out if l.startswith('@@')), '个 hunk')
