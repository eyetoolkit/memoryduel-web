#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""幂等写入 P2 三款新游戏的六语文案 + 关卡名，并递增 dictVersion。

🔴 为什么用脚本而不是手改 JSON：
   六语 × 二十多个 key = 120+ 条，手改极易漏一语，而漏一语的危害是
   i18n.t() 回退到显示 key 本身（`dc.emoji_h2` 直接出现在页面上），
   而且**不报错**。脚本按语言遍历 + 幂等写入 + 写完立刻校验六语齐全。

用法：python3 scripts/add-p2-games-i18n.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
I18N = os.path.join(ROOT, "public", "i18n")
LANGS = ["en", "zh", "ja", "es", "fr", "de"]

# ── 关卡名（进度条 / 成绩行 / 分享卡共用 dc.<game>）────────────────
# 🔴 2026-10-13 补齐：老三关（number/sequence/color）在 dc.<game-id> 这套
#    键下**一直缺键**——字典里它们叫 numduel.*/seqduel.*/colduel.*（按对站分组）。
#    而 renderSteps/showFinal 用的恰恰是 `dc.${g}`，于是进度条上
#    永远显示原始 id「number-recall」而不是「数字广度」，且零报错
#    （i18n.t 缺键时返回 key 本身，被 fallback 参数原样显示）。
NAMES = {
    "en": {"emoji-ghost": "Emoji Ghost", "chimp-test": "Chimp Test", "word-recall": "Word Recall",
           "number-recall": "Number Recall", "sequence-memory": "Sequence Memory", "color-recall": "Colour Recall"},
    "zh": {"emoji-ghost": "表情幽灵", "chimp-test": "猩猩测试", "word-recall": "词语记忆",
           "number-recall": "数字广度", "sequence-memory": "序列记忆", "color-recall": "颜色还原"},
    "ja": {"emoji-ghost": "絵文字ゴースト", "chimp-test": "チンパー・テスト", "word-recall": "単語記憶",
           "number-recall": "数字記憶", "sequence-memory": "数列記憶", "color-recall": "色記憶"},
    "es": {"emoji-ghost": "Fantasma Emoji", "chimp-test": "Prueba del Chimpancé", "word-recall": "Memoria de Palabras",
           "number-recall": "Memoria Numérica", "sequence-memory": "Memoria de Secuencia", "color-recall": "Memoria de Colores"},
    "fr": {"emoji-ghost": "Fantôme Émoji", "chimp-test": "Test du Chimpanzé", "word-recall": "Mémoire des Mots",
           "number-recall": "Mémoire des Chiffres", "sequence-memory": "Mémoire des Séquences", "color-recall": "Mémoire des Couleurs"},
    "de": {"emoji-ghost": "Emoji-Geist", "chimp-test": "Schimpansen-Test", "word-recall": "Wörter-Gedächtnis",
           "number-recall": "Zahlengedächtnis", "sequence-memory": "Reihen-Gedächtnis", "color-recall": "Farb-Gedächtnis"},
}

