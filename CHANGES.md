# Ironveil — visual pass toward reference look

## What changed

### index.html
- `.hud-top` now contains two blocks: a `.hud-top-row` (exit / turn / dice / end-turn — the original buttons) and a new `.inspector-active` panel showing the active unit's portrait, name, HP bar, DMG, RANGE, HEAL/DEF.
- `.stage` now wraps the canvas in an `.arena` element with four SVG banners pinned at each corner (blue on left, red on right) plus `::before`/`::after` stone-wall strips down each side.
- `.hud-bottom` now leads with an `.inspector-terrain` panel showing MOVE / TERRAIN swatch / DEFENSE, above the unit rows + battle log.

### style.css
- New "ARENA FRAME + BANNERS" section with sway animation, stone-wall sides, canvas shadow.
- New "INSPECTORS" section styling both panels with corner brackets matching the existing lobby panel aesthetic. Active-unit panel auto-recolors blue/red based on `data-side`.
- Landscape grid rule updated: left column stacks the button row above the active-unit inspector; right column stacks terrain / player units / log / enemy units.
- Portrait orientation hides both inspector panels (they're landscape-only to match the reference).

### game.js
- One new function `updateInspectors()` called from `updateUI()` and from the canvas hover handlers. It reads from `state` only — no logic changed.
- Terrain inspector updates in real time as the cursor moves over tiles; rubble/brush/blocked states are detected from `state.blockedTypes`.

## What to verify

1. Open `index.html` in landscape on a tablet-ish width (>= 720px). You should see the two side panels flanking the arena with banners.
2. Click a player unit on your turn — the left panel should light up blue with that unit's stats. Enemy hover (if you later add it) will go red; currently enemy units aren't selectable so the panel shows blue.
3. Hover over a rubble/bush tile — the right panel's TERRAIN label should change from "Normal" to "Rubble" or "Brush".
4. Roll the dice — the MOVE readout on the right should show `N / N` and tick down as you use steps.

## Known caveats

- Your `EMBEDDED_ASSETS` references `blue-faceUp`, `blue-faceLeft`, `blue-faceRight` etc. but the uploads only contained the `faceDown` variants. The asset loader warns to console but falls back silently. If characters look like they're always facing the same way, that's why — add the missing PNGs to `assets/`.
- The stone-wall side pieces are pure CSS gradients, not textures. If you want them to match the rich stone look of your `blockedTile1.png`, swap the `.arena::before` / `::after` backgrounds for a tiled `background-image: url('assets/blockedTile1.png')` with `background-size: 28px auto`.
- Banners are inline SVG so they're crisp at any size and sway independently. Easy to restyle — tweak the gradients `#bannerBlue` and `#bannerRed` or replace the inner emblem paths with your own sigils.

## Quick tweaks you might want

- Swap banner colors to your faction palette: edit the `<stop>` colors in `#bannerBlue` / `#bannerRed` inside `index.html`.
- Make the arena frame thicker or thinner: change `padding:24px 52px` on `.arena` and the `width:28px` on `.arena::before/::after`.
- Shrink inspector panels on small laptops: the landscape grid already uses `minmax(180px, 22vw)` and `minmax(210px, 26vw)` — loosen those if you want more board area.
