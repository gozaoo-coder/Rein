def hx(h):
    h = h.lstrip('#')
    return [int(h[i:i+2], 16) / 255 for i in (0, 2, 4)]

def lum(h):
    r, g, b = hx(h)
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = f(r), f(g), f(b)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

def cr(a, b):
    l1, l2 = lum(a), lum(b)
    if l1 < l2:
        l1, l2 = l2, l1
    return (l1 + 0.05) / (l2 + 0.05)

def lab(h):
    r, g, b = hx(h)
    f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = f(r), f(g), f(b)
    X = r * 0.4124 + g * 0.3576 + b * 0.1805
    Y = r * 0.2126 + g * 0.7152 + b * 0.0722
    Z = r * 0.0193 + g * 0.1192 + b * 0.9505
    q = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    fx, fy, fz = q(X / 0.95047), q(Y), q(Z / 1.08883)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))

def dE(a, b):
    l1, a1, b1 = lab(a)
    l2, a2, b2 = lab(b)
    return ((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2) ** 0.5

P = {
'0 原生银': dict(
  # L 段修正：--c-exercise-deep 由 #5ba800 压到 #569f00，环线对比 2.98 -> 3.14（现行值差 0.02 不到线）
  L=dict(bg='#f5f5f7', surf='#ffffff', s2='#f2f2f4', t1='#1d1d1f', t2='#6e6e73', t3='#86868b',
        acc='#006ee8', accs='#0a5ec2', on='#ffffff', intake='#fa114f', ex='#569f00', bal='#0b8fd6',
        ok='#248a3d', warn='#8a5300', dang='#c1271d', study='#5856d6', work='#c26a00', shop='#af52de'),
  # D 段修正：--on-accent 由白改为深墨（#04101f）。现行 #0a84ff 上压白字只有 3.65:1，
  # 提亮主色就必然压不住白字 —— 把「填充色」与「其上的文字色」解耦才是正解（tokens.css
  # 暗色块注释里承认的正是这个两难）。--accent 保持 #0a84ff 当图标/链接色（4.66:1 不变）。
  D=dict(bg='#000000', surf='#1c1c1e', s2='#2c2c2e', t1='#f5f5f7', t2='#97979d', t3='#7c7c82',
        acc='#0a84ff', accs='#4da3ff', on='#04101f', intake='#ff375f', ex='#a4f04b', bal='#40b8e0',
        ok='#30d158', warn='#ffb340', dang='#ff6961', study='#7d7aff', work='#ff9f0a', shop='#bf5af2')),
'1 石墨夜航': dict(
  L=dict(bg='#eceef2', surf='#ffffff', s2='#e8eaef', t1='#101215', t2='#565c66', t3='#7c828d',
        acc='#0b5cd5', accs='#0a4fae', on='#ffffff', intake='#e8385c', ex='#2f9e52', bal='#0b6fd6',
        ok='#1f7a44', warn='#8a5300', dang='#c1271d', study='#4f46c8', work='#a86200', shop='#8b45c4'),
  D=dict(bg='#05060a', surf='#14161c', s2='#1f222a', t1='#f2f5f9', t2='#9aa1ad', t3='#767d8a',
        acc='#4c9dff', accs='#7cb8ff', on='#04101f', intake='#ff4d6d', ex='#3ddc84', bal='#38bdf8',
        ok='#3ddc84', warn='#ffb340', dang='#ff6961', study='#8b87ff', work='#ffb020', shop='#c17ce8')),
'2 暖砂': dict(
  L=dict(bg='#f4efe9', surf='#fffdfa', s2='#efe8de', t1='#2b2119', t2='#6f6053', t3='#97867a',
        acc='#a3451f', accs='#8a3a1a', on='#ffffff', intake='#e2724f', ex='#5d7f26', bal='#2f7d8c',
        ok='#2f6b3c', warn='#8a5300', dang='#b3311f', study='#6a4bb8', work='#b06000', shop='#9a4f9e'),
  D=dict(bg='#17120e', surf='#221b16', s2='#2e2620', t1='#f7f0e8', t2='#a2958a', t3='#84796f',
        acc='#e88a5e', accs='#f2a67f', on='#241009', intake='#ff8a6b', ex='#a9c46a', bal='#5fc4bb',
        ok='#7fc98d', warn='#ffb340', dang='#ff7a68', study='#b39ae8', work='#ffb35c', shop='#e08fc4')),
'3 薄荷': dict(
  L=dict(bg='#eff5f2', surf='#ffffff', s2='#e7efe9', t1='#12211b', t2='#4e6157', t3='#7a8c82',
        acc='#0e7a5a', accs='#0a6349', on='#ffffff', intake='#ec5f7e', ex='#1f9d63', bal='#0b74c4',
        ok='#1f7a44', warn='#8a5300', dang='#c1271d', study='#4f46b8', work='#a06a00', shop='#7d4fb0'),
  D=dict(bg='#07120e', surf='#0f1c17', s2='#1a2822', t1='#e8f5ef', t2='#94a8a0', t3='#75897f',
        acc='#35d39b', accs='#5ee0ae', on='#04140e', intake='#ff6b85', ex='#3ddc84', bal='#4aa8ff',
        ok='#3ddc84', warn='#ffb340', dang='#ff6961', study='#9b8cff', work='#ffc44d', shop='#c98ce0')),
'4 玫瑰': dict(
  L=dict(bg='#f7f1f2', surf='#ffffff', s2='#f2e6e9', t1='#2a1a1e', t2='#6d5459', t3='#907b81',
        acc='#b03a5a', accs='#93304a', on='#ffffff', intake='#e2557a', ex='#5d9c3f', bal='#2f6fb5',
        ok='#1f7a44', warn='#8a5300', dang='#c1271d', study='#6d4bc0', work='#b35c00', shop='#a13f8f'),
  D=dict(bg='#150d10', surf='#201418', s2='#2c1c22', t1='#f9edf0', t2='#a8969b', t3='#8a777d',
        acc='#f0809f', accs='#ffa0ba', on='#24080f', intake='#ff7d9a', ex='#a3d17a', bal='#7fb8e0',
        ok='#3ddc84', warn='#ffb340', dang='#ff6961', study='#c39cff', work='#ffb86b', shop='#e894c8')),
'5 靛蓝': dict(
  L=dict(bg='#eef0f7', surf='#ffffff', s2='#e6e9f4', t1='#141726', t2='#565b70', t3='#838898',
        acc='#3a45c8', accs='#2c35a3', on='#ffffff', intake='#f0566f', ex='#2f9e7f', bal='#3f5fd0',
        ok='#1f7a44', warn='#8a5300', dang='#c1271d', study='#5a3fd0', work='#a86200', shop='#8b45c4'),
  D=dict(bg='#080911', surf='#12141d', s2='#1c1f2c', t1='#eff1fa', t2='#9aa0b8', t3='#7c8299',
        acc='#7b86ff', accs='#9aa3ff', on='#0a0b2a', intake='#ff6b81', ex='#4ade80', bal='#60a5fa',
        ok='#3ddc84', warn='#ffb340', dang='#ff6961', study='#a99bff', work='#ffc44d', shop='#c98ce0')),
'6 柑柠': dict(
  L=dict(bg='#fbf7ec', surf='#ffffff', s2='#f3ecd9', t1='#2a2413', t2='#665c3d', t3='#8d8362',
        acc='#a05e00', accs='#824c00', on='#ffffff', intake='#ef5b3f', ex='#6f9c15', bal='#0f8f96',
        ok='#2f6b3c', warn='#8a5300', dang='#c1271d', study='#5f4bc0', work='#b06000', shop='#9a4f9e'),
  D=dict(bg='#14110a', surf='#1f1a11', s2='#2b2417', t1='#f9f2e0', t2='#a79c82', t3='#8a8069',
        acc='#ffb020', accs='#ffc65c', on='#241900', intake='#ff7a5c', ex='#b6dc4a', bal='#3fc4c0',
        ok='#8fce6a', warn='#ffd60a', dang='#ff6961', study='#b39ae8', work='#ffd60a', shop='#e08fc4')),
'7 青瓷': dict(
  L=dict(bg='#eff2ef', surf='#ffffff', s2='#e6ebe7', t1='#18211c', t2='#55605a', t3='#7f8a84',
        acc='#2c6e63', accs='#205a51', on='#ffffff', intake='#d9646e', ex='#5d8a26', bal='#2f6ea8',
        ok='#2f6b3c', warn='#8a5300', dang='#c1271d', study='#4a5fb0', work='#9c6a10', shop='#7a5aa8'),
  D=dict(bg='#0c1211', surf='#141b19', s2='#1e2724', t1='#eaf2ef', t2='#95a5a0', t3='#788883',
        acc='#5fbfae', accs='#86d6c6', on='#04140f', intake='#ff8a92', ex='#a3cf62', bal='#6fb0d8',
        ok='#7fc98d', warn='#ffb340', dang='#ff6961', study='#9ab4f0', work='#d4b45c', shop='#b09ce0')),
'8 落日': dict(
  L=dict(bg='#f8ece4', surf='#fffaf6', s2='#f4e3d8', t1='#2e1a12', t2='#70503f', t3='#957567',
        acc='#c23d24', accs='#a3321c', on='#ffffff', intake='#d81b45', ex='#c2740a', bal='#0e8fa8',
        ok='#2f6b3c', warn='#8a5300', dang='#b3311f', study='#7a3fa8', work='#b86200', shop='#a8447e'),
  D=dict(bg='#180f0b', surf='#241713', s2='#32211b', t1='#faece4', t2='#ab8f80', t3='#8f7568',
        acc='#ff7a52', accs='#ff9c7c', on='#260c05', intake='#ff4d6d', ex='#fbbf24', bal='#38bdf8',
        ok='#8fce6a', warn='#ffd60a', dang='#ff6961', study='#c78ce8', work='#ffb35c', shop='#e888b8')),
'9 素白': dict(
  L=dict(bg='#fafafa', surf='#ffffff', s2='#f0f0f0', t1='#0a0a0a', t2='#5f5f5f', t3='#8c8c8c',
        acc='#111111', accs='#000000', on='#ffffff', intake='#e8385c', ex='#2f9e52', bal='#0b6fd6',
        ok='#1f7a44', warn='#8a5300', dang='#c1271d', study='#3f3f46', work='#5f5f66', shop='#52525b'),
  D=dict(bg='#000000', surf='#0e0e0e', s2='#1c1c1c', t1='#fafafa', t2='#9a9a9a', t3='#767676',
        acc='#fafafa', accs='#ffffff', on='#0a0a0a', intake='#ff4d6d', ex='#3ddc84', bal='#38bdf8',
        ok='#3ddc84', warn='#ffb340', dang='#ff6961', study='#a1a1aa', work='#d4d4d8', shop='#c4c4cc')),
}

fails = []
for n, modes in P.items():
    for mode in ('L', 'D'):
        d = modes[mode]
        vals = [
            ('on/acc', cr(d['on'], d['acc']), 4.5),
            ('t1', cr(d['t1'], d['surf']), 7.0),
            ('t2', cr(d['t2'], d['surf']), 4.5),
            ('t3', cr(d['t3'], d['surf']), 3.0),
            ('accs', cr(d['accs'], d['surf']), 4.5),
            ('intake', cr(d['intake'], d['surf']), 3.0),
            ('ex', cr(d['ex'], d['surf']), 3.0),
            ('bal', cr(d['bal'], d['surf']), 3.0),
        ]
        des = [dE(d['intake'], d['ex']), dE(d['ex'], d['bal']), dE(d['intake'], d['bal'])]
        prob = [f'{k}={v:.2f}<{th}' for k, v, th in vals if v < th]
        if min(des) < 20:
            prob.append(f'环dE={min(des):.0f}<20')
        if prob:
            fails.append((n, mode))
        tag = 'OK' if not prob else 'FAIL ' + '; '.join(prob)
        print(f"{n:10s}{mode}  on/acc {vals[0][1]:5.2f}  t1 {vals[1][1]:5.2f}  t2 {vals[2][1]:5.2f}  t3 {vals[3][1]:5.2f}  accs {vals[4][1]:5.2f} | rings {vals[5][1]:4.2f}/{vals[6][1]:4.2f}/{vals[7][1]:4.2f}  dE {des[0]:4.0f}/{des[1]:4.0f}/{des[2]:4.0f}  {tag}")

print()
print('全部 20 组达标' if not fails else f'仍有 {len(fails)} 组需修: {fails}')
