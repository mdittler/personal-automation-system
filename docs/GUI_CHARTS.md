# GUI charts — how to add, revise, or remove one

Charts on the management GUI (Home, AI usage) are driven by a single
declarative registry: `core/src/gui/charts/registry.ts`. This is a recipe
card, not an essay — the rule it encodes is: **editing a chart never touches
template markup or client JS.**

## Add a chart

1. Confirm the metrics endpoint you need already exists (see "Metrics
   endpoints" below). If not, add one first.
2. Add one `ChartDescriptor` to the `CHARTS` array in `registry.ts`:

```ts
{
  id: 'my-new-chart',                          // kebab-case, unique
  page: 'home',                                 // 'home' | 'llm'
  title: 'Plain-language title',                // sentence case
  endpoint: '/gui/api/metrics/llm-daily',        // must be permission-scoped server-side
  type: 'line',                                 // 'line' | 'bar'
  series: [{ key: 'cost', label: 'Spend ($)' }], // keys are fields on the endpoint's days[] rows
}
```

3. If the endpoint is new, add it to `KNOWN_ENDPOINTS` in
   `core/src/gui/charts/__tests__/registry.test.ts`.
4. Run `pnpm vitest run core/src/gui/charts/__tests__/registry.test.ts`. Done
   — the chart now renders on the target page automatically (the page's
   route passes `chartsForPage(page)` to the template, which emits one
   `[data-pas-chart]` slot per descriptor).

## Revise a chart

Edit the descriptor's fields directly (title, series, type, height). No
other file changes.

## Remove a chart

Delete its entry from `CHARTS`. No other file changes.

## Descriptor field reference

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | kebab-case, must be unique across `CHARTS` |
| `page` | `'home' \| 'llm'` | which GUI page renders this chart |
| `title` | `string` | plain-language, sentence case — shown above the chart |
| `endpoint` | `string` | one of the `/gui/api/metrics/*` JSON endpoints; must already enforce permission scoping server-side (never trust query params for scoping) |
| `type` | `'line' \| 'bar'` | Chart.js chart type (see `SUPPORTED_TYPES`) |
| `series` | `Array<{ key, label }>` | which fields of the endpoint's `days[]` array rows to plot, and their legend labels |
| `height` | `number?` | px, default 240 (auto-reduced to 180 on phones by `pas-charts.js`) |

## Adding a new metrics endpoint

1. Add a `GET /gui/api/metrics/<name>` route in `core/src/gui/routes/metrics.ts`.
2. Scoping rule: derive the requester's data from `request.user` — platform
   admins (`request.user.isPlatformAdmin`) see all rows/an aggregate plus a
   per-user or per-app breakdown; everyone else sees only their own rows.
   Never scope from query params.
3. Response shape: `{ days: Array<{ date: string; ...seriesFields }> , ... }`
   — every field a chart might plot must be a numeric key on each `days[]`
   row entry.
4. Write route tests covering: requires auth, member sees only their own
   data, admin sees the aggregate/breakdown, and a missing/empty data source
   returns an empty `days: []` (never a 500).
5. Reference the new endpoint in a chart descriptor (see "Add a chart"
   above) and in the registry test's `KNOWN_ENDPOINTS` list.

## What's forbidden

- Per-chart markup in any `.eta` template. Templates only emit
  `[data-pas-chart]` slots from `chartsForPage(page)`.
- Per-chart JavaScript. `core/src/gui/public/pas-charts.js` is chart-agnostic
  — it reads the slot's `data-*` attributes and instantiates Chart.js
  generically. It is never edited to add or change a specific chart.
- Client-side scoping. All permission scoping happens server-side in the
  metrics route, keyed off `request.user`.
