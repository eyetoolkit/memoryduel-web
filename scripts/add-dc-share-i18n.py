#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给 memoryduel 六语字典补 P1-4 分享卡文案（幂等）。

🔴 为什么用脚本而不是手改 JSON：
   六个文件 × 5 个 key = 30 处手写，任何一处漏掉或串了语言都很难在 review 里看出来。
   本脚本按语言集中在一张表里，逐个 assert 后写回，跑第二遍不会重复插入。

🔴 文案口径：
   streak_days / perfect_all 已在字典里（复用），这里只新增分享动作本身。
   dc.game_title 已是「Daily Challenge」，故 share_* 只写动作与提示，不重复标题语义。
"""
import json
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
I18N = os.path.join(os.path.dirname(HERE), 'public', 'i18n')

# 🔴 key 顺序固定，按钮从左到右读起来才顺；textarea hint 在最前（它在 DOM 最上）
NEW = {
    'en': {
        'share_hint':    'Share your score',
        'share_download':'Download image',
        'share_native':  'Share…',
        'share_alt':     'Score card preview',
        'share_cta':     "Same puzzles for everyone — can you beat it?",
        'share_failed':  'Could not create the image. Try copying the text instead.',
    },
    'zh': {
        'share_hint':    '分享你的成绩',
        'share_download':'下载图片',
        'share_native':  '分享…',
        'share_alt':     '成绩卡预览',
        'share_cta':     '所有人都是同一套题 —— 你能超过我吗？',
        'share_failed':  '图片生成失败，试试复制文字。',
    },
    'ja': {
        'share_hint':    'スコアをシェア',
        'share_download':'画像を保存',
        'share_native':  'シェア…',
        'share_alt':     'スコアカードのプレビュー',
        'share_cta':     '全員同じ問題です —— 君には勝てるかな？',
        'share_failed':  '画像を作成できませんでした。テキストのコピーを試してください。',
    },
    'es': {
        'share_hint':    'Comparte tu puntuación',
        'share_download':'Descargar imagen',
        'share_native':  'Compartir…',
        'share_alt':     'Vista previa de la tarjeta',
        'share_cta':     'Los mismos puzzles para todos: ¿puedes superarlo?',
        'share_failed':  'No se pudo crear la imagen. Prueba a copiar el texto.',
    },
    'fr': {
        'share_hint':    'Partagez votre score',
        'share_download':"Télécharger l'image",
        'share_native':  'Partager…',
        'share_alt':     'Aperçu de la carte de score',
        'share_cta':     'Les mêmes énigmes pour tout le monde — pouvez-vous faire mieux ?',
        'share_failed':  "Impossible de créer l'image. Essayez de copier le texte.",
    },
    'de': {
        'share_hint':    'Teile deinen Punktestand',
        'share_download':'Bild herunterladen',
        'share_native':  'Teilen…',
        'share_alt':     'Vorschau der Ergebnis-Karte',
        'share_cta':     'Für alle dieselben Rätsel — schaffst du es besser?',
        'share_failed':  'Bild konnte nicht erstellt werden. Kopiere stattdessen den Text.',
    },
}

EXPECT = set(NEW['en'].keys())


def main() -> int:
    changed = []
    for lang, add in NEW.items():
        if set(add.keys()) != EXPECT:
            print(f'[{lang}] key 集与 en 不一致: {set(add.keys()) ^ EXPECT}', file=sys.stderr)
            return 1

        path = os.path.join(I18N, f'{lang}.json')
        with io.open(path, encoding='utf-8') as f:
            data = json.load(f)

        dc = data.setdefault('dc', {})
        missing = [k for k in EXPECT if k not in dc]
        for k, v in add.items():
            dc[k] = v

        # 🔴 ensure_ascii=False：中文/日文保持原字，不要 \uXXXX 转义
        # sort_keys=False：保持字典原有的人工排序，避免整份文件重排把 diff 撑爆
        with io.open(path, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write('\n')

        changed.append(f'{lang}(+{len(missing)})')

    print('OK ' + ' '.join(changed))
    return 0


if __name__ == '__main__':
    sys.exit(main())