# Microcosm

A small floating piece of forest floor with a moss-backed snail wandering across it. Leave food for the snail and the ground it eats and walks on grows richer. Rendered with Three.js, with no build step.

## Run it

The page uses ES modules, so it has to be served rather than opened as a file. From this folder:

```sh
python3 -m http.server 8000
# or: npx serve .
```

Then open <http://localhost:8000>. Three.js (r170) is vendored in `vendor/`, so it works offline. It also runs as-is on GitHub Pages.

## Controls

| | |
|---|---|
| Click the moss | Leave food there |
| Click the snail | It ducks into its shell |
| Drag / scroll | Orbit / zoom |
| `1` / `2` | Choose amber sap or moon dew |
| `N` | Day / night |
| `Space` | Pause |

The speed button cycles 1×, 3× and 8×. Left alone, the view slowly turns on its own. The frame rate is shown in the bottom-right corner.

## What is going on

- **The snail wanders.** It holds a course that drifts, steers around rocks, the log, ferns and mushrooms, and heads for the nearest food. If it cannot get closer to a piece of food it gives up and comes back to it later.
- **The ground follows the snail.** Its trail leaves a little fertility, and food it eats leaves a rich patch. Moss height reads that field directly; pennywort, ferns and mushrooms sprout where it is high enough, and mushrooms are paid for out of what has been eaten.
- **Two foods.** Amber sap drives ordinary growth: thicker moss, ferns that unfurl, russet mushrooms. Moon dew is the invented part: the snail's shell lights up, its trail turns the moss teal for a while, and glowing bell caps and lantern stalks come up along it. These are best seen at night. The ring around each food button shows how much of it is in the ground waiting to fruit.

## Options

Add to the URL: `?q=low` for a lighter render (no MSAA or depth of field, fewer moss layers), `?seed=123` for a different island, `?night=1` to start at night.

The page never shades more than about 2.2 megapixels, and if it averages under roughly 45 fps it steps quality down by itself: resolution first, then anti-aliasing, depth of field and moss layers. `?lock` turns that off.

## Layout

```
index.html          page, UI and styles
src/main.js         renderer, post-processing, input, main loop
src/island.js       island shape, soil cross-section, rocks, log, roots, litter
src/snail.js        the snail: geometry, steering, eating, food beads
src/flora.js        vitality fields, moss, plants, mushrooms
src/atmosphere.js   lights, backdrop, dust, fireflies, spores
src/glsl.js         shared shader noise and material helpers
vendor/             Three.js r170 and the addons used (MIT)
```
