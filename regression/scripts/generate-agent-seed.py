#!/usr/bin/env python3
"""Generate the agent-bucket seed receipts with exact Decimal totals.

Run from the repo root:  python3 regression/scripts/generate-agent-seed.py
Then regenerate the integrity manifest (see the agent bucket section of regression/README.md).
"""
import os
from decimal import Decimal as D

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fixtures', 'agent', 'household', 'food', 'receipts')

# (id, store, purchase date, [(name, quantity, unit price)], tax)
RECEIPTS = [
    ('2026-04-05-costco-a', 'Costco', '2026-04-05', [('Kirkland Olive Oil 2L', 1, '24.99'), ('Organic Blueberries 18oz', 2, '7.49'), ('Rotisserie Chicken', 1, '4.99'), ('Large Eggs 24ct', 1, '6.99'), ('Paper Towels 12pk', 1, '22.99')], '1.84'),
    ('2026-04-29-traderjoes-a', "Trader Joe's", '2026-04-29', [('Chocolate Croissants 4ct', 1, '5.99'), ('Organic Blueberries 12oz', 1, '4.49'), ('Peanut Butter Creamy', 1, '2.49'), ('Bananas', 6, '0.25')], '0.00'),
    ('2026-05-27-costco-b', 'Costco', '2026-05-27', [('Kirkland Coffee Beans 2.5lb', 1, '18.99'), ('Atlantic Salmon Fillet', 1, '21.47'), ('Strawberries 2lb', 2, '5.99'), ('Greek Yogurt 48oz', 1, '6.49'), ('Large Eggs 24ct', 1, '7.29'), ('Sparkling Water 35ct', 1, '12.99'), ('Avocados 6ct', 1, '6.99')], '2.16'),
    ('2026-06-14-traderjoes-b', "Trader Joe's", '2026-06-14', [('Mandarin Orange Chicken', 2, '4.99'), ('Everything Bagel Seasoning', 1, '2.29'), ('Oat Milk', 2, '3.49'), ('Granola', 1, '3.99')], '0.00'),
    ('2026-07-13-wegmans-a', 'Wegmans', '2026-07-13', [('Organic Blueberries 1pt', 2, '4.99'), ('Whole Milk 1gal', 1, '4.29'), ('Sourdough Loaf', 1, '4.99'), ('Parmesan Wedge', 1, '8.99'), ('Lemons 3ct', 1, '2.99')], '0.00'),
    ('2026-08-26-costco-c', 'Costco', '2026-08-26', [('Kirkland Olive Oil 2L', 1, '25.49'), ('Chicken Thighs 6lb', 1, '19.99'), ('Jasmine Rice 25lb', 1, '21.99'), ('Coconut Milk 6pk', 1, '9.49'), ('Paper Towels 12pk', 1, '23.49'), ('Organic Blueberries 18oz', 1, '7.79')], '3.12'),
    ('2026-09-04-traderjoes-c', "Trader Joe's", '2026-09-04', [('Chocolate Croissants 4ct', 1, '5.99'), ('Frozen Gyoza', 2, '3.99'), ('Hummus', 1, '3.49'), ('Bananas', 5, '0.25')], '0.00'),
    ('2026-09-06-wegmans-b', 'Wegmans', '2026-09-06', [('Large Eggs 18ct', 1, '5.49'), ('Baby Spinach 16oz', 1, '5.99'), ('Coffee Filters 200ct', 1, '3.79'), ('Garlic 3ct', 1, '1.99')], '0.00'),
    ('2026-09-09-costco-d', 'Costco', '2026-09-09', [('Kirkland Coffee Beans 2.5lb', 1, '19.49'), ('Strawberries 2lb', 1, '6.29'), ('Rotisserie Chicken', 2, '4.99'), ('Laundry Detergent', 1, '19.99')], '1.60'),
]


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for rid, store, date, items, tax in RECEIPTS:
        subtotal = D('0')
        body = []
        for name, qty, unit in items:
            total = (D(unit) * qty).quantize(D('0.01'))
            subtotal += total
            body += [f'  - name: {name}', f'    quantity: {qty}', f'    unitPrice: {D(unit)}', f'    totalPrice: {total}']
        esc = store.replace("'", "''")
        lines = [
            '---', f"title: 'Receipt: {esc}'", f'date: {date}', 'tags:', '  - food', '  - receipt', 'type: receipt',
            'entity_keys:', f"  - '{esc.lower()}'", 'app: food', '---',
            f'id: {rid}', f'store: "{store}"', f'date: {date}', 'lineItems:', *body,
            f'subtotal: {subtotal}', f'tax: {D(tax)}', f'total: {subtotal + D(tax)}', f'capturedAt: {date}T18:00:00.000Z', '',
        ]
        with open(os.path.join(OUT, f'{rid}.yaml'), 'w', encoding='utf-8') as fh:
            fh.write('\n'.join(lines))


if __name__ == '__main__':
    main()
