# Background and decisions

How this project got here and why it is built the way it is. Read this together with the
[README](../README.md), which explains how to run and test it. Anyone continuing the work (a person or
an AI assistant) should be able to pick it up from these two files and the code.

## The problem

Commissioning engineers set up pallet shuttles in automated warehouses. Each shuttle has a web
configuration page, and the engineer opens it by browsing directly to the shuttle's IP address.
While solving a problem they change parameters on several shuttles, often over several days, and it
is easy to lose track of what was changed, on which shuttle, and why.

Goal: record every parameter change together with the reason for it, and once a set of changes has
solved a problem, put the final values in a central Excel sheet that all engineers can use.

## Approach

- **Browser add-on with a sidebar** (Chrome and Edge, Manifest V3). It watches the shuttle pages the
  engineer opens, records changes, and lets the engineer group them into *changesets* with a reason.
  Chosen because it works on the existing shuttle pages without changing the shuttles.
- **Read-only towards the shuttle.** The add-on never fills in, changes or submits anything on a shuttle page.
- **Local only.** All data stays in the browser profile. No network calls, no server, no outside libraries.
- **Start small.** The pilot is meant to prove the idea with one engineer. It may later grow into a
  standard tool with a shared backend.
- **Public information only.** The simulator's parameters are a simplified guess based on public
  information. The repository contains no confidential vendor information and is public.

## Decisions so far

| Decision | Why |
|---|---|
| Changes are confirmed only when the page shows the new value after reload | A save can be rejected, clamped or wait for a restart; the logbook shows what the shuttle actually has |
| Changes made outside the browser (RF remote, other tools) are detected on the next page load and get their own changeset | They must not land silently in the engineer's current work |
| Sidebar closed or no active changeset → each save starts a new changeset asking *why?*; otherwise the most recently edited changeset receives new changes | Agreed with the engineer as the least intrusive rule |
| Shuttle ID = the address, unless the URL contains an ID | Engineers browse to each shuttle's IP |
| **Customer / site scoping (v0.2)** | The same IP plan repeats at every customer, so an address is only unique within one customer / site. The engineer picks the customer / site in the sidebar; nothing is recorded until one is chosen |
| **Wrong customer / site guard (v0.2)** | If a page suddenly differs on ≥ 3 fields and ≥ half of the comparable fields, the add-on asks instead of logging a batch of false outside changes |
| CSV exports with semicolons and a UTF-8 BOM | Opens correctly in Excel with Belgian / Dutch regional settings |
| Simulator gives each shuttle its own port and has two customer / sites on the same addresses | Matches real use (one address per shuttle, addresses repeat per site) |
| Git stores LF; checkouts use the machine's native line endings (`* text=auto`) | Requested by the project owner |

## Constraints

- The engineer's laptop does not allow loading unpacked browser extensions (company policy).
  The pilot needs IT approval to install it. A local app instead of an add-on was considered as a fallback.
- The repository is public; keep it free of confidential information. Renaming the tool to drop the
  vendor name is under consideration.

## Planned next steps

1. IT review of the code and approval to run the pilot on one engineer's laptop.
2. Pilot with the engineer (README section 6), collect feedback.
3. Next iteration: read the shuttle's own name or serial from its page, so a shuttle is recognised
   regardless of address and a wrong customer / site is caught reliably.
4. Later: a mapping for fields that are renamed in a new device UI version, test on Edge,
   and sharing between engineers (shared backend, central sheet).

## Version history

- **v0.1.0**: first pilot: capture, read-back confirmation, outside changes, changesets, CSV export, simulator.
- **v0.2.0**: customer / site scoping, wrong-site guard, simulator with one address per shuttle and two customer / sites.
