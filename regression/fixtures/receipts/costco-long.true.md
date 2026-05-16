# costco-long.jpg — ground-truth transcription

**Coverage role:** Many line items (23 lines) + dual tax rates (A=7.50% non-food, E=2.00% food) + **negative-priced discount lines** (coupon/instant-savings cross-references). This is the most demanding fixture in the set.

## Header

- Store: **Costco**
- Branch: Durham #2_9 (third digit smudged; 249 most likely)
- Address: 1510 North Pointe Drive, Durham, NC 27705
- Member: 112050318521

## Date

- Transaction date: **04/27/2026** (visible in approval line: "04/27/2026 14:07 249 4 255 174")

## Line items (in printed order)

| # | Code prefix | Name (as printed) | Total | Tax class |
|--:|-------------|-------------------|------:|:---:|
|  1 | E 1993061 | SPINDRIFT | 19.69 | A |
|  2 |   1896208 | Q-TIPS | 9.99 | A |
|  3 | 0000376285 | /1896208 (Q-TIPS instant savings) | **-2.00** | A |
|  4 |   1935001 | HUG PU 3T-4T | 39.99 | (none shown) |
|  5 | E 1569515 | HUMM M/P CAN | 12.99 | A |
|  6 | E 0000376416 | /1569515 (HUMM instant savings) | **-4.60** | A |
|  7 |   3610583 | ORAL-B X-FIL | 54.99 | A |
|  8 | E 32911 | KS VANILLA | 9.99 | E |
|  9 | E 670441 | PEET'S BLEND | 21.69 | E |
| 10 | E 1884908 | CHERRIES | 10.79 | E |
| 11 | E 815544 | KS BLUEBERRY | 9.29 | E |
| 12 | E 910270 | ORG GRE BEAN | 6.49 | E |
| 13 | E 967892 | MOZZARELLA | 9.99 | E |
| 14 | E 43099 | ST LOUIS RIB | 29.39 | E |
| 15 | E 1428777 | BLACKBERRIES | 6.99 | E |
| 16 | E 57554 | BLUEBERRIES | 7.69 | E |
| 17 | E 1801 | MANDARINS | 3.99 | E |
| 18 | E 1018249 | ORG ATAULFO | 8.99 | E |
| 19 | E 1309922 | ORG CHIA | 8.99 | E |
| 20 | E 30669 | BANANAS | 1.49 | E |
| 21 | E 96716 | ORG SPINACH | 4.89 | E |
| 22 | E 1875256 | PE GRANOLA | 10.99 | E |
| 23 | E 1875256 | PE GRANOLA | 10.99 | E |

**Note on lines 3 & 6:** These are not "items" in a normal sense — they're SKU cross-references printing the manufacturer's instant-savings credit. The parser should capture them as line items with **negative `totalPrice`** (the receipt-parser explicitly supports negative totals as of PR1 Batch 2). The name field is what's literally printed.

**Note on lines 22 & 23:** Two separate line items for the same SKU at the same price ($10.99 each). The multiset oracle preserves duplicate counts when comparing `(name, totalPrice)` tuples; both entries are asserted independently.

## Totals

- Subtotal: **293.69**
- Tax: **13.08**
  - A 7.50% TAX: 9.83
  - E 2.00% TAX: 3.25
- **Total: 306.77**

## Math check

- Sum of line items: 19.69 + 9.99 - 2.00 + 39.99 + 12.99 - 4.60 + 54.99 + 9.99 + 21.69 + 10.79 + 9.29 + 6.49 + 9.99 + 29.39 + 6.99 + 7.69 + 3.99 + 8.99 + 8.99 + 1.49 + 4.89 + 10.99 + 10.99 = **293.69** ✓
- Tax: 9.83 + 3.25 = **13.08** ✓
- Total: 293.69 + 13.08 = **306.77** ✓

## Payment

Visa ending 2694, Chip Read, approved $306.77, change $0.00.
