"""幂等给四页补六语 SEO title + meta_desc 键，并挂 data-i18n-title / data-i18n。

背景（2026-10-13 全面复查）：三款对战页与每日挑战页的 <title> 与 <meta description>
全为硬编码英文，切到中/日/西/法/德时浏览器标签页与搜索结果标题仍是英文。
站点已有 data-i18n-title 范式（about / train / 404 等 7 页在用，runtime 会同步 document.title），
本脚本把四页纳入该范式，并补齐 meta_desc（原本也没接 i18n）。
"""
import json
import io
import re
import sys

ROOT = r"D:\GAME\memoryduel-web"

# key: (英文标题, 英文描述, 六语标题, 六语描述)
PAGES = {
    "color-recall": {
        "ns": "colduel",
        "title": "Colour Recall Duel · MemoryDuel",
        "meta_desc": "Memorise a set of colours and rebuild them on the colour wheel. 1v1 colour-memory duel, server-scored, no login required.",
        "titles": {
            "en": "Colour Recall Duel · MemoryDuel",
            "zh": "颜色记忆对决 · MemoryDuel",
            "ja": "色彩記憶対戦 · MemoryDuel",
            "es": "Duelo de colores · MemoryDuel",
            "fr": "Duel des couleurs · MemoryDuel",
            "de": "Farb-Duell · MemoryDuel",
        },
        "descs": {
            "en": "Memorise a set of colours and rebuild them on the colour wheel. 1v1 colour-memory duel, server-scored, no login required.",
            "zh": "记住一组颜色，在色轮上把它们还原出来。1v1 颜色记忆对决，服务端判分，无需登录。",
            "ja": "一組の色を記憶し、色相環上で再現する。1v1 の色彩記憶対戦、サーバー側で採点、ログイン不要。",
            "es": "Memoriza una serie de colores y reconstruyelos en la rueda cromática. Duelo de memoria cromática 1v1, puntuación en el servidor, sin registro.",
            "fr": "Mémorisez une série de couleurs et reconstruisez-les sur la roue chromatique. Duel de mémoire chromatique 1v1, noté par le serveur, sans inscription.",
            "de": "Merke dir eine Farbfolge und stelle sie am Farbkreis wieder her. 1v1-Farbgedächtnisduell, serverseitig gewertet, ohne Anmeldung.",
        },
    },
    "sequence-memory": {
        "ns": "seqduel",
        "title": "Sequence Memory Duel · MemoryDuel",
        "meta_desc": "Memorise the same tile sequence as your opponent and tap it back. 1v1 memory duel, scored on the server, no login required.",
        "titles": {
            "en": "Sequence Memory Duel · MemoryDuel",
            "zh": "序列记忆对决 · MemoryDuel",
            "ja": "数列記憶対戦 · MemoryDuel",
            "es": "Duelo de secuencia · MemoryDuel",
            "fr": "Duel de séquence · MemoryDuel",
            "de": "Folgen-Duell · MemoryDuel",
        },
        "descs": {
            "en": "Memorise the same tile sequence as your opponent and tap it back. 1v1 memory duel, scored on the server, no login required.",
            "zh": "记住与你对手完全相同的格子序列并照样点出。1v1 记忆对决，服务端判分，无需登录。",
            "ja": "相手と同じタイル列を記憶して同じ順にタップする。1v1 の記憶対戦、サーバー側で採点、ログイン不要。",
            "es": "Memoriza la misma secuencia de casillas que tu rival y repítela. Duelo de memoria 1v1, puntuación en el servidor, sin registro.",
            "fr": "Mémorisez la même suite de cases que votre adversaire et reproduisez-la. Duel de mémoire 1v1, noté par le serveur, sans inscription.",
            "de": "Merke dir dieselbe Kachel Folge wie dein Gegner und tippe sie zurück. 1v1-Gedächtnisduell, serverseitig gewertet, ohne Anmeldung.",
        },
    },
    "number-recall": {
        "ns": "numduel",
        "title": "Number Recall Duel · MemoryDuel",
        "meta_desc": "Memorise a string of digits and type it back before your opponent does. 1v1 number-memory duel, server-scored, no login required.",
        "titles": {
            "en": "Number Recall Duel · MemoryDuel",
            "zh": "数字记忆对决 · MemoryDuel",
            "ja": "数字記憶対戦 · MemoryDuel",
            "es": "Duelo de números · MemoryDuel",
            "fr": "Duel de chiffres · MemoryDuel",
            "de": "Zahlen-Duell · MemoryDuel",
        },
        "descs": {
            "en": "Memorise a string of digits and type it back before your opponent does. 1v1 number-memory duel, server-scored, no login required.",
            "zh": "记住一串数字，在对手之前把它敲回来。1v1 数字记忆对决，服务端判分，无需登录。",
            "ja": "数字列を記憶し、相手より先に打ち戻す。1v1 の数字記憶対戦、サーバー側で採点、ログイン不要。",
            "es": "Memoriza una cadena de dígitos y escríbela antes que tu rival. Duelo de memoria numérica 1v1, puntuación en el servidor, sin registro.",
            "fr": "Mémorisez une suite de chiffres et retappez-la avant votre adversaire. Duel de mémoire numérique 1v1, noté par le serveur, sans inscription.",
            "de": "Merke dir eine Ziffernfolge und tippe sie vor deinem Gegner zurück. 1v1-Zahlengedächtnisduell, serverseitig gewertet, ohne Anmeldung.",
        },
    },
    "daily-challenge": {
        "ns": "dc",
        "title": "Daily Memory Challenge · MemoryDuel",
        "meta_desc": "Play today's memory challenge: digit span, sequence recall and colour recall. Same puzzles for every player, scored on the server.",
        "titles": {
            "en": "Daily Memory Challenge · MemoryDuel",
            "zh": "每日记忆挑战 · MemoryDuel",
            "ja": "デイリー記憶チャレンジ · MemoryDuel",
            "es": "Desafío diario de memoria · MemoryDuel",
            "fr": "Défi mémoire quotidien · MemoryDuel",
            "de": "Tägliche Gedächtnis-Challenge · MemoryDuel",
        },
        "descs": {
            "en": "Play today's memory challenge: digit span, sequence recall and colour recall. Same puzzles for every player, scored on the server.",
            "zh": "挑战今日记忆关卡：数字广度、序列回忆与颜色回忆。所有玩家题目相同，服务端判分。",
            "ja": "今日の記憶チャレンジに挑戦：数字スパン、数列再現、色彩再現。全員同じ問題で、サーバー側で採点。",
            "es": "Juega el reto de memoria de hoy: amplitud de dígitos, secuencia y colores. Los mismos puzzles para todos, puntuación en el servidor.",
            "fr": "Relevez le défi mémoire du jour : ampleur de chiffres, séquence et couleurs. Les mêmes énigmes pour tous, noté par le serveur.",
            "de": "Spiele die tägliche Gedächtnis-Challenge: Ziffernspanne, Folge und Farben. Für alle dieselben Rätsel, serverseitig gewertet.",
        },
    },
}

