<div align="center">

# TagViewer

### A local prompt factory for AI image generation

Turn a pile of loose PNGs into prompt assets you can search, correct and reuse.

`v2.3.1` · Windows x64 · Electron + Vue 3 · MIT · local-first, offline by default

[中文](README.md) · [📦 Downloads](https://gitee.com/klanf/tag-viewer/releases) · [🎬 2-minute walkthrough](https://www.bilibili.com/video/BV19ZaD67EMs/) · [🚀 Getting started (Chinese)](docs/新手上手.md) · [🛠️ Dev manual (Chinese)](docs/开发手册.md)

</div>

Several features here are things I use all the time:

1. **Banning tags while I browse.** Everyone knows a filtered view can export prompts, but that export has a drawback: it also drags along the various colour words the image came with (e.g. a character who always comes out with red hair). So there is a blacklist that filters those colour words out — but the number of tags is huge, so I added a tag page that lets you ban specific tags on the spot while looking at images. That is what adds randomness back into the generations (in ComfyUI I have a node that loads a txt file and reads a random line).
2. **Duplicate detection.** If you have a lot of alternate versions of the same image on hand, you know why this matters. It detects duplicates by tags, which works better than the hash-based approaches.
3. **Replace rules.** If you also want to append specific prompts (say cat ears, cat tails and all kinds of odd extras on every character), use replace rules — they let you add whatever you want after a given prompt.
4. **The character cart.** On the series page you can add the characters you want to generate into the cart and export them to a txt file in one click; paired with ComfyUI's "load txt, read a random line" node, that gives you random generations of different characters × different prompts.

## Contents

- [What it is](#what-it-is)
- [See it first](#see-it-first)
- [The main loop](#the-main-loop)
- [Four core flows](#four-core-flows)
- [The export pipeline: 10 ordered steps](#the-export-pipeline-10-ordered-steps)
- [Feature map](#feature-map)
- [Pages and routes](#pages-and-routes)
- [Data, privacy and network boundaries](#data-privacy-and-network-boundaries)
- [Quick start](#quick-start)
- [Common settings](#common-settings)
- [FAQ](#faq)
- [Known gaps](#known-gaps)
- [Development and verification](#development-and-verification)
- [License](#license)

> 📦 [Gitee Releases](https://gitee.com/klanf/tag-viewer/releases) carries the installer and the portable builds;
> the [GitHub repo](https://github.com/klanf/tag-viewer) is the source mirror, GitHub Releases are not enabled yet.

---

## What it is

**One sentence: it sits between your image library and your generator — it is not another image viewer.**

It turns a pile of loose PNGs into prompt assets you can search, correct and reuse:

```text
local image library  →  tag database (searchable, correctable)  →  prompt store (composable, auto-exported)  →  ComfyUI
```

It solves four problems:

| Need | Without it | What it does |
| --- | --- | --- |
| **Find images** | Tens of thousands of files, only folders and eyeballs | Tag search in English or Chinese; drill down by character / series / category |
| **Ingest** | Downloaded images have no prompt, so they are dead files | Parse embedded ComfyUI metadata, or run WD14 inference as a fallback |
| **Curate** | Duplicates, misattributed characters, wrong series, messy covers | Duplicate detection, character correction, category management, custom covers, safety filtering |
| **Feed downstream** | Manually assembling and exporting prompts every time | Character cart, attached tags, saved lists, auto-export, replace rules, blacklist |

**Who it is for**: anime-focused creators running ComfyUI / SD / Anima locally with a library of thousands to tens of thousands of images; plus people who genuinely enjoy archiving, deduplicating and fixing tags.

**Who it is not for**: people who just want a fast image viewer (IrfanView / Honeyview are lighter); teams needing cloud sync or multi-user collaboration (this is a single-user local tool); people who don't care about tags at all.

---

## See it first

> All 13 shots below were taken on v2.3.1 against a **sandbox copy of a real library**
> (the capture script never touches the live database), with the 🛡 safety filter on its
> strictest `edge` level and every local path washed to `图库/…` before the shutter fired.
> Character covers in the series / characters / cart shots are blurred at capture time: the
> safety filter only covers the display layer, while covers were auto-picked and stored in the
> library long ago. That blur is a screenshot effect only — inside the app the covers render
> normally, and the "Covers" section below shows how to swap them.
> The UI itself is Chinese-only; the captions below say what each screen is for.

<table>
  <tr>
    <td align="center" width="50%"><b>Board: source chips + 🛡 safety filter + true-ratio infinite grid</b><br/><img src="docs/images/home.jpg" width="100%" alt="Board" /></td>
    <td align="center" width="50%"><b>Click a tag → image wall stacked in place (no page change)</b><br/><img src="docs/images/taggrid.jpg" width="100%" alt="Tag wall" /></td>
  </tr>
  <tr>
    <td align="center"><b>Tag index: EN + ZH gloss with hit counts — ban while you browse</b><br/><img src="docs/images/tags.jpg" width="100%" alt="Tags" /></td>
    <td align="center"><b>Lightbox: bilingual tags, blacklist hits, per-tag copy / cart / ban</b><br/><img src="docs/images/lightbox.jpg" width="100%" alt="Lightbox" /></td>
  </tr>
  <tr>
    <td align="center"><b>Series wall: work cards with character and image counts</b><br/><img src="docs/images/series.jpg" width="100%" alt="Series" /></td>
    <td align="center"><b>Inside a work → its characters, each card with a 🛒 button</b><br/><img src="docs/images/chars.jpg" width="100%" alt="Characters" /></td>
  </tr>
  <tr>
    <td align="center"><b>Character cart: grouped by series, extra tags, one-click txt export</b><br/><img src="docs/images/cart.jpg" width="100%" alt="Cart" /></td>
    <td align="center"><b>Tag-based dedupe: duplicate group + why this copy is kept</b><br/><img src="docs/images/dup.jpg" width="100%" alt="Dedupe" /></td>
  </tr>
  <tr>
    <td align="center"><b>Export presets: a saved filter snapshot + target folder + auto export</b><br/><img src="docs/images/presets.jpg" width="100%" alt="Presets" /></td>
    <td align="center"><b>Replace-rule builder: the first line of each card is the export preview</b><br/><img src="docs/images/rules.jpg" width="100%" alt="Rules" /></td>
  </tr>
  <tr>
    <td align="center"><b>Settings drawer: inference env, cover API key, external programs</b><br/><img src="docs/images/settings.jpg" width="100%" alt="Settings" /></td>
    <td align="center"><b>Source manager: one folder, two switches — library source vs. browse-only</b><br/><img src="docs/images/sources.jpg" width="100%" alt="Sources" /></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><b>Scan page: two-level folder browser; a safety-hidden cover becomes a shield placeholder, never a white block</b><br/><img src="docs/images/scan.jpg" width="100%" alt="Scan" /></td>
  </tr>
</table>

---

## The main loop

```text
①  Local image folders
       │   scan + ingest: read embedded metadata, or run WD14 inference
       ▼
②  tags.db ── tags · characters · series · favorites · rules
       │   Board / Series / Tags drill-down → lightbox
       ▼
③  Character cart ── teams + attached tags + saved lists
       │   export pipeline (10 steps, fixed order)
       ▼
④  ComfyUI wildcard ──▶ roll new images ──▶ they feed back into ①
```

That return arrow is the point: **generate new images → ingest them → the tag library grows → the next export has more to choose from**. The same tag set rolled ten times yields ten different images; pick the one you like, run inference on it, and you get an "evolved" tag set.

---

## Four core flows

### 1. Ingest: how images become searchable tags

```text
Add a source (recursive · board · scan flags)
   ↓  streaming scan: usable as soon as the first batch lands, cancellable, progress in the header
Does the PNG carry prompt / workflow metadata?
   ├─ yes → parse the original prompt (images you generated, zero error)
   └─ no  → WD14 inference (images you collected)
   ↓
Write to tags.db
   ↓  missing character / series? → orphan re-tag: appends only, never touches existing tags
Build series / character index
   ↓
Automatic cover pick (safety-aware + closest to a true 3:4 portrait)
```

- **Metadata first, inference second**: images you generated carry their original words — read them directly. Only collected images go through inference.
- **Orphan re-tag only appends character / series**: existing tags are never overwritten.
- **Covers heal themselves**: when an image in a scan folder is deleted or moved, the cover is re-picked instead of going blank.

<table>
  <tr>
    <td align="center" width="50%"><b>Scan page: the registered folder library, two levels deep</b><br/><img src="docs/images/scan.jpg" width="100%" alt="Scan" /></td>
    <td align="center" width="50%"><b>Source manager: source / scan switches, image count, one-click re-tag</b><br/><img src="docs/images/sources.jpg" width="100%" alt="Sources" /></td>
  </tr>
</table>

### 2. Finding images: locating one in tens of thousands

```text
Top tab "Tags" → list (search · favorites only · hide banned · safety · source|scan scope)
   ↓  click a tag
In-place level: tag image grid — no route change, the top tabs stay put
   ↓  click an image
Lightbox: paging / zoom / dual tag sources / filtered copy / add to cart / ban
   ├─ character·series pill → stacks another level: that series' character list
   ├─ "in-library hits" badge → stacks another level: the closest matches library-wide
   └─ leftmost path-bar arrow → pops one level and restores the exact lightbox
```

- **In-place levels, no route change**: clicking a tag on the board / series / scan / tag page stacks a level on top; the top tabs stay put and each level remembers its own filters and selection.
- **Back without restarting**: the path bar's left arrow pops one level and restores the image you were looking at.
- **The lightbox is the workbench**: paging, zoom, dual tag sources, filtered copy, per-tag cart/ban, character pills, in-library hits.
- **In-library hits**: strips character and camera tags, scores the library with IDF-weighted Jaccard, and finds the same composition or outfit.

<table>
  <tr>
    <td align="center" width="50%"><b>Tag index: bilingual pills with hit counts, "hide banned" on by default</b><br/><img src="docs/images/tags.jpg" width="100%" alt="Tags" /></td>
    <td align="center" width="50%"><b>The wall stacked in place after clicking a tag — narrow it by source too</b><br/><img src="docs/images/taggrid.jpg" width="100%" alt="Tag wall" /></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><b>Lightbox: ban, add to cart and filtered copy all happen on the image itself</b><br/><img src="docs/images/lightbox.jpg" width="100%" alt="Lightbox" /></td>
  </tr>
</table>

### 3. Teams and export: how characters become wildcards

```text
Four entries: character card 🛒 ┆ tag pill 🛒 ┆ lightbox ┆ image detail
   ↓
Cart (a global drawer, openable from any view)
   ↓  attached tags · cover swap · thumbnail healing
Four exits: ⬇ export txt ┆ 📋 copy ┆ save as a list ┆ auto-export
   ↓  export txt and auto-export share one pipeline
10-step export pipeline → chunked write + atomic rename → ComfyUI wildcard
```

- **Attached tags must share the line**: adding `closed_eyes` to a character exports as `columbina \(genshin impact\), closed eyes`, never on a separate line — otherwise the wildcard can draw "closed eyes with no character".
- **A list is a saved team**: store a finished combination and reload it later instead of adding everyone again.
- **Two auto-export paths**: board presets follow changes to the blacklist; the cart auto-export follows the cart's content fingerprint. Both debounce, so ten edits in a row produce one export.
- **Clearing the cart never triggers an export**: otherwise the common "export → save list → auto-clear" flow would wipe the downstream file.

<table>
  <tr>
    <td align="center" width="50%"><b>Character page inside a series: favorite on the card, ban under "..."</b><br/><img src="docs/images/chars.jpg" width="100%" alt="Characters" /></td>
    <td align="center" width="50%"><b>Cart: grouped by series, attached tags, save as a list</b><br/><img src="docs/images/cart.jpg" width="100%" alt="Cart" /></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><b>Export preset: freeze a filter set and pair it with auto export</b><br/><img src="docs/images/presets.jpg" width="100%" alt="Presets" /></td>
  </tr>
</table>

### 4. Curating: getting the library clean

```text
Whole library
   ↓  rare-tag inverted index (df ≤ 50, at least 3 rare tags co-occurring)
IDF-weighted Jaccard scoring
   ↓  group by threshold (0.85 by default, 0.65–0.95; union-find, max 2000 groups)
Keep-rule ranking (artist / created time / size / resolution / metadata / filename)
   ↓  human review
delete the rest ┆ mark not-a-duplicate ┆ delete record (permanent ignore: records only, images untouched)
```

- **Deduplication is explainable**: each group shows why one image is suggested as the keeper; false positives can be permanently ignored (records only, images untouched) and restored in bulk.
- **Characters can be corrected**: display name, series, hidden — stored in the user layer, overriding automatic recognition without touching the image's tags.
- **Categories are yours**: series assignment, custom categories, extra characters, hidden categories and hidden characters, all in one four-tab dialog.
- **Tags themselves are editable**: rename replaces a comma token across the library without touching longer tags containing it; delete can be scoped by a second tag. Preview the hit count first; `tags.db` is backed up before the transaction.

<table>
  <tr>
    <td align="center" width="50%"><b>Duplicate panel: a group of variants side by side + the ignore tab</b><br/><img src="docs/images/dup.jpg" width="100%" alt="Dedupe" /></td>
    <td align="center" width="50%"><b>Replace rules: several rule sets on the left, a live tester at the bottom</b><br/><img src="docs/images/rules.jpg" width="100%" alt="Rules" /></td>
  </tr>
</table>

---

## The export pipeline: 10 ordered steps

```text
① strip char·series → ② strip view·camera → ③ safe tags only → ④ blacklist   → ⑤ replace rules
⑥ weighted dedupe   → ⑦ fill background  → ⑧ segment reorder → ⑨ underscores→spaces → ⑩ include path
```

| Step | What | Why here |
| --- | --- | --- |
| ① | Strip character / series tags | The wildcard line already carries the character |
| ② | Strip view / camera tags | `from behind`, `high angle` often fight the composition |
| ③ | Keep safe tags only | Per-tag removal under core / edge / follow-global; rows are preserved |
| ④ | Blacklist | Exact / prefix / suffix / contains / whole-segment `@x@` |
| ⑤ | Replace rules | Rules can add tags, so they must run after the blacklist and before dedupe |
| ⑥ | Weighted dedupe | `(tag:1.2)` is deduped by bare word, so the same tag never appears twice |
| ⑦ | Fill missing background | Only appends when background is actually absent |
| ⑧ | Segment reorder | Artist / character / series / meta / general grouped for random injection |
| ⑨ | Underscores → spaces | Conventional prompt format; CJK punctuation is untouched |
| ⑩ | Include the image path | Optional, for downstream provenance |

**Writing**: yields to the event loop every 1000 rows, writes a temp file and renames atomically — downstream never reads a half-written file.

---

## Feature map

Twelve domains. Everything listed exists in the current code; the parenthetical notes the non-obvious constraint.

### 1. Startup · shell · navigation

- Single-instance lock: a second launch just focuses the existing window.
- Four-level data directory resolution: `settings.json` → `TV_DATA_DIR` → `data/` next to the app (portable builds carry their data) → `%APPDATA%/TagViewer/data`.
- Startup fallback: an empty or unreadable data directory opens a one-click onboarding (register a folder on the spot) instead of a blank screen.
- Six top tabs: Board / Series / Tags / Scan / Favorites / Cart.
- Four secondary routes: sources, image detail, in-library hits, tag image grid.
- Path bar breadcrumbs: every level copies its full path; the left arrow goes up one level.
- Back arrow in the header: only when there is no path bar and the page is not a root.
- In-place level stack: tag grids / series characters / in-library hits without a route change.
- Lightbox return memory: `rememberJump` / `takeJump` restore the exact image.
- `smartBack` returns by origin instead of hardcoding home.
- Seven themes (eye-friendly green, light, paper, peach, lavender, dark, deep ocean), dark by default and persisted.
- Dataset stats strip: images / tags / characters / series / size.
- Floating nav keys: back to top / cart / random, vertical on the right.
- Fourteen push channels: scan, inference, export and cart auto-export progress in one place.
- Global singletons: settings, rules editor, safety mode, trash confirmation, toasts.

### 2. Board

<p align="center"><img src="docs/images/home.jpg" width="660" alt="Board" /><br/><sub>Source chips with per-folder image counts · 🛡 safety filter · true-ratio infinite grid</sub></p>

- Multi-word pill search: comma freezes the current word into a pill; "select all" adds every tag matching the current word.
- Combine mode `any / all`, match mode `contains / exact`.
- Deep links carry filters from tag pages / duplicates / series pages.
- Filename filter, multi-select source chips with per-source counts, frequent-tag and frequent-series side panels.
- ComfyUI-only view: determined from embedded metadata, not filenames.
- Safety filtering; when a page empties out you can manually pull the next batch.
- Selection mode: checkbox, select current batch, invert; Ctrl+click, Shift range, Ctrl+A, Delete, Esc.
- Bulk: favorite / unfavorite, add to cart, move, copy, delete (via Recycle Bin).
- Infinite justified-rows grid with true pixel ratios — wide images are no longer cropped into strips.
- Ctrl+wheel zoom 0.45×–2.25×, remembered; a percentage badge fades out and resets on click.
- 🎲 Shuffle; split export button (tags only / with paths).
- Strip view tags, apply replace rules (choose a rule set), export presets, 🔎 duplicates.
- Image card: source badge, similarity badge, favorite, missing state, last-viewed breathing frame, 500ms long-press to select, native context menu.

### 3. Lightbox

<p align="center"><img src="docs/images/lightbox.jpg" width="660" alt="Lightbox" /><br/><sub>Bilingual tags, blacklist hits called out, and per-tag copy / cart / ban right on the image</sub></p>

- Keyboard: Esc, ←→, PgUp/PgDn, Del, 1–9 to move files.
- Wheel paging with a 55px threshold and 190ms debounce.
- Ctrl+wheel zoom 0.25×–6×, double-click resets.
- Dual tag sources: library tags / original embedded metadata; embedded words are matched against the library first.
- Category grouping, matched / unmatched pills, in-library hits badge.
- Character / series pills; a series pill stacks that series' character list in place.
- The copy button carries a filter panel (choices are remembered): drop banned tags / drop character·series / drop view·camera / apply replace rules (choose a set) / safe tags only (follow / core / edge) — the same primitives the export pipeline uses.
- Per-tag copy / add to cart / ban; toggle banned tags.
- Favorite, background-fill preview, path copy, reveal in Explorer, quick-move bar.
- Controls auto-hide; missing files show a prompt and can be relocated.
- 4 concurrent thumbnails, 2 concurrent originals, retry with progressive fallback.

### 4. Series

<p align="center"><img src="docs/images/series.jpg" width="660" alt="Series" /><br/><sub>The work wall: category tabs, EN/ZH search, and per-card character and image counts (covers blurred here — see the note above)</sub></p>

- Three levels — series → character → images — all in place.
- Category tabs: game / anime / VTuber / other, plus custom categories; hidden categories are not shown but data stays.
- Series search in English or Chinese; a "characters without images" view.
- Four-tab category manager: series assignment, extra characters, hidden categories, hidden characters (restorable).
- Custom categories can be added or deleted; deleting one returns its series to "other".
- Character card: 🛒 add to cart, ✏️ correct (display name / move series / hide), 🖼 cover, ban confirmation.
- Custom cover, local tab: candidates follow the current source filter and show only safe images when safety mode is on; the current cover is marked.
- Custom cover, web tab: Danbooru / Safebooru with rating g/s/all, solo-only and paging.
- Web picks download the site's display size into `data/char_covers/user_picks/` — **they never enter the tag library**.
- Restore automatic picking; the automatic rule is "safety-aware + closest to 3:4 portrait".
- Character sorting / multi-select / bulk favorite and cart; series cover batch panel; image-level bulk actions inside a series.

### 5. Tags

<p align="center"><img src="docs/images/tags.jpg" width="660" alt="Tags" /><br/><sub>Tag index: bilingual pills with hit counts; clicking one stacks an image wall on the same page</sub></p>

- Infinite tag list with English and Chinese search.
- Hide banned tags (on by default, remembered), favorites-only, safety filter, source | scan scope.
- Tag grid `/tags/:tag`: in-place, sorted by path / newest / random, page size 60 / 120 / 240.
- Bulk select, move, copy and favorite inside the grid.
- Rename: exact comma-token replacement across the library; syncs the tag table, translations and character library; a `xxx_(series)` name is re-detected as a character.
- Delete: whole library, or scoped by a second tag so only images containing both are affected.
- Preview the hit count first; `tags.db` is backed up and written in a transaction.

### 6. Scan · sources

<p align="center"><img src="docs/images/sources.jpg" width="660" alt="Sources" /><br/><sub>Source manager: the same folder can be a library source, a browse-only scan folder, or both</sub></p>

- Add folders as sources: recursive / board / scan flags.
- Streaming scan with a live progress line; cancellable.
- Eight sort orders: name↑↓ / folder / time↑↓ / size↑↓ / tag count.
- Windowed pagination renders only the current page; folder-level and image-level browsing.
- Filter history, safety counts, rescan.
- In-source tag page without leaving the scan view.
- Move / copy dialogs, show removed, refresh, reload board.
- Orphan re-tag: appends character / series only, never touches existing tags.
- The registry lives in `tags.db`; it can additionally be exported as a backup to `user/folders.json`.
- Source row actions: rename, ⟳ sync, ⚡ retag, remove, restore, purge (with confirmation), ♻️ reload the board.
- Scan-folder covers heal when images are deleted or moved.
- Missing-file relocation; deletion goes through the Recycle Bin.

### 7. Favorites

- Tag filter, safety filter, grid + lightbox, one-click unfavorite, missing-file relocation.

### 8. Cart · lists

<p align="center"><img src="docs/images/cart.jpg" width="660" alt="Cart" /><br/><sub>Cart: grouped by series, attached tags, save as a named list (covers blurred here)</sub></p>

- Global drawer from any view, plus a standalone cart page.
- Grouped by series, then by character name; four entry points: character card / tag pill / lightbox / detail page.
- Thumbnail healing: rotate through candidates on failure, swap landscape for the closest 3:4 portrait, pick a cover for empty entries.
- Safety-mode thumbnail swaps are display-only and never written back.
- Chinese name fallback: the cart may store an English short name, so the translation is looked up on display.
- Attached tags are appended on the same exported line, with a live preview.
- Cover swap reuses the cover picker and updates the series card too; restoring automatic picking re-heals the thumbnail.
- Remove one / clear all (with confirmation).
- ⬇ Export wildcard txt, 📋 copy the whole cart to the clipboard.
- 💾 Save as a list: name (defaults to a timestamp), optional export, optional clear afterwards.
- 📁 My lists: load / rename / delete / mark the active one.
- ⚙ Auto-export: toggle, status, directory, filename, delay, run now, skip wait, last result.
- Status badge: green = synced, amber = pending, with an mm:ss countdown.
- Clearing the cart never triggers an export.

### 9. Export pipeline · presets

<p align="center"><img src="docs/images/presets.jpg" width="660" alt="Presets" /><br/><sub>Export preset: a saved filter snapshot plus target folder and auto export</sub></p>

- Entry points: board export, export presets, cart, lists. The lightbox's "copy tags" reuses the same filter primitives (view / safety / replace rules) but only writes to the clipboard, never a file.
- Filter snapshot: multi-source, search terms, combine/match mode, exclusions, exclusion-matches-parenthesized.
- The 10 ordered steps above; optional rule set, safety scope (follow / core / edge), include paths.
- Chunked writes (1000 rows), temp file + atomic rename, illegal filename replacement, 60-character truncation.
- A preset = filter snapshot + target directory / filename + auto flag.
- Directory priority: global default > last picked > data directory; the last eight are offered.
- Global ban delay: 1.5s / 30s / 60s / 180s (default) / 300s / 600s.
- Auto-export only fires when the blacklist actually changes, merging edits during the wait; click the pending badge on the board to skip the wait.

### 10. Rules · safety · categories

<p align="center"><img src="docs/images/rules.jpg" width="660" alt="Rules" /><br/><sub>Replace-rule builder: the first line of each card is what that rule exports; rule sets are managed on the left</sub></p>

- Blacklist syntax: exact `red_hair`, prefix `blue_*`, suffix `*_hair`, contains `*color*`, whole segment `@boy@`, `#` comments.
- Multiple replace-rule sets: new / rename / copy / set default / delete (with an inline confirmation, no native dialog).
- Builder: each rule is a two-row card; the first row is a live **export preview**, the second row holds the three-state source tag plus replacements.
- Source tag states: discard / keep (with an optional suffix such as `_art`) / delete the tag.
- Source tags can be merged into one card sharing the same replacements.
- Replacement suggestions include Chinese names and image counts; supports `(tag:1.2)` with a weight bubble, 0.1–2.0 in 0.1 steps, 1.0 unwrapped automatically.
- Group notes (`#` lines, written before/after the rules on save), a syntax help popover, and a live test bar that runs through the backend — the same engine as export, but against **saved** rules.
- Raw mode for bulk paste, special characters and unparseable lines.
- Saving does not close the dialog; changes apply immediately; the default set is used when no set is chosen.
- Safety mode: off by default; safe / unsafe inversion; core / edge levels; whole-library hit count; tag add/remove and raw text editing with `*` wildcards.
- Category manager: series assignment / extra characters / hidden categories / hidden characters.

### 11. Duplicates · in-library hits

<p align="center"><img src="docs/images/dup.jpg" width="660" alt="Dedupe" /><br/><sub>Duplicate panel: variants side by side, and the ★ cell explains which copy to keep</sub></p>

- Duplicates entry in the board action bar; rare-tag inverted index (df≤50, co-occurrence≥3) + IDF-weighted Jaccard.
- Seven thresholds 0.65–0.95 (default 0.85); union-find grouping, capped at 2000 groups.
- Keep rules: artist / creation time / file size / resolution / embedded metadata / filename hints; folder priority is drag-sortable.
- Similar groups / ignored tabs; 12 groups per page auto-loading, back-to-top.
- Per group: not a duplicate / delete the rest / restore this group / delete record (permanent ignore); ★ shows the keep reason with rank badges.
- Bulk restore for permanent ignores; zoom 120–900px; cross-group lightbox that returns to the group you left.
- In-library hits: strips character / camera tags, threshold 0.4 (0.2–0.6), relaxes to 0.2 on zero hits, 8-entry cache.
- Results show similarity %, source | scan scope, infinite 60; bulk add to cart / favorite / move.

### 12. Inference · settings · data · packaging

<p align="center"><img src="docs/images/settings.jpg" width="660" alt="Settings" /><br/><sub>The settings drawer: inference environment, online-cover API key (mask only), external program list — long explanations live inside ⓘ bubbles</sub></p>

- Inference presets: `auto` / v0.9 / v1.0 / v1.0-336 / v1.0-672.
- v0.9: 13,461 tags at 448px (default, stable); v1.0: 30,877 tags at 1008px (~2.3× the character vocabulary, clearly slower on CPU / DirectML).
- v1.0-336: 336px fine-tune, measured ~0.17s/image on DirectML (~5.8s on CPU), slightly lower character recall than 1008; v1.0-672: ~0.26s/image on CUDA but ~14s on DirectML, so it is only recommended on NVIDIA cards.
- Thresholds: general 0.35 / character 0.85; backend auto-selects CUDA > DirectML > CPU.
- The runtime is a ~1.4GB download on first use, resumable, with a progress card.
- Settings · inference: backend / onnxruntime / model / provider / thresholds / Python.
- Settings · online covers: Danbooru status, masked API key, save / test / clear.
- Settings · external programs: the candidate list for "open with another program".
- Settings · general: grouped tags, version, update.
- Built-in data: 16,558 translations, 3,457 categories, the 13,461-row WD14 vocabulary.
- Data routing K / U / R / D: knowledge, user, rules, derived — never mixed.
- Security boundary: the API key lives only in the main process (`booru_auth.json`); the renderer sees a mask.
- IPC: 127 whitelisted channels and 14 push channels, wrapped in `safe()`, with `gated()` on data channels.
- Packaging: NSIS installer + 90MiB parts + bootstrap installer; portable builds in full / basic / lite.
- Updates: a Gitee split-part updater.
- Verification: 6 pre-build guard checks (import paths / named exports / IPC whitelist / launcher encoding / undefined template bindings / drive-letter paths), real Electron + CDP e2e (currently 442 assertions green), 20 `test:*` scripts, a 30-second smoke test.

---

## Pages and routes

| Page | Purpose | Entry |
| --- | --- | --- |
| Board (Home) | Library search, source filters, bulk actions, duplicates | Default view |
| Series | Work → character → images, corrections, covers | Top tab |
| Tags | Tag table, ban, favorites, tag grids | Top tab / lightbox |
| Scan | Folder library, sorting, archive moves, in-source tags | Top tab |
| Favorites | Quick return to starred images | Top tab |
| Cart | Character teams, lists, auto-export | Top tab / drawer |
| Sources `/sources` | Register / remove / purge, orphan re-tag | Scan page |
| Image detail `/detail` | Full tag view for one image | Context menu / lightbox |
| In-library hits `/meta-hits` | Same-composition search | Lightbox badge |
| Tag grid `/tags/:tag` | Direct link to any tag | Deep link / series pill |

---

## Data, privacy and network boundaries

### Data directory

| Priority | Source | Notes |
| --- | --- | --- |
| 1 | `dataDir` in `settings.json` | The real settings file is `<userData>/settings.json` (Windows: `%APPDATA%\TagViewer\`) |
| 2 | `TV_DATA_DIR` environment variable | Handy for scripts and switching data sets |
| 3 | **`data/` next to the app** (portable) | Used when it exists and is writable — portable builds carry their data (delete the folder to uninstall); the dev checkout hits this too |
| 4 | `<userData>/data` | Default when none of the above exists; always writable |

### Four data layers

| Layer | Contents | Leaves the machine? |
| --- | --- | --- |
| **K Knowledge** | 16,558 translations, 3,457 categories and the WD14 vocabulary (shipped); character / series derivation rules; your own translations / character mappings | Shipped parts come with the build; your additions stay on the machine |
| **U User** | `user_meta.json`, `user/user_covers.json`, lists, export presets, corrections, safety toggles | **Never** |
| **R Rules** | Blacklist, replace-rule sets, safety tag sets, duplicate ignore table | **Never** |
| **D Derived** | `tags.db`, scan cache, thumbnails, inference results | Not committed; embeds local paths |

### Network behavior

- **Offline by default**. Only three actions go online: downloading the inference runtime, testing the Danbooru key in settings, and clicking "pick online" for a cover.
- Danbooru / Safebooru are queried only when you search; a picked image is downloaded into the local cover directory and **never enters the tag library**.
- The API key stays in the main process; the renderer receives a mask, never the plaintext.
- Deletion goes to the Recycle Bin; removing a source only unregisters it; purging deletes records.

---

## Quick start

### Three ways to install

1. **Installer (recommended)** — from [Gitee Releases](https://gitee.com/klanf/tag-viewer/releases):
   - **Bootstrap installer** (<1MB) assembles the package from the Release automatically;
   - or the full `TagViewer-Setup-x.y.z.exe`.
2. **Portable build** — unzip and double-click `启动看板.bat` (or `启动看板.vbs` for no console window). Three variants:
   **full** (models + runtime), **basic** (no 1.27GB models), **lite** (no models or Python, app only).
3. **From source**:

```bat
npm install        :: reuses an existing Electron runtime instead of downloading it again
npm run build      :: preflight + build the frontend into dist/
npm start          :: start (same as the launch scripts)
```

> Runtime reuse is handled by `scripts/local-config.mjs`; it falls back to the official download when nothing is found.
> You can also provide `local.config.json` (template: `local.config.example.json`); that file is git-ignored.

### Five steps to the first loop

1. **Register a folder**: Scan page → "🗄️ Sources" → add a directory (recursion optional).
2. **Wait for the scan**: the board fills up; images without metadata prompt you to run inference.
3. **Inference (optional)**: the first run downloads a ~1.4GB runtime, then stays local; images missing character / series tags can be re-tagged alone.
4. **Find an image**: search a tag on the board → open the lightbox → switch to "embedded metadata" to see the original words.
5. **Build and export**: click 🛒 on a character card in Series → export txt from the cart → drop it into ComfyUI.

---

## Common settings

| What | Where | Notes |
| --- | --- | --- |
| Inference model / threshold / backend | Settings → Inference | 336 for speed, v1.0 for recall |
| Danbooru API key | Settings → Online covers | Needed for server-side popularity sorting and more tags per query |
| Safety level and tag sets | 🛡 toggle / per-page switch | Off by default; the panel shows how many images would be hidden |
| Blacklist / replace rules | Board "🚫 / 🔁" entries | Multiple rule sets; choose one at export time |
| Export presets and auto-export | Board "📤 Preset export" | Presets store a filter snapshot, not a live link to the board |
| Cart auto-export | Cart drawer → "⚙ Auto-export" | 30-second delay by default, triggered by fingerprint changes |
| External programs | Settings → External programs | Candidates for "open with another program" |
| Categories and corrections | Series → category manager / character ✏️ | Custom categories, extra characters, hidden entries |

---

## FAQ

**Why does the first inference need a 1.4GB download?**
The runtime is Python + ONNX Runtime + models. It downloads once and then runs offline; it resumes after an interruption.

**Why did clearing the cart not trigger an export?**
By design. Otherwise the common "export → save list → auto-clear" flow would wipe the downstream wildcard file.

**Why does removing a source leave the images in place?**
Removing only unregisters the source. Records are deleted only by "purge".

**Why can't some tags be found in Chinese?**
The translation table has 16,558 entries; niche characters and new seasons may be missing. You can add your own; the English tag always works.

**Why did a cover turn into a blank block?**
The underlying file was deleted or moved. Scan-folder covers re-pick automatically; custom covers need a manual swap or a restore.

**Why is online cover search slow or empty?**
Those sites are intermittent from some networks. Anonymous Danbooru allows only two general tags per query and ignores server-side popularity sorting. Add an API key to lift both limits; Safebooru needs no key.

**Duplicates grouped two unrelated images — what now?**
Raise the threshold or change the keep rule. A false-positive group can be permanently ignored (records only, images untouched) and restored in bulk at the bottom.

**Does it support macOS / Linux?**
Windows x64 only for now. Path handling, thumbnails, installers and the split updater are all Windows-specific.

**Does it upload my images?**
No. Apart from the three actions listed under "Network behavior", there are no outbound requests.

---

## Known gaps

| Area | Current state |
| --- | --- |
| Platform | Windows x64 only |
| Lightbox zoom | After zooming in you can only see the center; no drag-to-pan |
| Data directory switching | `TV_DATA_DIR` works; no UI entry |
| Top-level folder list | Ordered by last scan (missing folders sink), no manual sort; images have 8 sorts |
| Duplicate permanent ignore | Only a bulk "restore all"; ignored groups are not listed individually |
| In-place tag levels | Board / series / scan / tag pages only; favorites and cart still use the standalone tag page |
| Collaboration | No accounts, no cloud sync — single user by design |
| Chinese tag coverage | 16,558 entries; niche tags still display in English |

---

## Development and verification

### Architecture

- **Main process** `electron/`: database, scanning, inference, export, covers, duplicates, IPC, the `tv://` protocol, updater.
- **Renderer** `src/`: Vue 3 `<script setup>` + Pinia + vue-router (hash).
- **Boundary**: the renderer talks to the main process only through the preload whitelist; file paths are not exposed directly; the API key never enters the renderer.
- **Shared panels**: `TagImagesPanel` / `TvSeriesCharsPanel` / `MetaHitsPanel` have one implementation with multiple hosts, so the same feature cannot drift between pages.

### Commands

| Command | What it does |
| --- | --- |
| `npm start` | Start the built version |
| `npm run dev` | Vite dev server + Electron hot reload |
| `npm run check` / `npm run build` | Static preflight / preflight + build |
| `npm run smoke` | 30-second smoke test: launches an instance, reports the landing view and any JS errors |
| `npm run e2e` | Full end-to-end assertions (real Electron over CDP) |
| `npm run selftest` | One-shot self check |
| `npm run db:info` / `db:verify` | Inspect the tag DB / compare it line by line with the txt files |
| `npm run data:backup` | Make a dated backup of `tags.db` |
| `npm run pack:green` | Build a portable distribution (`--variant basic` / `lite`) |
| `npm run dist` | Build the NSIS installer |

> Dozens of other commands (`db:import` / `txt:archive` / `test:*` / `backfill:dims` / `prune:dist` …),
> plus startup ordering, IPC contracts and pitfall notes, are in [docs/开发手册.md](docs/开发手册.md).

### How changes are verified

- `npm run check` (6 startup guards) runs before every build.
- e2e uses an isolated `.e2e-work` data copy and never touches the real library; the real `data/tags.db` is read-only.
- The current suite is 442 assertions green; new interactions must add their own.
- Frontend changes must be exercised in Electron; a passing build is not feature verification.

---

## License

MIT. Provenance and licensing status of the translation/category source data are documented in [knowledge/README.md](knowledge/README.md).

If this tool saves you time hunting images and assembling prompts, a Star on [Gitee](https://gitee.com/klanf/tag-viewer) is appreciated.
