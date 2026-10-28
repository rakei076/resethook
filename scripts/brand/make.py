"""Brand assets: pixel bolt on yellow. Writes public/ (served as static assets) and docs/banner.png.
Run: python3 scripts/brand/make.py   (needs Pillow and Google Chrome for the cards)"""
import pathlib, subprocess, tempfile
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
PUB, DOCS = ROOT / "public", ROOT / "docs"
YELLOW, INK = (245, 197, 24), (29, 26, 46)
BOLT = """
................
.......#####....
......#####.....
......####......
.....####.......
.....########...
....########....
........####....
.......####.....
.......###......
......###.......
......##........
.....##.........
.....#..........
................
................""".strip().split("\n")

def pixels():
    return [(x, y) for y, row in enumerate(BOLT) for x, ch in enumerate(row) if ch == "#"]

def svg(rounded=True):
    rects = "".join(f'<rect x="{x}" y="{y}" width="1" height="1"/>' for x, y in pixels())
    rx = ' rx="3"' if rounded else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">'
            f'<rect width="16" height="16"{rx} fill="#f5c518"/><g fill="#1d1a2e">{rects}</g></svg>')

def png(scale, pad=0, rounded=True):
    size = 16 * scale + 2 * pad
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0) if rounded else YELLOW + (255,))
    if rounded:
        from PIL import ImageDraw
        ImageDraw.Draw(img).rounded_rectangle([0, 0, size - 1, size - 1], radius=3 * scale, fill=YELLOW + (255,))
    for x, y in pixels():
        for dx in range(scale):
            for dy in range(scale):
                img.putpixel((pad + x * scale + dx, pad + y * scale + dy), INK + (255,))
    return img

def card(lang, w, h, out):
    zh = lang == "zh"
    title = "Codex 要重置时，<br>叫醒你的 Grok Bot。" if zh else "Wake your Grok Bot<br>before Codex resets."
    sub = "一有重置预告，Bot 收到原帖，在重置前把额度用完。" if zh else "On a reset announcement, your bot gets the post and uses up the quota first."
    html = f"""<!doctype html><meta charset="utf-8"><style>
html,body{{margin:0;width:{w}px;height:{h}px;overflow:hidden;background:#1d1a2e;color:#f4f3f8;font-family:"PingFang SC","Hiragino Sans GB",system-ui,sans-serif}}
.c{{position:relative;width:{w}px;height:{h}px;box-sizing:border-box;padding:72px 84px}}
.t{{font-weight:800;font-size:68px;line-height:1.14;letter-spacing:-.02em;margin:36px 0 22px}}
.s{{font-size:30px;line-height:1.45;color:#b9b6cc;max-width:900px}}
.u{{position:absolute;left:84px;bottom:62px;font:700 28px ui-monospace,Menlo,monospace;color:#f5c518}}
.b{{position:absolute;right:84px;bottom:66px;display:flex;gap:9px}}
.b i{{width:34px;height:34px;background:#f5c518}} .b i.o{{background:#3d3956}}
</style><div class="c"><img src="icon-128.png" width="128" height="128">
<div class="t">{title}</div><div class="s">{sub}</div>
<div class="u">resethook.rakel.top</div><div class="b"><i></i><i></i><i></i><i class="o"></i><i class="o"></i></div></div>"""
    with tempfile.TemporaryDirectory() as d:
        page = pathlib.Path(d) / "card.html"
        page.write_text(html)
        png(8).save(pathlib.Path(d) / "icon-128.png")
        subprocess.run(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--disable-gpu", "--hide-scrollbars",
                        "--force-device-scale-factor=1", f"--window-size={w},{h}", f"--screenshot={out}", page.as_uri()],
                       check=True, capture_output=True)

if __name__ == "__main__":
    PUB.mkdir(exist_ok=True); DOCS.mkdir(exist_ok=True)
    (PUB / "favicon.svg").write_text(svg())
    png(2).save(PUB / "favicon.ico", sizes=[(32, 32)])
    png(11, pad=2, rounded=False).convert("RGB").save(PUB / "apple-touch-icon.png")
    png(32).save(PUB / "icon-512.png")
    card("zh", 1200, 630, str(PUB / "og-zh.png"))
    card("en", 1200, 630, str(PUB / "og-en.png"))
    card("zh", 1280, 640, str(DOCS / "banner.png"))
    card("en", 1280, 640, str(DOCS / "banner-en.png"))
    for p in sorted([*PUB.iterdir(), *DOCS.iterdir()]):
        print(p.relative_to(ROOT), p.stat().st_size)