# ── 玩法文案 ─────────────────────────────────────────────────────
T = {
    "en": {
        "dc.emoji_h2": "Emoji Ghost",
        "dc.emoji_help": "A row of symbols flashes. One of them disappears — pick which one it was.",
        "dc.emoji_ready": "Show me",
        "dc.emoji_pick": "Which one was in the set?",
        "dc.chimp_h2": "Chimp Test",
        "dc.chimp_help": "Numbers flash on the grid, then vanish. Tap every cell that held a number.",
        "dc.chimp_ready": "Show me",
        "dc.chimp_pick": "Tap all {n} cells that held a number.",
        "dc.chimp_done": "Done",
        "dc.word_h2": "Word Recall",
        "dc.word_help": "Words appear one by one. Afterwards, mark each as seen or new.",
        "dc.word_ready": "Show me",
        "dc.word_pick": "For each word, decide whether you saw it earlier in this round.",
        "dc.word_new": "New",
        "dc.word_seen": "Seen",
        "dc.word_lock": "Submit answers",
        "dc.lobby_mt_emoji": "Emoji Ghost",
        "dc.lobby_md_emoji": "A row of symbols flashes, one vanishes. Pick which one it was.",
        "dc.lobby_mt_chimp": "Chimp Test",
        "dc.lobby_md_chimp": "Numbers flash on a grid, then vanish. Tap every cell that held one.",
        "dc.lobby_mt_word": "Word Recall",
        "dc.lobby_md_word": "Words appear one by one. Then mark each as seen or new.",
    },
    "zh": {
        "dc.emoji_h2": "表情幽灵",
        "dc.emoji_help": "一排符号闪现，其中一个消失了——选出刚才在里面的那个。",
        "dc.emoji_ready": "开始",
        "dc.emoji_pick": "哪一个刚才在集合里？",
        "dc.chimp_h2": "猩猩测试",
        "dc.chimp_help": "数字在网格上闪现后消失，点出刚才显示过数字的所有格子。",
        "dc.chimp_ready": "开始",
        "dc.chimp_pick": "点出刚才有数字的 {n} 个格子。",
        "dc.chimp_done": "完成",
        "dc.word_h2": "词语记忆",
        "dc.word_help": "词语逐个出现，之后为每个词标记「见过」或「没见过」。",
        "dc.word_ready": "开始",
        "dc.word_pick": "逐个判断：这个词本轮之前出现过吗？",
        "dc.word_new": "没见过",
        "dc.word_seen": "见过",
        "dc.word_lock": "提交答案",
        "dc.lobby_mt_emoji": "表情幽灵",
        "dc.lobby_md_emoji": "一排符号闪现，其中一个消失了——选出刚才在里面的那个。",
        "dc.lobby_mt_chimp": "猩猩测试",
        "dc.lobby_md_chimp": "数字在网格上闪现后消失，点出所有刚才显示过数字的格子。",
        "dc.lobby_mt_word": "词语记忆",
        "dc.lobby_md_word": "词语逐个出现，之后为每个词标记「见过」或「没见过」。",
    },
    "ja": {
        "dc.emoji_h2": "絵文字ゴースト",
        "dc.emoji_help": "一列の記号がフラッシュし、そのうち1つが消えます。どれが元の集合にあったか選んでください。",
        "dc.emoji_ready": "再生",
        "dc.emoji_pick": "集合にあったのはどれ？",
        "dc.chimp_h2": "チンパー・テスト",
        "dc.chimp_help": "グリッドに数字がフラッシュして消えます。数字があったマスをすべてタップしてください。",
        "dc.chimp_ready": "再生",
        "dc.chimp_pick": "数字があった {n} マスをすべてタップ。",
        "dc.chimp_done": "完了",
        "dc.word_h2": "単語記憶",
        "dc.word_help": "単語が1つずつ表示されます。その後、それぞれを「見た／初めて」と判定します。",
        "dc.word_ready": "再生",
        "dc.word_pick": "各単語について、このラウンドで先に見たかどうかを判定してください。",
        "dc.word_new": "初めて",
        "dc.word_seen": "見た",
        "dc.word_lock": "回答を送信",
        "dc.lobby_mt_emoji": "絵文字ゴースト",
        "dc.lobby_md_emoji": "一列の記号が点滅し、そのうち1つが消えます。どれだったか選んでください。",
        "dc.lobby_mt_chimp": "チンパー・テスト",
        "dc.lobby_md_chimp": "グリッドの数字が点滅して消えます。数字があったマスをすべてタップ。",
        "dc.lobby_mt_word": "単語記憶",
        "dc.lobby_md_word": "単語が1つずつ表示され、それぞれを「見た／初めて」と判定します。",
    },
    "es": {
        "dc.emoji_h2": "Fantasma Emoji",
        "dc.emoji_help": "Una fila de símbolos aparece y uno desaparece: elige cuál estaba.",
        "dc.emoji_ready": "Mostrar",
        "dc.emoji_pick": "¿Cuál estaba en el conjunto?",
        "dc.chimp_h2": "Prueba del Chimpancé",
        "dc.chimp_help": "Los números aparecen en la cuadrícula y desaparecen. Pulsa todas las casillas que tenían número.",
        "dc.chimp_ready": "Mostrar",
        "dc.chimp_pick": "Pulsa las {n} casillas que tenían un número.",
        "dc.chimp_done": "Listo",
        "dc.word_h2": "Memoria de Palabras",
        "dc.word_help": "Las palabras aparecen una a una. Después, marca cada una como vista o nueva.",
        "dc.word_ready": "Mostrar",
        "dc.word_pick": "Para cada palabra, decide si la viste antes en esta ronda.",
        "dc.word_new": "Nueva",
        "dc.word_seen": "Vista",
        "dc.word_lock": "Enviar respuestas",
        "dc.lobby_mt_emoji": "Fantasma Emoji",
        "dc.lobby_md_emoji": "Una fila de símbolos aparece y uno desaparece: elige cuál era.",
        "dc.lobby_mt_chimp": "Prueba del Chimpancé",
        "dc.lobby_md_chimp": "Los números aparecen en la cuadrícula y desaparecen. Pulsa todas las casillas que tenían uno.",
        "dc.lobby_mt_word": "Memoria de Palabras",
        "dc.lobby_md_word": "Las palabras aparecen una a una. Luego marca cada una como vista o nueva.",
    },
    "fr": {
        "dc.emoji_h2": "Fantôme Émoji",
        "dc.emoji_help": "Une rangée de symboles s'affiche puis l'un d'eux disparaît : lequel était dans l'ensemble ?",
        "dc.emoji_ready": "Afficher",
        "dc.emoji_pick": "Lequel était dans l'ensemble ?",
        "dc.chimp_h2": "Test du Chimpanzé",
        "dc.chimp_help": "Des chiffres apparaissent sur la grille puis disparaissent. Touchez chaque case qui portait un chiffre.",
        "dc.chimp_ready": "Afficher",
        "dc.chimp_pick": "Touchez les {n} cases qui portaient un chiffre.",
        "dc.chimp_done": "Terminé",
        "dc.word_h2": "Mémoire des Mots",
        "dc.word_help": "Les mots apparaissent un par un. Ensuite, indiquez pour chacun s'il a déjà été vu.",
        "dc.word_ready": "Afficher",
        "dc.word_pick": "Pour chaque mot, dites si vous l'avez vu plus tôt dans cette manche.",
        "dc.word_new": "Nouveau",
        "dc.word_seen": "Vu",
        "dc.word_lock": "Envoyer",
        "dc.lobby_mt_emoji": "Fantôme Émoji",
        "dc.lobby_md_emoji": "Une rangée de symboles s'affiche, l'un disparaît : lequel était-ce ?",
        "dc.lobby_mt_chimp": "Test du Chimpanzé",
        "dc.lobby_md_chimp": "Des chiffres apparaissent sur la grille puis disparaissent. Touchez chaque case qui en portait un.",
        "dc.lobby_mt_word": "Mémoire des Mots",
        "dc.lobby_md_word": "Les mots apparaissent un par un. Ensuite, indiquez pour chacun s'il a été vu.",
    },
    "de": {
        "dc.emoji_h2": "Emoji-Geist",
        "dc.emoji_help": "Eine Reihe Symbole blinkt auf, eines verschwindet – welches war es?",
        "dc.emoji_ready": "Anzeigen",
        "dc.emoji_pick": "Welches war in der Menge?",
        "dc.chimp_h2": "Schimpansen-Test",
        "dc.chimp_help": "Zahlen blinken im Raster auf und verschwinden. Tippe jedes Feld, das eine Zahl trug.",
        "dc.chimp_ready": "Anzeigen",
        "dc.chimp_pick": "Tippe alle {n} Felder, die eine Zahl trugen.",
        "dc.chimp_done": "Fertig",
        "dc.word_h2": "Wörter-Gedächtnis",
        "dc.word_help": "Wörter erscheinen nacheinander. Markiere danach jedes als gesehen oder neu.",
        "dc.word_ready": "Anzeigen",
        "dc.word_pick": "Entscheide für jedes Wort, ob du es in dieser Runde schon gesehen hast.",
        "dc.word_new": "Neu",
        "dc.word_seen": "Gesehen",
        "dc.word_lock": "Antworten senden",
        "dc.lobby_mt_emoji": "Emoji-Geist",
        "dc.lobby_md_emoji": "Eine Reihe Symbole blinkt auf, eines verschwindet – welches war es?",
        "dc.lobby_mt_chimp": "Schimpansen-Test",
        "dc.lobby_md_chimp": "Zahlen blinken im Raster auf und verschwinden. Tippe jedes Feld mit einer Zahl.",
        "dc.lobby_mt_word": "Wörter-Gedächtnis",
        "dc.lobby_md_word": "Wörter erscheinen nacheinander. Markiere danach jedes als gesehen oder neu.",
    },
}


