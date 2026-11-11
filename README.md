# Microcosm

A small floating piece of forest floor with a living mycelium network in its soil. Feed the network and watch what it does to the moss, ferns and mushrooms above it. Rendered with Three.js, with no build step.

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
| Click moss or soil | Bury food there |
| Drag / scroll | Orbit / zoom |
| `1` / `2` | Choose amber sap or moon dew |
| `X` | Soil view: see the whole network through the ground |
| `N` | Day / night |
| `Space` | Pause |

The speed button cycles 1×, 3× and 8×. Left alone, the view slowly turns on its own.

## What is going on

- **The network grows tip by tip.** Each tip holds a course, wanders a little, turns toward food it can smell, forks, sheds short side branches, fuses with threads it runs into and eventually tires. Nothing is keyframed.
- **Food changes its shape.** Threads that carry food to the heart thicken into cords and pulse with the colour of what they carry. Idle dead ends are slowly reabsorbed, faster when the soil is crowded, so the web keeps reorganising around what you feed it. Small specks of debris appear in the soil on their own, so it keeps foraging even if you do nothing.
- **The surface follows the network.** Threads running near the surface raise a vitality field, and absorbed food leaves a fertile patch above it. Moss height reads that field directly; pennywort, ferns and mushrooms sprout where it is high enough. Mushrooms fruit from actual threads, and the network pays for them out of what it has absorbed.
- **Two foods.** Amber sap drives ordinary growth: thicker moss, ferns that unfurl, russet mushrooms. Moon dew is the invented part: it turns the moss teal and brings up glowing bell caps and lantern stalks, which are best seen at night. The ring around each food button shows how much of it the network is holding.

## Options

Add to the URL: `?q=low` for a lighter render (no MSAA or depth of field, fewer moss layers), `?seed=123` for a different island, `?night=1` to start at night. The page also lowers its own resolution if frames get slow.

## Layout

```
index.html          page, UI and styles
src/main.js         renderer, post-processing, input, main loop
src/island.js       island shape, soil cross-section, rocks, log, roots, litter
src/mycelium.js     network simulation and rendering
src/flora.js        vitality fields, moss, plants, mushrooms
src/atmosphere.js   lights, backdrop, dust, fireflies, spores
src/glsl.js         shared shader noise and material helpers
vendor/             Three.js r170 and the addons used (MIT)
```
