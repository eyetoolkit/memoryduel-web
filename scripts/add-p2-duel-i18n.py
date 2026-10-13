#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""幂等写入 P2 三款新游戏**对战页**的六语文案，并递增 dictVersion。

🔴 与 add-p2-games-i18n.py 的区别：
   那个脚本写的是每日挑战的 dc.* 命名空间；本脚本写对战页的 duel.* / *duel.* 命名空间。
   两套文案刻意不共用键 —— 每日挑战是「单人闯关」的措辞，
   对战是「同题比谁记得准」的措辞，共用键会让其中一处被另一处绑死。

🔴 写入方式必须是**嵌套对象**（ns['key'] = v），不是顶层扁平（d['duel.key'] = v）：
   运行时 i18n.js 的 get() 按 '.' 分层取值，写成扁平键运行时永远取不到，
   t() 回退成返回 key 本身 —— 页面上直接出现「duel.emoji_title」，且零报错。
   （这个坑 P2 每日挑战已经踩过一次，见 add-p2-games-i18n.py 的注释。）

用法：python3 scripts/add-p2-duel-i18n.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
I18N = os.path.join(ROOT, "public", "i18n")
LANGS = ["en", "zh", "ja", "es", "fr", "de"]

# ── duel.* ：页面运行时文案（标题 / 说明 / 提示 / 页脚）──────────────
DUEL = {
    "en": {
        "emoji_title": "Emoji Ghost Duel",
        "emoji_help": "A row of symbols flashes, then one is missing. Your opponent gets the exact same set — pick the ghost correctly.",
        "emoji_ready_hint": "Tap start, watch the symbols appear, then pick the one that was in the set.",
        "emoji_pick": "Which one was in the set?",
        "emoji_foot_hint": "Same set for both players. Server-scored.",
        "chimp_title": "Chimp Test Duel",
        "chimp_help": "Numbers flash on the grid, then vanish. Your opponent gets the exact same grid — tap every cell that held a number.",
        "chimp_ready_hint": "Tap start, watch the numbers flash, then tap every cell that held one.",
        "chimp_pick": "Your turn — tap the numbered cells",
        "chimp_count": "There were {n} numbers.",
        "chimp_foot_hint": "Same grid for both players. Server-scored.",
        "word_title": "Word Recall Duel",
        "word_help": "Words appear one by one. Your opponent gets the exact same words — mark each as seen or new.",
        "word_ready_hint": "Tap start, watch the words appear, then mark each as seen or new.",
        "word_judge": "Your turn — mark each word",
        "word_foot_hint": "Same words for both players. Server-scored.",
    },
    "zh": {
        "emoji_title": "表情幽灵对决",
        "emoji_help": "一排符号闪现，其中一个消失了。你的对手拿到的是完全相同的一组——选出刚才在里面的那个。",
        "emoji_ready_hint": "点开始，看符号出现，然后选出刚才在集合里的那个。",
        "emoji_pick": "哪一个刚才在集合里？",
        "emoji_foot_hint": "双方题目完全相同，服务端判分。",
        "chimp_title": "猩猩测试对决",
        "chimp_help": "数字在网格上闪现后消失。你的对手拿到的是完全相同的网格——点出所有刚才有数字的格子。",
        "chimp_ready_hint": "点开始，看数字闪现，然后点出所有刚才有数字的格子。",
        "chimp_pick": "轮到你——点出有数字的格子",
        "chimp_count": "一共有 {n} 个数字。",
        "chimp_foot_hint": "双方题目完全相同，服务端判分。",
        "word_title": "词语记忆对决",
        "word_help": "词语逐个出现。你的对手拿到的是完全相同的词——为每个词标记「见过」或「没见过」。",
        "word_ready_hint": "点开始，看词语出现，然后逐个标记见过或没见过。",
        "word_judge": "轮到你——逐个标记词语",
        "word_foot_hint": "双方题目完全相同，服务端判分。",
    },
    "ja": {
        "emoji_title": "絵文字ゴースト対戦",
        "emoji_help": "一列の記号が点滅し、そのうち1つが消えます。対戦相手も同じ集合を受け取ります。",
        "emoji_ready_hint": "開始を押して記号を確認し、集合にあったものを選んでください。",
        "emoji_pick": "集合にあったのはどれ？",
        "emoji_foot_hint": "両者まったく同じ設問。サーバーが採点します。",
        "chimp_title": "チンパー・テスト対戦",
        "chimp_help": "グリッドの数字が点滅して消えます。対戦相手も同じグリッドを受け取ります。",
        "chimp_ready_hint": "開始を押して数字を確認し、数字があったマスをすべてタップしてください。",
        "chimp_pick": "あなたの番です。数字があったマスをタップ",
        "chimp_count": "数字は {n} 個ありました。",
        "chimp_foot_hint": "両者まったく同じ設問。サーバーが採点します。",
        "word_title": "単語記憶対戦",
        "word_help": "単語が1つずつ表示されます。対戦相手も同じ単語を受け取ります。",
        "word_ready_hint": "開始を押して単語を確認し、それぞれ「見た／初めて」を判定してください。",
        "word_judge": "あなたの番です。単語を判定",
        "word_foot_hint": "両者まったく同じ設問。サーバーが採点します。",
    },
    "es": {
        "emoji_title": "Duelo Fantasma Emoji",
        "emoji_help": "Una fila de símbolos aparece y uno desaparece. Tu rival recibe exactamente el mismo conjunto.",
        "emoji_ready_hint": "Pulsa iniciar, observa los símbolos y elige el que estaba en el conjunto.",
        "emoji_pick": "¿Cuál estaba en el conjunto?",
        "emoji_foot_hint": "El mismo conjunto para ambos. Puntuado por el servidor.",
        "chimp_title": "Duelo Prueba del Chimpancé",
        "chimp_help": "Los números aparecen en la cuadrícula y desaparecen. Tu rival recibe la misma cuadrícula.",
        "chimp_ready_hint": "Pulsa iniciar, observa los números y pulsa cada casilla que tenía uno.",
        "chimp_pick": "Tu turno: pulsa las casillas numeradas",
        "chimp_count": "Había {n} números.",
        "chimp_foot_hint": "La misma cuadrícula para ambos. Puntuado por el servidor.",
        "word_title": "Duelo Memoria de Palabras",
        "word_help": "Las palabras aparecen una a una. Tu rival recibe exactamente las mismas palabras.",
        "word_ready_hint": "Pulsa iniciar, observa las palabras y marca cada una como vista o nueva.",
        "word_judge": "Tu turno: marca cada palabra",
        "word_foot_hint": "Las mismas palabras para ambos. Puntuado por el servidor.",
    },
    "fr": {
        "emoji_title": "Duel Fantôme Émoji",
        "emoji_help": "Une rangée de symboles s'affiche et l'un disparaît. Votre adversaire reçoit exactement le même ensemble.",
        "emoji_ready_hint": "Lancez, observez les symboles, puis choisissez celui qui était dans l'ensemble.",
        "emoji_pick": "Lequel était dans l'ensemble ?",
        "emoji_foot_hint": "Même ensemble pour les deux. Noté par le serveur.",
        "chimp_title": "Duel Test du Chimpanzé",
        "chimp_help": "Des chiffres apparaissent sur la grille puis disparaissent. Votre adversaire reçoit la même grille.",
        "chimp_ready_hint": "Lancez, observez les chiffres, puis touchez chaque case qui en portait un.",
        "chimp_pick": "À vous : touchez les cases numérotées",
        "chimp_count": "Il y avait {n} chiffres.",
        "chimp_foot_hint": "Même grille pour les deux. Noté par le serveur.",
        "word_title": "Duel Mémoire des Mots",
        "word_help": "Les mots apparaissent un par un. Votre adversaire reçoit exactement les mêmes mots.",
        "word_ready_hint": "Lancez, observez les mots, puis indiquez pour chacun s'il a été vu.",
        "word_judge": "À vous : indiquez chaque mot",
        "word_foot_hint": "Les mêmes mots pour les deux. Noté par le serveur.",
    },
    "de": {
        "emoji_title": "Emoji-Geist-Duell",
        "emoji_help": "Eine Reihe Symbole blinkt auf, eines verschwindet. Dein Gegner bekommt genau dieselbe Menge.",
        "emoji_ready_hint": "Start drücken, Symbole ansehen, dann wählen, welches in der Menge war.",
        "emoji_pick": "Welches war in der Menge?",
        "emoji_foot_hint": "Dieselbe Menge für beide. Server-seitig gewertet.",
        "chimp_title": "Schimpansen-Test-Duell",
        "chimp_help": "Zahlen blinken im Raster auf und verschwinden. Dein Gegner bekommt dasselbe Raster.",
        "chimp_ready_hint": "Start drücken, Zahlen ansehen, dann jedes Feld mit einer Zahl antippen.",
        "chimp_pick": "Du bist dran – tippe die nummerierten Felder",
        "chimp_count": "Es waren {n} Zahlen.",
        "chimp_foot_hint": "Dasselbe Raster für beide. Server-seitig gewertet.",
        "word_title": "Wörter-Gedächtnis-Duell",
        "word_help": "Wörter erscheinen nacheinander. Dein Gegner bekommt genau dieselben Wörter.",
        "word_ready_hint": "Start drücken, Wörter ansehen, dann jedes als gesehen oder neu markieren.",
        "word_judge": "Du bist dran – Wörter markieren",
        "word_foot_hint": "Dieselben Wörter für beide. Server-seitig gewertet.",
    },
}