def main():
    missing = []
    for lang in LANGS:
        p = os.path.join(I18N, f"{lang}.json")
        with open(p, encoding="utf-8") as f:
            d = json.load(f)

        # 🔴 2026-10-13 修复「28 个键写到了顶层而不是 dc 命名空间里」：
        #   运行时 i18n.js 的 get() 按 '.' 分层取值（`dc.emoji_h2` → d.dc.emoji_h2），
        #   而本脚本原先执行 `d["dc.emoji_h2"] = v` —— 那是**顶层扁平键**，
        #   解析成 JSON 就是一行 `"dc.emoji_h2": "…"` 挂在最外层，运行时永远取不到。
        #   现象：t() 缺键 → 返回 key 本身 → 页面上直接出现
        #   「Emoji Ghost」「👻 emoji-ghost 30」，且**零报错**。
        #   为什么只有新三关露馅：老三关的 dc.number-recall 等 3 个连字符键
        #   恰好同时存在于 dc 对象内（早期手工加过），所以它们能取到值；
        #   新三关只有扁平副本，取不到 → 泄露原始 id。
        #
        # 正确写法：拆成命名空间 + 键名，写进嵌套对象。
        ns = d.setdefault("dc", {})
        for k, v in NAMES[lang].items():
            ns[k] = v
        for k, v in T[lang].items():
            # T 的键形如 "dc.emoji_h2" / "dc.lobby_mt_emoji"，剥掉 "dc." 前缀
            assert k.startswith("dc."), f"命名空间异常：{k}"
            ns[k[3:]] = v

        # 清理上一版遗留的顶层扁平键（只删 dc.* 前缀的，不碰其他顶层键）
        stale = [k for k in d if k.startswith("dc.")]
        for k in stale:
            del d[k]

        with open(p, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
            f.write("\n")

        # 🔴 校验必须走**运行时同款取值方式**（嵌套），不能只判 key 在不在文件里
        with open(p, encoding="utf-8") as f:
            chk = json.load(f)

        def get(o, key):
            cur = o
            for part in key.split("."):
                if not isinstance(cur, dict):
                    return None
                cur = cur.get(part)
            return cur

        for k in list(NAMES[lang]):
            key = f"dc.{k}"
            val = get(chk, key)
            if not val or val == key:
                missing.append(f"{lang}:{key}(嵌套取值={val!r})")
        for k in T[lang]:
            val = get(chk, k)
            if not val or val == k:
                missing.append(f"{lang}:{k}(嵌套取值={val!r})")
        # 顶层不该再有 dc.* 扁平键
        leftovers = [k for k in chk if k.startswith("dc.")]
        if leftovers:
            missing.append(f"{lang}:顶层残留扁平键 {leftovers[:3]}")

    # dictVersion 递增（真相源是 public/i18n/VERSION）
    # 🔴 dictVersion 内联在**每一个** HTML 的 window.__I18N_CONFIG__ 里
    #    （全站 18+ 处），只改 VERSION 文件等于没改 —— 浏览器照样吃旧缓存。
    #    所以这里必须扫全站 HTML 一起 bump，漏一个页面就有一个页面读到旧字典。
    vp = os.path.join(I18N, "VERSION")
    with open(vp, encoding="utf-8") as f:
        ver = int(f.read().strip())
    new_ver = ver + 1

    bumped = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [
            d for d in dirnames
            if d not in ("node_modules", "dist", ".git", "tests", "scripts")
        ]
        for fn in filenames:
            if not fn.endswith(".html"):
                continue
            fp = os.path.join(dirpath, fn)
            with open(fp, encoding="utf-8") as f:
                html = f.read()
            if f"dictVersion:{ver}" not in html:
                continue
            with open(fp, "w", encoding="utf-8") as f:
                f.write(html.replace(f"dictVersion:{ver}", f"dictVersion:{new_ver}"))
            bumped.append(os.path.relpath(fp, ROOT).replace("\\", "/"))

    with open(vp, "w", encoding="utf-8") as f:
        f.write(f"{new_ver}\n")

    print(f"dictVersion {ver} -> {new_ver}  （bump {len(bumped)} 个 HTML）")
    if not bumped:
        print("⚠️ 没有任何 HTML 被 bump —— 版本号可能已不一致，请人工核对")
        sys.exit(1)
    if missing:
        print("MISSING:", missing)
        sys.exit(1)
    print("六语文案写入校验通过")


if __name__ == "__main__":
    main()