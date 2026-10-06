# テスト用の CFF(OpenType)フォントを作る。文字のアウトライン化(D-034)の単体テストで使う。
# 使い方: python scripts/make-test-cff-font.py  → tests/fixtures/test-cff.otf
# 字形は単純な図形だけ(A: 四角、B: 三角、あ: 四角の中に四角の穴)。このリポジトリで作った自前のフォント。
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen

UPEM = 1000
ROOT = Path(__file__).resolve().parent.parent


def draw(commands):
    pen = T2CharStringPen(600, None)
    for c in commands:
        kind, *pts = c
        if kind == "M":
            pen.moveTo(pts[0])
        elif kind == "L":
            pen.lineTo(pts[0])
        elif kind == "C":
            pen.curveTo(*pts)
        elif kind == "Z":
            pen.closePath()
    return pen.getCharString()


glyphs = {
    ".notdef": [],
    "space": [],
    # A: 100〜500 の四角
    "A": [("M", (100, 0)), ("L", (500, 0)), ("L", (500, 700)), ("L", (100, 700)), ("Z",)],
    # B: 三角(曲線を 1 つ含む)
    "B": [("M", (50, 0)), ("L", (550, 0)), ("C", (550, 300), (400, 700), (300, 700)), ("Z",)],
    # あ(U+3042): 外側の四角と、逆回りの内側の四角(穴)
    "uni3042": [
        ("M", (100, -50)), ("L", (900, -50)), ("L", (900, 750)), ("L", (100, 750)), ("Z",),
        ("M", (300, 150)), ("L", (300, 550)), ("L", (700, 550)), ("L", (700, 150)), ("Z",),
    ],
}
order = list(glyphs)
advance = {".notdef": 600, "space": 300, "A": 600, "B": 600, "uni3042": 1000}

fb = FontBuilder(UPEM, isTTF=False)
fb.setupGlyphOrder(order)
fb.setupCharacterMap({0x20: "space", 0x41: "A", 0x42: "B", 0x3042: "uni3042"})
fb.setupCFF("TestCFF-Regular", {"FullName": "Test CFF"}, {g: draw(c) for g, c in glyphs.items()}, {})
fb.setupHorizontalMetrics({g: (advance[g], 0) for g in order})
fb.setupHorizontalHeader(ascent=880, descent=-120)
fb.setupNameTable({"familyName": "Test CFF", "styleName": "Regular"})
# fsType 0(インストール可)
fb.setupOS2(sTypoAscender=880, sTypoDescender=-120, usWinAscent=880, usWinDescent=120, fsType=0)
fb.setupPost()
out = ROOT / "tests" / "fixtures" / "test-cff.otf"
out.parent.mkdir(parents=True, exist_ok=True)
fb.save(out)
print(f"written: {out} ({out.stat().st_size} bytes)")