# ── *duel.* ：<head> 的 title / meta_desc（data-i18n-title / data-i18n）──
META = {
    "en": {
        "emojighostduel": ("Emoji Ghost Duel · MemoryDuel",
                           "A row of symbols flashes, then one vanishes. Pick which one was in the set. 1v1 memory duel, same set for both players, server-scored."),
        "chimptestduel": ("Chimp Test Duel · MemoryDuel",
                          "Numbers flash on the grid, then vanish. Tap every cell that held a number. 1v1 memory duel, same grid for both players, server-scored."),
        "wordrecallduel": ("Word Recall Duel · MemoryDuel",
                            "Words appear one by one. Then mark each as seen or new. 1v1 recognition-memory duel, same words for both players, server-scored."),
    },
    "zh": {
        "emojighostduel": ("表情幽灵对决 · MemoryDuel", "记住一排符号，选出消失的是哪一个。1v1 记忆对决，双方题目完全相同，服务端判分。"),
        "chimptestduel": ("猩猩测试对决 · MemoryDuel", "数字在网格上闪现后消失，点出所有有数字的格子。1v1 记忆对决，双方题目完全相同，服务端判分。"),
        "wordrecallduel": ("词语记忆对决 · MemoryDuel", "词语逐个出现，之后逐个标记见过或没见过。1v1 记忆对决，双方题目完全相同，服务端判分。"),
    },
    "ja": {
        "emojighostduel": ("絵文字ゴースト対戦 · MemoryDuel", "記号が点滅し1つ消えます。どれが消えたか選んでください。1v1 記憶対戦、両者同じ設問。"),
        "chimptestduel": ("チンパー・テスト対戦 · MemoryDuel", "数字がグリッドで点滅後消えます。数字があったマスをすべてタップ。1v1 記憶対戦、両者同じ設問。"),
        "wordrecallduel": ("単語記憶対戦 · MemoryDuel", "単語が1つずつ表示され、「見た／初めて」を判定。1v1 記憶対戦、両者同じ設問。"),
    },
    "es": {
        "emojighostduel": ("Duelo Fantasma Emoji · MemoryDuel", "Una fila de símbolos aparece y uno desaparece: elige cuál. Duelo 1v1, mismo conjunto para ambos."),
        "chimptestduel": ("Duelo Prueba del Chimpancé · MemoryDuel", "Los números aparecen y desaparecen: pulsa cada casilla. Duelo 1v1, misma cuadrícula para ambos."),
        "wordrecallduel": ("Duelo Memoria de Palabras · MemoryDuel", "Las palabras aparecen una a una: márcalas como vistas o nuevas. Duelo 1v1, mismas palabras."),
    },
    "fr": {
        "emojighostduel": ("Duel Fantôme Émoji · MemoryDuel", "Une rangée de symboles s'affiche, l'un disparaît : choisissez-le. Duel 1v1, même ensemble."),
        "chimptestduel": ("Duel Test du Chimpanzé · MemoryDuel", "Des chiffres apparaissent puis disparaissent : touchez chaque case. Duel 1v1, même grille."),
        "wordrecallduel": ("Duel Mémoire des Mots · MemoryDuel", "Les mots apparaissent un par un : indiquez vus ou nouveaux. Duel 1v1, mêmes mots."),
    },
    "de": {
        "emojighostduel": ("Emoji-Geist-Duell · MemoryDuel", "Eine Reihe Symbole blinkt auf, eines verschwindet: wählen. Duell 1v1, gleiche Menge."),
        "chimptestduel": ("Schimpansen-Test-Duell · MemoryDuel", "Zahlen blinken auf und verschwinden: tippe jedes Feld. Duell 1v1, gleiches Raster."),
        "wordrecallduel": ("Wörter-Gedächtnis-Duell · MemoryDuel", "Wörter erscheinen nacheinander: markiere gesehen oder neu. Duell 1v1, gleiche Wörter."),
    },
}

