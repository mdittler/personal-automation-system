# trader-joes-long.jpg — ground-truth transcription

**Coverage role:** Quantity-multiplier line items (`N @ $unit_price` format). 26 line items, 39 individual items in transaction. Tests the parser's handling of `quantity` + `unitPrice` arithmetic.

## Header

- Store: **Trader Joe's**
- Address: 1800 East Franklin St., Unit 29, Chapel Hill, NC 27514
- Store #0745 — 919-918-7871

## Date

- **Date provided to test suite: 2026-05-15.** Shopping date: not visible in cropped photo — the date line is below the visible cutoff. The sidecar omits the `date` field so the parser's actual extraction (whatever it reads from the full-resolution JPG) is accepted without assertion. If the operator later re-photographs with the date visible, update the sidecar with the real shopping date.

## Line items (in printed order)

| # | Name (as printed) | Qty | Unit | Total |
|--:|-------------------|----:|-----:|------:|
|  1 | MILK ORGANIC GALLON LOW | 1 | 7.49 | 7.49 |
|  2 | PEANUT BUTTER CREAMY SAL | 1 | 2.49 | 2.49 |
|  3 | MEAL THAI WHEAT NOODLES | 1 | 2.49 | 2.49 |
|  4 | WAFER COOKIE DOUBLE CHOC | 1 | 3.99 | 3.99 |
|  5 | BLACK BEANS | 1 | 0.99 | 0.99 |
|  6 | SAVORY THIN MINI CRACKER | 1 | 3.49 | 3.49 |
|  7 | TORTILLAS FLOUR CARB SAV | 1 | 2.99 | 2.99 |
|  8 | BANANA EACH | **8** | 0.23 | 1.84 |
|  9 | CARROTS CUT & PEELED ORG | 1 | 1.99 | 1.99 |
| 10 | SAUSAGE CHICKEN NAE SWEE | 1 | 6.49 | 6.49 |
| 11 | SHAVED STEAK | 1 | 12.64 | 12.64 |
| 12 | GROUND BEEF 96/4 | 1 | 8.99 | 8.99 |
| 13 | ORGANIC BLACKBERRIES 120 | 1 | 7.99 | 7.99 |
| 14 | RS SLICED ITALIAN DRY SA | 1 | 5.49 | 5.49 |
| 15 | R-STRAWBERRIES 2 LB | 1 | 6.99 | 6.99 |
| 16 | BROCCOLI CROWNS | 1 | 2.49 | 2.49 |
| 17 | BROCCOLI CROWNS | 1 | 2.49 | 2.49 |
| 18 | R-SQUASH ZUCCHINI 1.5 LB | 1 | 2.49 | 2.49 |
| 19 | APPLE EACH ORG FUJI | **4** | 0.89 | 3.56 |
| 20 | LIME EACH | **2** | 0.49 | 0.98 |
| 21 | ASPARAGUS 12 OZ | 1 | 3.49 | 3.49 |
| 22 | R-SALAD COMPLETE CRISPY | 1 | 3.99 | 3.99 |
| 23 | PEPPERS BELL TRICOLOR OR | 1 | 4.99 | 4.99 |
| 24 | GREEN ONIONS 6 OZ | 1 | 1.29 | 1.29 |
| 25 | APPLE + STRAWBERRY FRUIT | **2** | 0.99 | 1.98 |
| 26 | APPLE + MANGO FRUIT BAR | **2** | 0.99 | 1.98 |

**Note on quantity multipliers:** Lines 8, 19, 20, 25, 26 have explicit `N @ $unit_price` annotations on the receipt. The receipt-parser should extract `quantity` and `unitPrice` for these. The parser's `normalizeReceiptLineItem` defaults missing quantity to 1 and unitPrice to null for single-quantity lines.

**Note on lines 16 & 17:** Two separate line items for "BROCCOLI CROWNS" at the same price. Multiset oracle preserves the duplicate count when comparing `(name, totalPrice)` tuples.

## Totals

- Subtotal: **106.08** (printed as "Tax: $106.08 @ 2.0%")
- Tax: **2.12** (2.0% NC reduced grocery rate — all items food)
- **Total: 108.20**
- Items in Transaction: **39** (sums: 7×1 + 8 + 10×1 + 4 + 2 + 4×1 + 2 + 2 = 39)

## Math check

- Sum of line totals: 7.49 + 2.49 + 2.49 + 3.99 + 0.99 + 3.49 + 2.99 + 1.84 + 1.99 + 6.49 + 12.64 + 8.99 + 7.99 + 5.49 + 6.99 + 2.49 + 2.49 + 2.49 + 3.56 + 0.98 + 3.49 + 3.99 + 4.99 + 1.29 + 1.98 + 1.98 = **106.08** ✓
- Tax: 106.08 × 0.02 = 2.1216 → **2.12** ✓
- Total: 106.08 + 2.12 = **108.20** ✓

## Payment

Chase Visa ending 4288, Contactless, Auth Code 01550I (last digit partially visible).
