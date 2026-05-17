# trader-joes-correction.jpg — ground-truth transcription

**Coverage role:** Handwritten price correction overlay on a printed thermal receipt. Tests OCR robustness — the parser should extract the **printed** price ($1.99), not the handwritten annotation ($3.99). The receipt's own math (subtotal/tax/total) is internally consistent with the printed prices, which is the additional defense.

## Header

- Store: **Trader Joe's**
- Address: 1800 East Franklin St., Unit 29, Chapel Hill, NC 27514
- Store #0745 — 919-918-7871

## Date

- Transaction date: **05-12-2026** (visible in footer: "STORE 0745 / TILL 9 / TRANS. 29714 / DATE 05-12-2026 15:35")
- Cashier: H. Matthew

## Line items (in printed order)

| # | Name (as printed) | Total |
|--:|-------------------|------:|
| 1 | R-SALAD HERB ORG 5 OZ | 2.49 |
| 2 | Grocery non-taxable | 10.07 |
| 3 | Grocery non-taxable | 9.35 |
| 4 | CUT GRATED PARMESAN (DOM | 6.19 |
| 5 | ORG APPLE CARROT CRUSHER | 2.99 |
| 6 | HERB PARSLEY BUNCH | 1.99 |
| 7 | ORG WHOLE WHEAT SPAGHETT | 1.99 (**printed**) |

**Note on line 7:** A handwritten annotation reads "3.99 -" struck through the original "$1.99". The parser should extract `1.99` (the printed price); the handwriting is human commentary, not OCR signal. The receipt math confirms 1.99 is correct (sum = $35.07 matches the printed subtotal).

**Note on lines 2 & 3:** Trader Joe's prints "Grocery non-taxable" as a generic placeholder when an item's name isn't on file. Two distinct items with the same generic name at different prices — the multiset oracle compares `(name, totalPrice)` tuples, so two entries with the same name but different prices are correctly distinguished.

## Totals

- Subtotal (taxable): **35.07** (printed as "Tax: $35.07 @ 2.0%")
- Tax: **0.70** (2.0% NC reduced grocery rate)
- **Total: 35.77**
- Items in Transaction: 7

## Math check

- Sum of line items: 2.49 + 10.07 + 9.35 + 6.19 + 2.99 + 1.99 + 1.99 = **35.07** ✓
- Tax: 35.07 × 0.02 = 0.7014 → **0.70** ✓
- Total: 35.07 + 0.70 = **35.77** ✓

## Payment

Chase Visa ending 4288, Contactless, Auth Code 05514I.
