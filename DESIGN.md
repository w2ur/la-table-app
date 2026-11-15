# DESIGN.md — La Table

Direction "Trois champs", chosen by the owner on 2026-10-10, with the price
column and budget line of the "Ticket" proposal folded into the Courses list.

## Read

Reading this as: a phone-first list app for two people at home, used at the
fridge, in the kitchen and in a shop aisle, with a direct, market-stall language.

## Domain

- three lists that feed each other: on mange (Menu) → on achète (Courses) → il reste (Reste)
- the tick: a meal cooked, an item bought, an item finished
- the season: what the stall sells this week
- the receipt: what the basket costs, against a weekly budget
- the use-by date on what is left
- the aisle: an item is found by where it sits in the shop

## Colour world

Found in the subject:

- squash yellow-orange — butternut and potimarron on the autumn stall
- leek green — the green end of a leek bundle
- tomato red — summer tomatoes, the reddest thing on any stall
- receipt white — the thermal paper of the till ticket
- kraft brown — the paper bag (noted, not used: it sits in the warm-paper family the portfolio already owns)
- beetroot purple — refused: purple is on the global ban list

Tokens:

| token | role | light | dark |
|---|---|---|---|
| `--ground` | page ground (receipt white) | `#FFFFFF` | `#14171A` |
| `--ink` | body text | `#191D20` | `#ECEFF1` |
| `--muted` | secondary text (full strength, not opacity) | `#5A6369` | `#A0AAB0` |
| `--rule` | row separators, borders | `#DCE1E4` | `#2C3338` |
| `--field-menu` | header field of Menu, squash; text on it is `--ink` light | `#E8A317` | `#C88A0A` |
| `--field-courses` | header field of Courses, leek; text on it is white | `#2F7D4F` | `#2B6E47` |
| `--field-reste` | header field of Reste, tomato; text on it is white | `#C23B22` | `#B23A24` |

The three fields are the only colour in the app, and each means one thing:
which list you are in. No field colour appears anywhere else (no coloured
links, no coloured ticks, no coloured badges).

Dark is a near-black cool ground with the fields deepened so white text keeps
its contrast. Light is the default for the use scene (a shop in daylight,
a lit kitchen); `prefers-color-scheme` decides, no toggle.

## Type

| role | family | why it fits the Read |
|---|---|---|
| headings | Archivo, width 100, weight 700 | a plain grotesque with a stall-sign directness |
| list rows | Archivo, width 80–85, weight 500 | condensed fits a long ingredient name on a phone line |
| figures | Archivo with `tabular-nums` | prices align down the right-hand column, as on a receipt |

Self-hosted (`@fontsource-variable/archivo`) so the PWA works offline, Latin face only (`src/app/archivo.css`): French needs no other subset, and each one would be precached.

Scale (px): 13 meta (quantities, dates), 16 body and rows, 20 list title in the
field, 28 week title.

Tracking: the font's defaults everywhere. No uppercase labels.

## Space & shape

Spacing scale (px): 4 inside a row, 12 row padding, 16 page gutter, 24 between groups (aisle, day).

| role | radius |
|---|---|
| controls (tick box, buttons) | 4 |
| radio (a choice among several) | round, so it never reads as a tick |
| surfaces / fields | 0 — the header field is full-bleed |
| media | none (no images) |

Rows are separated by a 1 px `--rule`, never boxed in cards.

## Motion

| motion | how often seen | duration | easing |
|---|---|---|---|
| tick (box fills, row text muted) | every interaction | 120 ms | ease-out |
| field colour on list switch | several times a visit | 160 ms | ease-out |

Reduced motion: both become instant.

## Signature

The header field: the active list's colour fills the whole top band, in one
place only, because the subject is three lists and the first thing to know is
which one you are holding.

## Refused defaults

- G1 — refused; the ground is receipt white, not paper.
- A1 — refused; one family (Archivo), no display serif.
- A4 / R8 — refused; rows on rules, 4 px controls, no pills, no card grid.
- B9 — refused; flat fields, no gradient, glass or glow.
- C16 — refused; a field colour marks the list, never hierarchy or links.

## References

| site | taken | refused |
|---|---|---|
| https://mela.recipes | one saturated field (`#FFD609`) carries the whole identity | body text at 60 % white opacity, 79 % of all text (A10) |
| https://culturedcode.com/things/ | plain list rows separated by rules, no boxes | one blue doing links and actions at once (C16) |
| https://www.getbring.com/en/home | colour as a navigation cue for in-shop scanning | 30 px radii and rounded type everywhere (A4, R8) |

## Differs from

| neighbour | its direction in one line | axis this one differs on |
|---|---|---|
| william-revah-paris | daily-edition front page on warm paper, one serif | ground, type family |
| bas-de-laine | warm cream, sage, terracotta, Instrument Serif figures | ground, type family |
| my-tsundoku | warm paper, forest green, Playfair display | ground, type family |
| pogofish | ink on warm paper, vermilion, Instrument Serif | ground, type family |
| ecritoire | "Encre" warm paper, oxblood, Newsreader | ground, type family |
| untilt | cool grey page, dark cover, serif display | type family, signature |
| elenchus-web | same house shell as untilt, teal tool accent | type family, signature |
