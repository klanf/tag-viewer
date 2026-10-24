# TagViewer — a visual tag dashboard powered by WD14

[中文](README.md) | **English**

A local-first, single-process Electron app (Vue 3 frontend) that turns a folder of images into an ammunition depot of tags for ComfyUI generation.

> 🎬 **Prefer watching?** [2-minute walkthrough](https://www.bilibili.com/video/BV19ZaD67EMs/) — from unzipping to the first generation.
> 🚀 **First time here?** Start with [docs/新手上手.md](docs/新手上手.md) (Chinese) — environment setup, where data lives, five steps to the first loop.
> 🛠️ **Hacking on the code?** Architecture, full command table, changelog and pitfalls live in [docs/开发手册.md](docs/开发手册.md) (Chinese).
> 📦 **Just want it installed?** Grab a build from [Gitee Releases](https://gitee.com/klanf/tag-viewer/releases).
> The [GitHub repo](https://github.com/klanf/tag-viewer) is the source mirror; GitHub Releases are not enabled yet.

## What this project is for

**One sentence: turn images into a tag arsenal, so ComfyUI rolls give you more freedom.**

![Board: filter by source with safety mode](docs/images/home.png)

### Where the tags come from

Two paths. First, **images you collected** — saved from the web, shared by others. The app runs WD14 inference to describe each image and produce a tag set. Second, **images you generated yourself** — those already carry the tags used to make them. The interesting part: the same tag set rolled ten times gives ten different images — same “blue hair, school uniform, classroom”, different poses and framing. Pick the one you like, run inference on it, and you get an “evolved” new tag set. Repeat, and the tag library snowballs.

### Export: compose on demand, ban what you don't want

The richer the tag combinations you can export, the more room you have when rolling. Want “a knight raising a sword”? Inventing words from scratch is dry. But if the library holds twenty knight images from different angles, exporting three sets and mixing them gives much richer results. Export is composable: exporting “Saphir” always drags along `closed_eyes`; this time you want open eyes, so ban `closed_eyes` and it is filtered automatically. Want a full-body standing shot? Drop the “close-up” group. Want a big face? Drop “full body”. One switch each.

### Character library and cart: export a team

The app recognizes who is in each image and groups everything by character — a character-sorted image library for free. See someone you like while browsing, add them to the cart. Want a two-character image? Put both in the cart, export one character-group file, drop it back into ComfyUI. Finished teams can also be **saved as lists** and reloaded from “My lists” later instead of re-adding everyone.

**Different character combinations × different tag combinations — multiply the two dimensions and the possibilities explode.**

![Series browsing: work → character](docs/images/series.png)

![Character cart: bulk add and one-click export](docs/images/cart.png)

### Image management that stays out of the way

Full-screen paging, bulk move-and-archive, one-click filtering by character — all in service of generating images.

![Lightbox: every tag carries a Chinese translation](docs/images/lightbox.png)

**Registering your first image folder**: Scan page → “🗄️ Sources” in the top right → adding a folder registers and scans it. “Remove” only unregisters the source (reversible, images stay in the library); “Purge” deletes the records.

![Source management: folders as channels, toggles as purpose](docs/images/sources.png)

## Six things worth trying first in the v2.3 line

1. **Drill down through tags inside a series**: All series > Blue Archive > airi_(band) > breasts. Every level has a path bar on top; the leftmost arrow goes back one level and restores the exact lightbox you were looking at — not a restart. Clicking a tag on the board / series / scan page opens an **in-place level** (no route change, top tabs stay put). Tag pages can stack further, and each level remembers its own filters and selections.
2. **Use the duplicate panel as a stream**: scrolling to the bottom loads the next batch automatically, with a back-to-top button in the bottom right. The lightbox keeps going across groups and scrolling returns you to the group you just left. “Which one to keep” became a dropdown (artist info / creation time / file size / resolution / embedded metadata / filename artist hints). Wrongly flagged groups can be **permanently ignored** via “delete record” (records only, images untouched), with a one-click restore-all at the bottom.
3. **In-library hits: find “the image most like this one”**: from the lightbox, the “in-library hits” badge scores the whole library after dropping character and camera-angle words — great for finding the same composition or outfit. With zero hits it falls back to the closest matches. Results open as an in-place level; leaving returns where you came from.
4. **Ctrl+wheel zoom everywhere**: image grids on the board, tag pages, favorites, the series root and the scan page, plus the lightbox, duplicate panel and series/character cards. A percentage badge appears at the bottom, fades when you stop, and resets to 100% on click.
5. **Restrict the board to ComfyUI-generated images**: filtered by the source embedded in the image metadata, which beats guessing from filenames. Images that have not been read yet are backfilled in the background.
6. **Safety mode has an inverse**: normal safety mode hides sensitive images; the new **unsafe mode** does the opposite — showing only images that hit sensitive tags, so you can review exactly what needs cleaning.

## Feature map

| What you want | Where |
| --- | --- |
| Find images / filter the library by tag / ComfyUI-only view | Board (Home) |
| Find duplicate or similar images (cross-source) | “🔎 Duplicates” in the board action bar |
| Bulk-tag folders / add missing character or series tags | Scan page — WD14 inference |
| Full-screen viewing, zoom, number keys 1–9 to move files | Lightbox |
| Browse characters by work, bulk-add to cart, rename/move/ban | Series page |
| Manage all tags, ban directly, filter by category | Tags page |
| See all images of a tag and keep drilling down | Tag detail page |
| Build character teams, save/load lists, export for ComfyUI | Cart |
| Manage folder visibility, covers and sorting | Scan page → “🗄️ Sources” |
| Revisit starred images | Favorites |
| Configure auto-export / blacklist / **replace-rule sets** / external programs | Settings drawer (⚙ top right) |

## Details that actually earn their keep

- **Every tag has a Chinese translation**: 16,558 translations and ~3,400 human-curated categories are built in, so the UI reads “蓝发”, “教室” — no vocabulary barrier when picking words.
- **The search box builds phrases**: type a comma (Chinese or English) to freeze the current word into a pill and start suggesting the next one. “Select all” in the dropdown adds every tag matching the current word at once (type 发 → all hair colors/styles, combined with “any” means you want them all). Arrow-key navigation auto-scrolls; Enter during pinyin composition does not trigger a search.
- **Safety mode on every page**: hide unhealthy images with one toggle on the board, favorites, cart, scan and series pages. Even **cover thumbnails** switch to a safe image (or a neutral placeholder when none exists), and sensitive tag entries are hidden on tag pages. If a page is hidden empty, you can still manually pull the next batch.
- **The lightbox reads embedded metadata**: switch from the tag library to the image's original metadata tags. Entries are matched against the library first — hits show the library image count and link straight there; misses are greyed out and only copy on click.
- **Tag pages are made for scrolling**: “Hide banned” keeps banned entries out of sight by default (one click shows them, remembered locally); the list loads more as you reach the bottom.
- **Image folders as channels**: one button per folder; click to see only that folder. Removing a source hides it from the UI (files untouched, reversible). The scan page offers 8 sort orders (filename / subfolder / modified time / size / tag count) and renders only the current page, so huge folders stay responsive.
- **A whole work's character roster, ready-made**: organized as work → character, with Chinese search and bulk add-to-cart. Character cards can be favorited, and the menu can ban them (with a confirmation and a “don't ask again” option).
- **Covers are customizable and safety-aware**: hover a series or character card for 🖼 and pick any image from the group (restore to automatic at any time). You can also search Danbooru and download a cover online, including batch fetching in the background. Without a custom cover, the app avoids images hidden by safety mode, and the 🛡 toggle refreshes every list. When images are deleted or moved, scan-folder covers heal themselves instead of going blank.
- **Batch selection**: hover a card on the board, tag image pages or scan page for a checkbox; long-press also enters selection mode. Ctrl+click, Shift range select, Ctrl+A, Delete and Esc all work, with a floating action bar centered at the bottom.
- **Multiple replace-rule sets**: one set per export purpose (quality words for ComfyUI, a cleaned version for upload sites, character sheets…), chosen from a dropdown at export time. Your existing set automatically becomes the “default group”, so nothing changes. Rules accept the community `(tag:1.2)` syntax with an adjustable weight badge.
- **Selectable inference models**: choose `auto / v0.9 / v1.0` in settings; v1.0 also offers 336 and 672 fast modes. Images without character or series tags can be re-tagged on their own — only additions, existing tags untouched.
- **Small things**: right-click to copy an image or open it with another program (managed in settings), favorites with notes, auto-export with countdown and presets, 8 sort orders, a splash screen with a cold-start fallback, and everything runs locally — nothing is uploaded.

---

## Quick start

**Option 1: installer (recommended for users)** — download the latest from [Gitee Releases](https://gitee.com/klanf/tag-viewer/releases) (GitHub Releases are not enabled yet; the [GitHub repo](https://github.com/klanf/tag-viewer) is the source mirror):

- **Bootstrap installer** (`TagViewer-引导安装器-vX.Y.Z.exe`, under 1 MB): double-click and it assembles the package from the Release automatically — no 110 MB manual download;
- or download the full installer `TagViewer-Setup-x.y.z.exe`.

Ready out of the box. The 16,558 translations and human-curated categories are bundled, as is the WD14 tag vocabulary CSV. **The only download on first inference is the runtime** (Python + ONNX models, ~1.4 GB, resumable, with a progress card in the bottom right). After that, inference is fully local and offline.

**Option 2: portable distribution (unzip and run)** — unzip and double-click `启动看板.bat` (or `启动看板.vbs` for no console window). Nothing to install. Built with `npm run pack:green`; see the header of `scripts/pack-green.mjs`.

**Option 3: run from source** — double-click a launch script:

```bat
双击「启动看板.bat」          :: or 启动看板.vbs (no console window)
```

On a machine that has never run this project before:

```bat
npm install        :: reuses an existing local Electron runtime via hard links instead of downloading 100+ MB
npm run build      :: builds the frontend into dist/
npm start          :: starts (same as the launch scripts)
```

> The “reuse an existing runtime” step in `npm install` is driven by `scripts/local-config.mjs`, which probes candidate directories. If none is found it falls back to the official download. You can also write your own `local.config.json` (template: `local.config.example.json`) with local paths; that file is git-ignored.

---

## Paths and data directory

### Data directory

| Priority | Source | Notes |
| --- | --- | --- |
| 1 | `dataDir` in `settings.json` | The real settings file is `<userData>/settings.json` (Windows: `%APPDATA%\TagViewer\`) |
| 2 | `TV_DATA_DIR` environment variable | Handy for scripts and switching between data sets |
| 3 | **`data/` next to the app** (portable) | Used when it exists and is writable — **portable builds carry their data** (delete the folder to uninstall); the dev checkout hits this too. Only enabled by main.js (`allowPortable`); CLI tools and tests are unaffected. Packaged (inside asar) probing fails and falls back |
| 4 | `<userData>/data` | Default when none of the above exists; always writable |

Contents are classified by “can this be distributed publicly?” (see `KNOWLEDGE_FILES` / `USER_FILES` / `DERIVED_FILES` in `paths.js`):

| Category | Files | Distributed with the repo? |
| --- | --- | --- |
| **Knowledge** | `local_translations.json`, `character_library.json`; **translations and categories are built in**: at build time `scripts/build-translations-db.py` merges the source data from `knowledge/weilin_data(...)` into `assets/translations.db` (16,558 translations + 3,457 categories), shipped with the app | Translation/category source data ships with the repo (see `knowledge/README.md` for provenance and licensing status). The other two files are your own additions/mappings and are not committed |
| **User data** | `export_blacklist.txt`, `user/replace_sets.json` (**replace-rule sets**), `export_bg.txt`, `user_meta.json`, `user/user_covers.json` (custom cover table — values are **absolute local image paths**, hence its own file), `cart_history.json`, `folders.json`, `safety_tags.txt` (sensitive tag sets for safety mode, two sections), `safety.json` (toggles and level), `.thumb_cache/` | **Never leaves the machine** |
| **Regenerable derivatives** | `tags.db`, `scan_cache.json` | Not committed. Both embed local file paths; distributing them would require extracting a pure tag/series/character subset first |

The data directory is created automatically. If it contains no tag data, the app does not crash — it shows a one-click “no image folder registered yet” onboarding that lets you register a folder on the spot (see `TvBootOverlay`).

---

## Common commands

| Command | What it does |
| --- | --- |
| `npm start` | Start the built version |
| `npm run dev` | Vite dev server + Electron hot reload (no rebuild needed for frontend changes) |
| `npm run check` / `npm run build` | Static preflight / preflight + build |
| `npm run smoke` | 30-second smoke test: launches an instance and reports the landing view and any JS errors |
| `npm run e2e` | Full end-to-end assertions (see “Verification” in the dev handbook) |
| `npm run db:info` / `db:verify` | Inspect the tag DB / compare it line by line with the txt files |
| `npm run data:backup` | Make a dated backup of `tags.db` |
| `npm run pack:green` | Build a portable distribution (unzip and double-click) |

> Dozens of other commands (`db:import` / `txt:archive` / `test:*` / `backfill:dims` / `prune:dist` …) and their details are in the command table of [docs/开发手册.md](docs/开发手册.md).

---

## Known gaps / possible next steps

| Area | Current state |
| --- | --- |
| Packaging | Three forms: **NSIS installer** (`npm run dist`, the primary Gitee Release, with split parts + bootstrap installer) and **portable distributions** in three variants: **click-and-run** (default, models + runtime included), **basic** (`--variant basic`, no 1.27 GB models), **lite** (`--variant lite`, no models or Python runtime, ~370 MB, for people who bring their own environment) |
| Data directory switching | `electron/core/workspace.js` supports `TV_DATA_DIR`; there is no UI entry yet |
| Folder list sorting | Images on the scan page have 8 sort orders; the top-level folder list is ordered by last scan (missing folders sink), with no manual sorting yet |
| Lightbox zoom | After Ctrl+wheel zoom-in you can only see the center region; drag-to-pan is not implemented |
| Duplicate permanent ignore | Only a bulk “restore all”; ignored groups are not listed individually |
| In-place tag levels | Work on the board / series / scan / tag pages only; favorites and cart still use the standalone tag page |