LANGS = ["en", "zh", "ja", "es", "fr", "de"]


def load(path):
    with io.open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save(path, data):
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


changed_i18n = {}
for lang in LANGS:
    path = ROOT + "\\public\\i18n\\" + lang + ".json"
    data = load(path)
    added = []
    for slug, cfg in PAGES.items():
        ns = cfg["ns"]
        bucket = data.setdefault(ns, {})
        tkey, dkey = ns + ".title", ns + ".meta_desc"
        if bucket.get("title") != cfg["titles"][lang]:
            bucket["title"] = cfg["titles"][lang]
            added.append(tkey)
        if bucket.get("meta_desc") != cfg["descs"][lang]:
            bucket["meta_desc"] = cfg["descs"][lang]
            added.append(dkey)
    if added:
        save(path, data)
        changed_i18n[lang] = added

print("i18n 写入：", {k: len(v) for k, v in changed_i18n.items()} or "无变更（已幂等）")

# ── 改 HTML：挂 data-i18n-title / data-i18n ──────────────────────────────
changed_html = []
for slug, cfg in PAGES.items():
    hp = ROOT + "\\games\\" + slug + "\\index.html"
    with io.open(hp, "r", encoding="utf-8") as f:
        h = f.read()

    want_title = '<title data-i18n-title="%s.title">%s</title>' % (cfg["ns"], cfg["title"])
    want_desc = '<meta name="description" data-i18n="%s.meta_desc" content="%s">' % (
        cfg["ns"],
        cfg["meta_desc"],
    )

    h2, n1 = re.subn(r"<title[^>]*>.*?</title>", want_title, h, count=1, flags=re.S)
    h2, n2 = re.subn(
        r'<meta name="description"[^>]*>',
        lambda _m: want_desc,
        h2,
        count=1,
    )
    if (n1, n2) != (1, 1):
        print("!! %s 替换异常 title=%d desc=%d" % (slug, n1, n2))
        continue
    if h2 != h:
        with io.open(hp, "w", encoding="utf-8", newline="") as f:
            f.write(h2)
        changed_html.append(slug)

print("HTML 挂载：", changed_html or "无变更（已幂等）")