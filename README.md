# Commissioning Logbook — pilot v0.1

A browser add-on (Chrome and Edge) that watches shuttle configuration pages, records every parameter
change, and lets the commissioning engineer group changes into **changesets** with the reason behind them.
A small simulator with guessed, simplified shuttle parameters is included so the engineer can try it
without touching a real shuttle.

```
simulator/shuttle_sim.py   simulated shuttle pages (Python 3, standard library only)
extension/                 the browser add-on (load unpacked)
```

## 1. Start the simulator

```
cd simulator
python shuttle_sim.py
```

Open http://localhost:8080. Six shuttles (SH-01 … SH-06), each with five parameter tabs.

Things built in to test the add-on:

| What the simulator does | What the logbook should show |
|---|---|
| Clamps out-of-range values (e.g. speed 2 → 1.4) | *shuttle adjusted it (shuttle shows 1.4)* |
| Pallet type, cold-store mode and RF band only apply after **Restart shuttle** | *not applied (yet)* → *confirmed* after restart |
| **Simulate RF-remote change** on the fleet page | a change in a *Changed outside this browser — why?* changeset |
| `python shuttle_sim.py set SH-01 accel 0.6` from a terminal | the same, on the next page load |
| **UI version 2** on the fleet page renames every field and changes the layout | changes keep being captured; names come from the new layout |
| Battery, position and cycles change on every load | ignored: they are text, not fields |

`python shuttle_sim.py reset` puts everything back to factory defaults.

## 2. Install the add-on

**Chrome:** go to `chrome://extensions`, switch on *Developer mode*, click *Load unpacked*, pick the `extension` folder.
**Edge:** go to `edge://extensions`, switch on *Developer mode*, click *Load unpacked*, pick the `extension` folder.

Pin the add-on and click its icon to open the sidebar. `localhost` is watched out of the box.
On a real shuttle page, click **Watch …** at the top of the sidebar (the browser asks for permission once per address).

## 3. How it behaves

**Capture.** When a watched page loads, the add-on reads every editable field (value + detected label).
When the engineer presses Save, it records what was submitted. After the page reloads, it reads the
values again and only marks a change *confirmed* when the shuttle shows the new value.

**Outside changes.** If a field shows a different value than last time and nobody saved it from this
browser, it is logged as *changed outside browser* in its own changeset that asks for a reason.
Only fields on pages the engineer has opened before can be compared.

**Where new changes go.**
- Sidebar closed, or no active changeset → each save creates a new changeset with the reason
  *why are we doing this change ?* (highlighted as *Needs a reason*).
- Sidebar open with active changesets → the most recently edited one (marked *Receives new changes*).
  Typing in a reason or clicking *Use for new changes* makes a changeset the target.
- Create a changeset first with **New changeset** to state the intent before editing.
- Any change can be moved with **Move to…**; an auto-created changeset that ends up empty is removed.

**Labels.** Detected from the page (`<label>`, ARIA, table header, preceding text), falling back to the
field name. Click a parameter name in the sidebar to correct it; the correction applies to that field everywhere.

**Shuttle ID.** Taken from the URL: the part after `/shuttle/`, else a `?shuttle=` or `?id=` parameter,
else the address (one shuttle per IP). Override with a regular expression under *Settings*.

**Read-only.** The add-on never writes to, fills in or submits the shuttle page.  The add-on makes no network requests; all data stays in the browser.

**Closing.** *Solved* or *Not solved*, with an optional result note.

**Export.** *Export all changes* = full log. *Export final values* = one row per shuttle and parameter for
changesets closed as *Solved*, ready for the central sheet. Both are semicolon-separated UTF-8 CSV, so
they open correctly in Excel with Belgian/Dutch regional settings.

**Storage.** Everything stays in the browser profile (`chrome.storage.local`). Use *Settings → Save backup* regularly.

## 4. Permissions and why

| Permission | Why |
|---|---|
| storage | keep the logbook in the browser |
| sidePanel | the sidebar |
| scripting | read fields on watched sites only |
| tabs | know which page the sidebar is next to |
| localhost, 127.0.0.1 | the simulator |
| other sites (optional) | only after the engineer clicks *Watch* for that address |

## 5. Known limits of this pilot

- Values are compared as text; a page that shows `0.50` after saving `0.5` is treated as equal, other formatting differences are not.
- Pages that save without a form post are handled by re-reading 1.5 s after a *Save/Apply/Opslaan*-like button. If that misses, use *Re-read page*.
- A field renamed in a new device UI version starts a new history (the mapping file for that is a later step).
- No sharing between engineers yet; that is the next version (shared backend, central sheet).
- Tested end-to-end in Chromium with the simulator. Edge uses the same engine, but has not been tried yet.

## 6. Suggested 15-minute trial for the engineer

1. Open SH-01, change two travel parameters (one above its maximum), save. Open the sidebar: one changeset, one change *confirmed*, one *adjusted*.
2. Type the reason. Click **New changeset**, write a second reason, change something on SH-02, save: it lands in the new one.
3. Change the pallet type on SH-03, save (*not applied*), press **Restart shuttle** (*confirmed*).
4. On the fleet page press **Simulate RF-remote change** for SH-01, then open SH-01's page that holds that parameter: an outside change appears.
5. Move a change between changesets, rename a parameter, close one changeset as *Solved*, export final values and open it in Excel.
6. Switch to UI version 2 and repeat step 1.

Then ask: would you use this on a real commissioning day? What is missing, what is in the way?
