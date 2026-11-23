# Design

The dashboard's visual system ("Señales"). Tokens live in `src/dashboard/src/styles.css`; this page says what they are for.

## Colour

| Token | Light | Dark | For |
|---|---|---|---|
| `--fog` | `#f3f4f7` | `#0f1120` | Page background |
| `--surface` / `--raised` | `#ffffff` | `#171a2c` / `#1c1f33` | Panels; menus and popovers |
| `--ink`, `--ink-2`, `--ink-3` | `#171a2e`, `#565b73`, `#676c83` | `#edeef6`, `#a8acc2`, `#8d92ab` | Text: primary, secondary, muted (all AA on surface and fog) |
| `--line`, `--line-2`, `--line-strong` | | | Panel borders, row dividers, inputs |
| `--ghost` | `#a9adbd` | `#555a75` | Comparison series (the previous period, yesterday) |
| `--good`, `--warn`, `--bad` | | | Status only, always with an icon and a word |

Text never wears a series colour; a swatch beside it carries identity.

### Site colours

Twelve hues, `--s1` … `--s12`, one per site:

| Slot | Name | Light | Dark |
|---|---|---|---|
| `--s1` | `violet` | `#7357f6` | `#8a70ff` |
| `--s2` | `teal` | `#0b9da4` | `#1da9af` |
| `--s3` | `amber` | `#d2700a` | `#c97414` |
| `--s4` | `magenta` | `#d6409f` | `#db4fa6` |
| `--s5` | `blue` | `#3e7bfa` | `#5a8bf5` |
| `--s6` | `olive` | `#7e8d12` | `#8a9a24` |
| `--s7` | `coral` | `#d9503a` | `#f06d57` |
| `--s8` | `indigo` | `#4350d4` | `#6e7cf2` |
| `--s9` | `emerald` | `#108f62` | `#28b582` |
| `--s10` | `plum` | `#993fb8` | `#bc6ad9` |
| `--s11` | `cyan` | `#0381c2` | `#35a4e3` |
| `--s12` | `slate` | `#52607a` | `#8594b2` |

A site's colour is stored when the site is created (`settings.color`, the least-used slot), so adding or archiving a site never repaints another; an admin can change it in the site's settings. Any element with `data-site="<slot>"` sets `--site` and its tints (`--site-tint`, `--site-soft`, `--site-ink`) for everything inside: the site view, its rail entry, its cards on the home, its share page. Every hue clears ≥ 3:1 contrast on both surface and fog in light and dark modes.

## Type

- **Bricolage Grotesque** (display): headline numbers, page and panel titles. Tabular figures for numbers that change.
- **Instrument Sans** (text): everything else.

Both are self-hosted through fontsource and served by the Worker; no third-party font requests.

## Shape and density

Panels are 16 px radius (`--radius-panel`) on the fog background with a hairline border; rows inside are 8 px (`--radius-row`). Lists and tables are dense: 34 px rows, values right-aligned with tabular figures, a thin bar behind the row for its share. Phones get one column, a bottom bar for the main sections and tables that scroll inside their panel.

## Icons and logos

Phosphor icons (regular weight at 14–18 px). Sources show their logo: simple-icons for known brands, then the site's favicon through `/icons/favicon/:host` (signed-in only, cached), then a Phosphor globe. Countries show a flag (country-flag-icons, one SVG file each).

## Motion

| Token | Value | For |
|---|---|---|
| `--motion-quick` | 120 ms ease-out | Hover, focus, small state changes |
| `--motion-base` | 220 ms | Opening drawers, menus, dialogs |
| `--motion-data` | 480 ms, `--ease-data` | Numbers counting to a new value, charts morphing between ranges, rows reordering (FLIP) |

Route changes use View Transitions. Motion answers something the person did (a new range, a filter, a new site); nothing loops except the live dot. `prefers-reduced-motion` turns every transition and animation off.

## Charts

- One y-axis per chart; the comparison period is a ghost line, never a second scale.
- Line and area charts are 2 px monotone curves on a recessive grid, with a crosshair and tooltip; bars have 4 px rounded ends and a 2 px gap.
- A site's charts use its colour; the all-sites river stacks sites in their colours with yesterday as a ghost and a marker for now.
- Heat grids (weekday × hour, retention) use one hue, light to dark.
- Annotations sit in a dedicated lane above the plot as category-tinted pills (showing a truncated title when space allows, or a count when grouped) connected to the timeline by a subtle dashed vertical stem and baseline anchor dot; clicking opens the full details and link. Data-quality markers explain why a KPI shows no change.
- Every chart has a text alternative (`role="img"` with a summary) and, where it carries data a person may need, a table or list view.