# 三个新页面的 <head> 文案键（HTML 里 data-i18n-title / data-i18n 引用）
NEW_PAGES = ["games/emoji-ghost/index.html", "games/chimp-test/index.html", "games/word-recall/index.html"]


def get(d, key):
    cur = d
    for part in key.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def main():
    missing = []

    for lang in LANGS:
        p = os.path.join(I18N, f"{lang}.json")
        with open(p, encoding="utf-8") as f:
            d = json.load(f)

        # 🔴 嵌套写入，不是 d['duel.xxx'] = v（见文件头注释）
        duel = d.setdefault("duel", {})
        for k, v in DUEL[lang].items():
            duel[k] = v

        for ns, (title, desc) in META[lang].items():
            grp = d.setdefault(ns, {})
            grp["title"] = title
            grp["meta_desc"] = desc

        # 清理可能的顶层扁平残留
        for k in [k for k in d if k.startswith("duel.")]:
            del d[k]

        with open(p, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
            f.write("\n")

        # 校验走运行时同款嵌套取值
        with open(p, encoding="utf-8") as f:
            chk = json.load(f)
        for k in DUEL[lang]:
            v = get(chk, f"duel.{k}")
            if not v or v == f"duel.{k}":
                missing.append(f"{lang}:duel.{k}(={v!r})")
        for ns in META[lang]:
            for sub in ("title", "meta_desc"):
                v = get(chk, f"{ns}.{sub}")
                if not v or v == f"{ns}.{sub}":
                    missing.append(f"{lang}:{ns}.{sub}")

    # dictVersion bump：真相源是 public/i18n/VERSION；内联在每个 HTML 的 __I18N_CONFIG__
    vp = os.path.join(I18N, "VERSION")
    with open(vp, encoding="utf-8") as f:
        ver = int(f.read().strip())
    new_ver = ver + 1

    bumped = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [x for x in dirnames if x not in ("node_modules", "dist", ".git", "tests", "scripts")]
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

    # 🔴 新页面的 dictVersion 必须也被 bump —— 它们是本轮新建的，
    #    若构建时未带上新版号，浏览器会拿旧字典缓存，六语全废且不报错。
    for rel in NEW_PAGES:
        fp = os.path.join(ROOT, rel)
        with open(fp, encoding="utf-8") as f:
            html = f.read()
        if f"dictVersion:{new_ver}" not in html:
            print(f"FAIL: {rel} 的 dictVersion 不是 {new_ver}")
            sys.exit(1)

    if not bumped:
        print("⚠️ 没有任何 HTML 被 bump")
        sys.exit(1)
    if missing:
        print("MISSING:", missing)
        sys.exit(1)
    print("六语对战文案写入校验通过")


if __name__ == "__main__":
    main()