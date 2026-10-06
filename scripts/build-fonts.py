"""文字入れ・ページ番号(M5)用の日本語フォントを、必要な字だけに絞って public/fonts/ に書き出す。

使い方: python3 scripts/build-fonts.py
入力: node_modules/@expo-google-fonts/biz-udpgothic(BIZ UDPゴシック。SIL OFL 1.1、予約フォント名なし)
出力: public/fonts/BIZUDPGothic-{Regular,Bold}.subset.ttf と OFL.txt

字の範囲は CP932(Windows の日本語。JIS 第1・第2水準漢字、かな、記号、①や㈱などの機種依存文字)と、
いくつかの追加の字。ヒントと組版機能は落として小さくする(印刷用の PDF に埋め込むため不要)。
"""
from pathlib import Path
import shutil

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "node_modules/@expo-google-fonts/biz-udpgothic"
OUT = ROOT / "public/fonts"

# 追加の字: CP932 にないが、日本語の文書でよく使うもの
EXTRA = "〜～—―‐ー・…‥“”‘’「」『』【】〈〉《》〔〕［］｛｝＜＞≦≧≒≠±×÷°℃￥＄％＃＆＊＠§※〒→←↑↓⇒⇔∞∴∵♪♭♯☆★○●◎◇◆□■△▲▽▼"


def cp932_chars() -> set[str]:
    chars: set[str] = set()
    for b in range(0x20, 0x7F):
        chars.add(chr(b))
    for b in range(0xA1, 0xE0):  # 半角カナ
        chars.add(bytes([b]).decode("cp932"))
    for lead in list(range(0x81, 0xA0)) + list(range(0xE0, 0xFD)):
        for trail in list(range(0x40, 0x7F)) + list(range(0x80, 0xFD)):
            try:
                chars.add(bytes([lead, trail]).decode("cp932"))
            except UnicodeDecodeError:
                pass
    return chars


def build(weight: str, src_name: str) -> None:
    font = TTFont(SRC / src_name)
    available = set(chr(c) for c in font.getBestCmap())
    wanted = (cp932_chars() | set(EXTRA)) & available
    options = subset.Options()
    options.hinting = False
    options.layout_features = []
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.glyph_names = False
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=[ord(c) for c in wanted])
    subsetter.subset(font)
    out = OUT / f"BIZUDPGothic-{weight}.subset.ttf"
    font.save(out)
    print(f"{out.relative_to(ROOT)}: {len(wanted)} chars, {out.stat().st_size / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    build("Regular", "400Regular/BIZUDPGothic_400Regular.ttf")
    build("Bold", "700Bold/BIZUDPGothic_700Bold.ttf")
    shutil.copy(SRC / "LICENSE_FONT", OUT / "OFL.txt")
    print("public/fonts/OFL.txt")
