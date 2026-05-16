# expired-90d.jpg — ground-truth transcription

**Coverage role:** Synthetic fixture exercising the `isValidReceiptDate` rejection branch. The receipt is dated 2026-02-01, which is 103 days before today (2026-05-15) — solidly past the 90-day cutoff (`MAX_RECEIPT_AGE_DAYS = 90`) and stable in this regime indefinitely as the project clock rolls forward.

**This is the ONLY fixture in `regression/fixtures/receipts/` that is not a real photographed receipt.** It exists to prove the parser:
1. Reads the printed date `2026-02-01` from the photo.
2. Calls `isValidReceiptDate('2026-02-01', '2026-05-15')` → false (>90 days).
3. Falls back to `date = today` and preserves `rawExtractedDate = '2026-02-01'`.

The regression sidecar uses `expectRejection: true` + `rejectedDate: '2026-02-01'` to assert both behaviors. Line items, totals, and tax are intentionally **not** asserted in rejection mode — the synthetic OCR is too clean to be a useful real-world signal for those fields.

## How this was generated

`regression/scripts/generate-expired-receipt.py` is a one-off Pillow-based renderer. It uses the macOS-bundled Menlo monospace TrueType font (or falls back to Linux equivalents on CI) to draw the receipt text onto a 640×880 white JPEG. Re-run anytime with:

```sh
python3 -m pip install --user Pillow
python3 regression/scripts/generate-expired-receipt.py
(cd regression/fixtures/receipts && shasum -a 256 expired-90d.jpg > expired-90d.sha256)
```

**Reproducibility caveat (Codex 2026-05-15 #7):** Pillow's JPEG encoder is deterministic for a fixed environment, but different Pillow versions or different installed-font selections can produce different JPEG bytes. The **committed `expired-90d.jpg` is the canonical artifact** — the script is approximate regeneration tooling, not a byte-exact reproduction guarantee. If you regenerate and the bytes change, update `expired-90d.sha256` to match.

## Header

- Store: **Wegmans Food Markets**
- Address: 3450 Erie Boulevard E, Syracuse, NY 13214

## Date

- Printed transaction date: **2026-02-01**
- Today (when this fixture was first committed): 2026-05-15
- Δ = 103 days → fails `isValidReceiptDate` (cutoff: 90 days)

## Line items (for reference; NOT asserted by the sidecar in rejection mode)

| # | Name | Total |
|--:|------|------:|
| 1 | ORGANIC BANANAS | 2.49 |
| 2 | GREEK YOGURT 32 OZ | 4.99 |
| 3 | WHOLE WHEAT BREAD | 3.79 |
| 4 | PASTURE RAISED EGGS | 6.49 |
| 5 | SHARP CHEDDAR 8 OZ | 5.99 |
| 6 | GROUND BEEF 1 LB | 7.49 |
| 7 | ROMA TOMATOES 2 LB | 3.29 |

## Totals

- Subtotal: 34.53
- Tax (8.0%): 2.76
- **Total: 37.29**

## Payment

VISA ****1234

## Accepted limitations

- This is pristine OCR text on white, not a creased thermal print. A parser that handles this fixture cleanly may still fail on a real >90-day receipt with crumpled paper, faded ink, or photo glare. The 4 real-receipt fixtures (costco-long, trader-joes-{correction,long,short}) cover those OCR-robustness concerns; this fixture only proves the date-rejection code path.
