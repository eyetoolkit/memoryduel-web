#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P1-5：向六语字典写入 duel.col_* / duel.num_* 六语文案（幂等）。

🔴 为什么用脚本而不是手改 JSON：
  六语 × 多个键，手改必然漏；而漏掉的键在页面上表现为「直接显示 key 原文」
  （window.t 找不到时返回 key），比翻译错更显眼、更容易被当成 bug。
  本脚本可重复执行，第二次输出 (+0) 即证明幂等。

🔴 ensure_ascii=False：
  中文/日文写成 \\uXXXX 在源文件里完全不可读，改字典时要肉眼校对，
  而文案错字恰恰只能靠肉眼发现。
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
I18N = ROOT / 'public' / 'i18n'

# 每个语言需要写入的键（值已按语言分别给出，不做跨语拼接）
# 🔴 home_v2.game_col_d 放这里而不是别处：它与 duel.col_title 同属「上线一款
#   对战游戏」这一个动作的文案，同脚本同一次提交，避免两个文件各自漂移。
T = {
    'en': {
        'col_title': 'Colour Recall Duel',
        'col_help': 'Memorise the colours, then rebuild them on the wheel. Your opponent gets the exact same colours — whoever is closer wins.',
        'col_ready_hint': 'Tap start, watch the colours appear, then rebuild each one as closely as you can.',
        'col_pick': 'Colour {n} of {total} — match it as closely as you can.',
        'col_foot_hint': 'Same colours for both players. Closest match wins.',
        '_home_col_d': 'Five colours appear, then vanish — rebuild each one on the wheel. Same colours for both players, closest match wins.',
    },
    'zh': {
        'col_title': '颜色还原对决',
        'col_help': '记住这组颜色，再用色轮还原。对手看到的是完全相同的颜色——谁还原得更准谁赢。',
        'col_ready_hint': '点击开始，看清颜色出现，再逐个尽量还原。',
        'col_pick': '第 {n} 个颜色，共 {total} 个 —— 尽量调得接近一些。',
        'col_foot_hint': '两位玩家看到完全相同的颜色，还原得更准的一方获胜。',
        '_home_col_d': '五个颜色出现后消失，用色轮逐个还原。两人同题，还原得更准的一方获胜。',
    },
    'ja': {
        'col_title': 'カラーリコール決戦',
        'col_help': '色を覚えてから、ホイールで再現します。相手にはまったく同じ色が見えます——より近い方が勝ちです。',
        'col_ready_hint': 'スタートを押して色を確認し、ひとつずつできるだけ再現してください。',
        'col_pick': '色 {n} / {total} —— できるだけ近づけてください。',
        'col_foot_hint': '両者に見える色は同じです。より近い方が勝ちます。',
        '_home_col_d': '5つの色が現れて消え、ホイールでひとつずつ再現。二人とも同じ色で、より近い方が勝ちです。',
    },
    'es': {
        'col_title': 'Duelo de Recuerdo de Colores',
        'col_help': 'Memoriza los colores y rehácelos en la rueda. Tu rival recibe exactamente los mismos colores: quien se acerque más gana.',
        'col_ready_hint': 'Toca iniciar, observa los colores y rehaz cada uno lo más cerca posible.',
        'col_pick': 'Color {n} de {total}: acércate lo máximo posible.',
        'col_foot_hint': 'Ambos ven los mismos colores. Gana quien se acerque más.',
        '_home_col_d': 'Aparecen cinco colores y desaparecen: rehaz cada uno en la rueda. Los mismos colores para ambos; gana quien se acerque más.',
    },
    'fr': {
        'col_title': 'Duel de Mémoire des Couleurs',
        'col_help': 'Mémorisez les couleurs puis reproduisez-les sur la roue. Votre adversaire voit exactement les mêmes couleurs : le plus proche gagne.',
        'col_ready_hint': 'Lancez la manche, observez les couleurs, puis reproduisez chacune au plus près.',
        'col_pick': 'Couleur {n} sur {total} — approchez-la au plus près.',
        'col_foot_hint': 'Les deux joueurs voient les mêmes couleurs. Le plus proche gagne.',
        '_home_col_d': 'Cinq couleurs apparaissent puis disparaissent : reproduisez-les sur la roue. Même palette pour les deux, le plus proche gagne.',
    },
    'de': {
        'col_title': 'Farbgedächtnis-Duell',
        'col_help': 'Merke dir die Farben und stelle sie am Farbkreis nach. Dein Gegner sieht genau dieselben Farben — wer näher dran ist, gewinnt.',
        'col_ready_hint': 'Starte die Runde, sieh dir die Farben an und stelle jede so genau wie möglich nach.',
        'col_pick': 'Farbe {n} von {total} — so nah wie möglich annähern.',
        'col_foot_hint': 'Beide sehen dieselben Farben. Wer näher dran ist, gewinnt.',
        '_home_col_d': 'Fünf Farben erscheinen und verschwinden — stelle jede am Farbkreis nach. Gleiche Farben für beide, wer näher dran ist, gewinnt.',
    },
}

# 带 _ 前缀的键写进另一个命名空间（home_v2），其余进 duel。
# 🔴 这里必须**显式给出目标键名**，不能用前缀剥离之类的推导：
#     '_home_col_d' 无论怎么切都会留下 'home_col_d'，
#     而页面按 game_col_d 取 —— 取不到就静默回落英文，肉眼看不出异常。
#     前缀推导出的错键名，是「脚本跑成功 + 页面少一句翻译」的完美组合。
NAMESPACE = {'_home_col_d': ('home_v2', 'game_col_d')}

added = 0
for lang, entries in T.items():
    path = I18N / f'{lang}.json'
    if not path.exists():
        print(f'  跳过 {lang}: 文件不存在', file=sys.stderr)
        continue
    data = json.loads(path.read_text(encoding='utf-8'))
    delta = 0
    for k, v in entries.items():
        ns = NAMESPACE.get(k)
        if ns:
            bucket = data.setdefault(ns[0], {})
            real_k = ns[1]
        else:
            bucket = data.setdefault('duel', {})
            real_k = k
        if bucket.get(real_k) != v:
            bucket[real_k] = v
            delta += 1
    # indent=2 + LF：与仓库其余字典保持一致，避免整文件 diff 抖动
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    added += delta
    print(f'  {lang}: (+{delta})')

print(f'共写入 {added} 个键' + ('（幂等确认）' if added == 0 else ''))