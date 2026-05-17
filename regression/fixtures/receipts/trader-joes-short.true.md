# trader-joes-short.jpg — ground-truth transcription

**Coverage role:** Basic short receipt — 10 line items, dual tax rates on the same receipt (T-marked = 7.5% non-food, unmarked = 2.0% food). Tests the parser's handling of the simplest case **plus** mixed tax classes.

## Header

- Store: **Trader Joe's**
- Address: 1800 East Franklin St., Unit 29, Chapel Hill, NC 27514
- Store #0745 — 919-918-7871

## Date

- **Date provided to test suite: 2026-05-15.** Shopping date: not visible in cropped photo — the date line is below the visible cutoff. The sidecar omits the `date` field so the parser's actual extraction (whatever it reads from the full-resolution JPG) is accepted without assertion. If the operator later re-photographs with the date visible, update the sidecar with the real shopping date.

## Line items (in printed order)

| # | T? | Name (as printed) | Qty | Unit | Total |
|--:|:--:|-------------------|----:|-----:|------:|
|  1 |    | CAKE CARROT SHEET MINI | 1 | 5.99 | 5.99 |
|  2 | T  | NTRL BROWN COFFEE FILTER | **2** | 2.69 | 5.38 |
|  3 |    | CROISSANTS 4 CHOCOLATE | 1 | 5.99 | 5.99 |
|  4 | T  | HAND SOAP FOAMING CLEMEN | 1 | 2.99 | 2.99 |
|  5 |    | CROISSANTS 4 CHOCOLATE | 1 | 5.99 | 5.99 |
|  6 | T  | SEMI SWEET CHOC CHIPS | 1 | 3.99 | 3.99 |
|  7 |    | BACON ABF UNCURED DRY RU | 1 | 5.99 | 5.99 |
|  8 |    | MAPLE SYRUP GRADE A AMBR | 1 | 4.99 | 4.99 |
|  9 |    | MANGO EACH | **2** | 1.49 | 2.98 |
| 10 |    | BANANA EACH | **7** | 0.23 | 1.61 |

**Note on the `T` flag:** Trader Joe's marks taxable-at-full-rate items with a leading `T`. In this receipt:
- T-flagged items (coffee filter, hand soap, chocolate chips): taxed at 7.5% (non-food).
- Unflagged items (everything else, including chocolate croissants and maple syrup): taxed at 2.0% (NC reduced grocery rate).

**Note on lines 3 & 5:** Identical name + price ("CROISSANTS 4 CHOCOLATE", $5.99). The multiset oracle preserves duplicate counts when comparing `(name, totalPrice)` tuples — both entries assert independently.

## Totals

- Subtotal A (2.0% food): **33.54**
- Subtotal B (7.5% non-food): **12.36** (T-marked items)
- Combined subtotal: **45.90**
- Tax A: **0.67** (33.54 × 2.0%)
- Tax B: **0.93** (12.36 × 7.5%; printed value partially obscured but inferable)
- Combined tax: **1.60**
- **Total: 47.50**
- Items in Transaction: 18 (= 1+2+1+1+1+1+1+1+2+7)

## Math check

- T-marked sum: 5.38 + 2.99 + 3.99 = **12.36** ✓
- Unmarked sum: 5.99 + 5.99 + 5.99 + 5.99 + 4.99 + 2.98 + 1.61 = **33.54** ✓
- Combined subtotal: 12.36 + 33.54 = **45.90** ✓
- Tax: 0.67 + 0.93 = **1.60** (33.54 × 0.02 = 0.6708; 12.36 × 0.075 = 0.927)
- Total: 45.90 + 1.60 = **47.50** ✓

## Payment

Chase Visa ending 4288, Contactless, Auth Code 07292I, TID ****3623.
