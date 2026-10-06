"""アプリのアイコン(PNG)を描いて public/icons/ に書き出す。使い方: python3 scripts/build-icons.py
SVG 版(public/icons/icon.svg)と同じ図柄: 青い角丸の背景に、白い書類と折り返し。
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public/icons"
ACCENT = (31, 95, 191, 255)
WHITE = (255, 255, 255, 255)
FOLD = (200, 218, 245, 255)
LINE = (31, 95, 191, 255)


def draw(size: int, maskable: bool) -> Image.Image:
    s = 4  # 拡大して描いてから縮小し、輪郭をなめらかにする
    n = size * s
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, n, n], fill=ACCENT)  # 端まで塗る(OS が形を切り抜く)
        inset = 0.22
    else:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.22), fill=ACCENT)
        inset = 0.18
    # 書類
    x0, y0 = n * (inset + 0.08), n * inset
    x1, y1 = n * (1 - inset - 0.08), n * (1 - inset)
    fold = (x1 - x0) * 0.32
    d.polygon([(x0, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1), (x0, y1)], fill=WHITE)
    d.polygon([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)], fill=FOLD)
    # 本文の線
    lw = max(1, int(n * 0.035))
    for k, ratio in enumerate([0.62, 0.62, 0.45]):
        y = y0 + (y1 - y0) * (0.45 + k * 0.15)
        box = [int(x0 + (x1 - x0) * 0.15), int(y), int(x0 + (x1 - x0) * (0.15 + ratio)), int(y) + lw]
        d.rectangle(box, fill=LINE)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        draw(size, False).save(OUT / f"icon-{size}.png")
    draw(512, True).save(OUT / "icon-maskable-512.png")
    print("written:", ", ".join(sorted(p.name for p in OUT.glob("*.png"))))
