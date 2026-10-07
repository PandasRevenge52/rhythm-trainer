# Rhythm Trainer

A browser app for learning to read and play rhythms (the trainer, `index.html`), plus a 4-lane falling-note
game made from a song's drums, vocals or guitar (the Arcade, `arcade.html`) with online multiplayer.
Live at https://pandasrevenge52.github.io/rhythm-trainer/. GitHub Pages serves the `main` branch, so **`main` is
the live site**. Friends use it.

## Stack
- Static HTML, CSS and plain JavaScript. No framework, no build step, no npm dependencies in the app.
- Scripts are classic `<script defer>` files sharing globals, in a fixed order (see the bottom of each HTML
  file). Don't use ES modules: the app must also run when opened straight from disk (`file://`). A new script
  goes into the page's script list **and** `sw.js`'s `FILES`.
- `js/data.js` is shared by both pages (settings, storage, achievements, drawing and motion helpers).
  Trainer: `generate`, `notation`, `engine`, `judge`, `lane`, `progress`, `ui`, … Arcade: `arcade.js`,
  `randomsong.js`, `drums.js` (song analysis), and multiplayer loaded on demand (`multiplayer.js`, `relay.js`,
  `js/vendor/peerjs.min.js`).
- Multiplayer: PeerJS (public 0.peerjs.com signalling) for direct connections, with an encrypted MQTT relay
  (public brokers) as the backup route.
- `sw.js`: offline support. Pages and code are network-first; fonts and icons are cache-first. **Bump `CACHE`**
  whenever files are added or removed, or a font or icon changes.
- Fonts are self-hosted in `fonts/` (Figtree, plus Twemoji for emoji).
- Look ("Mono"): every colour is a token in `css/app.css` `:root`, and the Arcade and multiplayer canvases read
  them with `TOK()`. Glows stay inside their own element. Motion uses the `--dur-*` and `--ease-*` tokens, with
  transform and opacity only.
- Security: a strict CSP `<meta>` in both HTML files (no inline scripts), and escaped multiplayer fields.
  `optimization/security.md` has the full list.
- `charts/` holds high-quality song charts made offline by `tools/make-charts` (see `tools/README.md`).
  `original.html` and `single-file-backup.html` are old single-file versions, kept as backups.

## Running it
- Quick look: open `index.html` in a browser (no service worker or multiplayer relay from `file://`).
- Like GitHub Pages (gzip, caching, ETags): `python3 optimization/tools/ghserve.py ~/rhythm-trainer 8777`,
  then http://127.0.0.1:8777/.
- On a phone: `optimization/tools/phone-preview.sh <branch>` prints a QR code for a temporary https tunnel
  (`--lan` for plain http on the same Wi-Fi). Ctrl+C stops it.

## Measuring tools (`optimization/`, git-ignored, so on this machine only)
`optimization/progress.md` is the running handoff log. `optimization/report.md` holds the numbers that must not
regress (section 0 = the current live baseline). Set up once with `optimization/tools/setup.sh`, then:
```sh
cd optimization/tools
export CFT=$(ls -d /tmp/rt-work/cft/chrome/*/chrome-linux64/chrome | tail -1) WORK=/tmp/rt-work NODE_PATH=$PWD/node_modules
python3 ghserve.py ~/rhythm-trainer 8777 &                                         # the working tree
mkdir -p $WORK/main && git archive main | tar -x -C $WORK/main && python3 ghserve.py $WORK/main 8781 &   # live code, to compare against
```
| Check | Command |
|---|---|
| Smoke test (15 checks, both pages) | `node smoke.js http://127.0.0.1:8777` |
| Lighthouse, median of 3 | `./lh-cft.sh <label> http://127.0.0.1:8777 3` then `node summarize.js $WORK/lhout/<label>` |
| Trainer key-press latency (INP) | `PLAY_MS=30000 node runtime-cft-3s.js <url> <label> 4` (and `16` for an old phone) |
| Arcade key-press latency (INP) | `node arcadeinp.js <url> <label> 4` (and `16`) |
| Frame rate while playing | `node fps.js <url> index\|arcade 4` (and `16`), phone screen |
| Play both pages, desktop and phone (errors, CSP) | `node playcheck.js <url>` |
| Multiplayer, every flow | `MODE=basic URL=<url>/arcade.html node mpflows.js`, then `MODE=code`, then `MODE=drop BLOCK=1` |
| Returning visitor gets the update | `node returning.js` (after a release, against the live site) |
| Animation declarations parse | `node animcheck.js` |

Always compare against `main` measured in the same session, with runs alternating. Absolute numbers drift
between machines and sessions (`report.md` "Read this first").

## Standing rules
- **Never merge into `main` or push `main` without the owner's explicit approval.** Work on a branch, one
  change per commit.
- **No regressions against `report.md`:** Lighthouse performance, CLS, INP and page weight. Re-measure after
  changes, and simplify or remove anything that regresses.
- **The CSP and every security fix stay in place.** No inline scripts, and don't loosen the CSP to make
  something work without saying so first.
- **Retest every multiplayer flow** (host, invite link, typed code, match, rematch, leave, relay with a
  dropout) after any change that touches the Arcade, multiplayer or shared code.
- **Respect `prefers-reduced-motion`** everywhere, with a calm but clear alternative (colour and text, no
  movement). Animations started from script check it themselves (`stillMQ`, `CALM`).
- **Accessibility stays at 100**, and contrast passes WCAG AA.
- Gameplay effects must not add input latency or drop frames: canvas or transform/opacity only, never
  layout in the game loop.
- Show visual changes (screenshots or recordings) and get approval before building them out.
- After a release: smoke test on the live URL, both pages on desktop and phone with no console or CSP
  errors, the returning-visitor check, a live multiplayer match, then update `progress.md` and `report.md`.
