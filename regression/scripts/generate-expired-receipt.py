#!/usr/bin/env python3
"""
Synthesize the `expired-90d.jpg` regression fixture.

This is a one-off generator for the only fixture in `regression/fixtures/receipts/`
that doesn't come from a real photographed receipt. It exists to exercise the
production parser's `isValidReceiptDate` rejection branch — the parser will OCR
the date below, fail the 90-day check, fall back to "today" for `date`, and
preserve the original extraction in `rawExtractedDate`. The regression suite's
`expectRejection: true` sidecar then asserts both fields.

Receipt date is deliberately set to 2026-02-01 — that's 103 days before today
(2026-05-15) and remains >90 days old indefinitely as the project clock rolls
forward. Whenever today's date is, this fixture stays rejected.

Dependencies:
    python3 -m pip install --user Pillow

Output:
    regression/fixtures/receipts/expired-90d.jpg

Re-run anytime to regenerate the JPG. NOTE on reproducibility: the committed
`expired-90d.jpg` is the canonical artifact. The script approximates that
artifact but a different Pillow version or different installed-font selection
can produce different JPEG bytes — the `.sha256` manifest tracks the committed
file only. After regeneration, re-run `shasum -a 256 expired-90d.jpg` and
update `expired-90d.sha256` if you intend the new bytes to be canonical.

Pillow version verified to produce the committed bytes (host: macOS, /System
Menlo TTC, Pillow 11.3.0). Other environments will produce visually similar
but byte-different output.
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print(
        "ERROR: Pillow is not installed. Run:\n  python3 -m pip install --user Pillow",
        file=sys.stderr,
    )
    sys.exit(1)


RECEIPT_TEXT = """WEGMANS FOOD MARKETS
3450 Erie Boulevard E
Syracuse, NY 13214

Order #4827
Date: 2026-02-01

ORGANIC BANANAS         2.49
GREEK YOGURT 32 OZ      4.99
WHOLE WHEAT BREAD       3.79
PASTURE RAISED EGGS     6.49
SHARP CHEDDAR 8 OZ      5.99
GROUND BEEF 1 LB        7.49
ROMA TOMATOES 2 LB      3.29

SUBTOTAL              34.53
TAX (8.0%)              2.76
TOTAL                 37.29

VISA ****1234
THANK YOU FOR SHOPPING"""


def find_monospace_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """Try macOS's bundled Menlo first, then Linux/CI font paths, then PIL default."""
    candidates = [
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Courier New.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def main() -> None:
    out_path = (
        Path(__file__).resolve().parent.parent / "fixtures" / "receipts" / "expired-90d.jpg"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)

    width, height = 640, 880
    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)
    font = find_monospace_font(20)

    # Center-align line by line. Pillow ≥9 uses textbbox; older uses textsize.
    y = 40
    line_spacing = 28
    for line in RECEIPT_TEXT.split("\n"):
        try:
            bbox = draw.textbbox((0, 0), line, font=font)
            text_w = bbox[2] - bbox[0]
        except AttributeError:
            text_w, _ = draw.textsize(line, font=font)  # type: ignore[attr-defined]
        x = (width - text_w) // 2
        draw.text((x, y), line, fill="black", font=font)
        y += line_spacing

    img.save(out_path, format="JPEG", quality=90, optimize=True)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
