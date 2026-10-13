"""幂等补齐四页的六语 hreflang（2026-10-13 全面复查）。

问题：color-recall / sequence-memory / number-recall / daily-challenge 四页只声明了
  hreflang="en" 与 hreflang="x-default"，
而站点既有范式（public/about/index.html 等 7 页）是 **zh-CN + 六语 ?lang= 参数化 URL + x-default**。
缺失五语 hreflang 会让日/西/法/德语用户在搜索结果里拿不到本页。

修法：按 about 页的同一形态改写 —— 首条用 zh-CN 指向裸 URL，
其余五语指向 ?lang=<code>，x-default 保持指向裸 URL。
"""
import io
import re
import os

ROOT = r"D:\GAME\memoryduel-web"
SLUGS = ["color-recall", "sequence-memory", "number-recall", "daily-challenge"]
BASE = "https://memoryduel.com/games"

# about 页用的语言代码序列（zh-CN 首条用裸 URL，其余带 ?lang=）
CODES = ["zh-CN", "en", "ja", "es", "fr", "de"]


def block_for(slug):
    url = "%s/%s/" % (BASE, slug)
    lines = []
    for c in CODES:
        href = url if c == "zh-CN" else "%s?lang=%s" % (url, c.lower())
        lines.append(
            '<link rel="alternate" hreflang="%s" href="%s" />' % (c, href)
        )
    lines.append('<link rel="alternate" hreflang="x-default" href="%s" />' % url)
    return "\n".join(lines)


changed = []
for slug in SLUGS:
    p = os.path.join(ROOT, "games", slug, "index.html")
    with io.open(p, "r", encoding="utf-8") as f:
        h = f.read()

    # 匹配现有连续的 hreflang 行（含可能的缩进），整段替换
    pattern = re.compile(
        r'(?:[ \t]*<link rel="alternate" hreflang="[^"]*" href="[^"]*"\s*/>\r?\n)+'
    )
    m = pattern.search(h)
    if not m:
        print("!! %s 未找到 hreflang 块，跳过" % slug)
        continue

    want = block_for(slug) + "\n"
    h2 = h[: m.start()] + want + h[m.end():]
    if h2 != h:
        with io.open(p, "w", encoding="utf-8", newline="") as f:
            f.write(h2)
        changed.append(slug)

print("hreflang 补齐：", changed or "无变更（已幂等）")