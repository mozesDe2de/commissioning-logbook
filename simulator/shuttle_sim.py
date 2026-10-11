#!/usr/bin/env python3
"""
Simulated pallet-shuttle service pages, for testing the Commissioning Logbook add-on.

The parameter set is a simplified, educated guess based on public Atlas figures.

Run:      python shuttle_sim.py                 -> http://localhost:8080
Options:  python shuttle_sim.py --port 9000
Change a parameter "outside the browser" (like an RF remote or remote service would):
          python shuttle_sim.py set SH-01 accel 0.6
Reset everything to factory defaults:
          python shuttle_sim.py reset

Only uses the Python standard library (3.8+).
"""
import argparse
import html
import json
import os
import random
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(HERE, "shuttle_state.json")
LOCK = threading.Lock()

SHUTTLE_IDS = ["SH-01", "SH-02", "SH-03", "SH-04", "SH-05", "SH-06"]
FIRMWARE = "MOC-sim 4.2.7"

# ---------------------------------------------------------------------------
# Parameter catalogue (guessed + simplified)
# kind: num | int | bool | select | text
# restart: value only becomes active after "Restart shuttle"
# v2: the field name and label used by "UI version 2" (simulates a redesigned page)
# ---------------------------------------------------------------------------
TABS = [
    ("travel", "Travel"),
    ("lift", "Lift & load"),
    ("energy", "Energy"),
    ("safety", "Safety"),
    ("comms", "Comms"),
]

PARAMS = [
    # travel
    dict(key="max_speed_loaded", tab="travel", label="Max speed, loaded", unit="m/s", kind="num", default=0.8, min=0.2, max=1.4, step=0.05, v2=("P101", "Speed limit (loaded)")),
    dict(key="max_speed_empty", tab="travel", label="Max speed, empty", unit="m/s", kind="num", default=1.0, min=0.2, max=1.4, step=0.05, v2=("P102", "Speed limit (empty)")),
    dict(key="accel", tab="travel", label="Acceleration / deceleration", unit="m/s²", kind="num", default=0.5, min=0.1, max=0.8, step=0.05, v2=("P103", "Accel ramp")),
    dict(key="creep_speed", tab="travel", label="Creep / approach speed", unit="m/s", kind="num", default=0.1, min=0.02, max=0.3, step=0.01, v2=("P104", "Approach speed")),
    dict(key="pos_tolerance", tab="travel", label="Positioning tolerance", unit="mm", kind="int", default=5, min=1, max=20, step=1, v2=("P105", "Stop window")),
    # lift & load
    dict(key="pallet_type", tab="lift", label="Pallet type", unit="", kind="select", default="EURO 1200x800",
         options=["EURO 1200x800", "INDU 1200x1000", "GMA/US 1000x1200", "1200x1200", "CP1 1150x1000", "CP3 1140x1140", "AU 1165x1165"],
         restart=True, v2=("P201", "Load carrier")),
    dict(key="lift_time", tab="lift", label="Lift time", unit="s", kind="num", default=2.5, min=1.5, max=5.0, step=0.1, v2=("P202", "Lift duration")),
    dict(key="settle_delay", tab="lift", label="Settle delay after lift", unit="ms", kind="int", default=300, min=0, max=2000, step=10, v2=("P203", "Post-lift wait")),
    dict(key="pallet_gap", tab="lift", label="Pallet gap in lane", unit="mm", kind="int", default=75, min=30, max=200, step=5, v2=("P204", "Gap between pallets")),
    dict(key="vld_enabled", tab="lift", label="Variable loading depth", unit="", kind="bool", default=False, v2=("P205", "VLD")),
    dict(key="vld_first_pos", tab="lift", label="VLD first-pallet position", unit="mm", kind="int", default=0, min=0, max=30000, step=10, v2=("P206", "VLD start position")),
    # energy
    dict(key="low_batt_warn", tab="energy", label="Low-battery warning", unit="%", kind="int", default=25, min=10, max=50, step=1, v2=("P301", "Battery warning level")),
    dict(key="return_charge", tab="energy", label="Return-to-charge threshold", unit="%", kind="int", default=15, min=5, max=30, step=1, v2=("P302", "Charge request level")),
    dict(key="inlane_charging", tab="energy", label="In-lane charging", unit="", kind="bool", default=False, v2=("P303", "Lane charger")),
    dict(key="cold_store_mode", tab="energy", label="Cold-store mode", unit="", kind="bool", default=False, restart=True, v2=("P304", "Freezer mode")),
    # safety
    dict(key="obstacle_stop", tab="safety", label="Obstacle stop distance", unit="mm", kind="int", default=300, min=100, max=1000, step=10, safety=True, v2=("P401", "Obstacle distance")),
    dict(key="manual_speed_cap", tab="safety", label="Manual-mode speed cap", unit="m/s", kind="num", default=0.3, min=0.1, max=0.5, step=0.05, safety=True, v2=("P402", "Manual speed limit")),
    dict(key="overload_pct", tab="safety", label="Overload threshold", unit="% of 1500 kg", kind="int", default=105, min=100, max=120, step=1, safety=True, v2=("P403", "Overload trip")),
    # comms
    dict(key="rf_band", tab="comms", label="RF band", unit="MHz", kind="select", default="433", options=["433", "915"], restart=True, v2=("P501", "Radio band")),
    dict(key="heartbeat_ms", tab="comms", label="Heartbeat timeout", unit="ms", kind="int", default=2000, min=500, max=10000, step=100, v2=("P502", "Link watchdog")),
    dict(key="wms_host", tab="comms", label="WMS host", unit="", kind="text", default="10.20.0.15", v2=("P503", "Host address")),
    dict(key="wms_port", tab="comms", label="WMS port", unit="", kind="int", default=5020, min=1, max=65535, step=1, v2=("P504", "Host port")),
]
PBYKEY = {p["key"]: p for p in PARAMS}
PBYV2 = {p["v2"][0]: p for p in PARAMS}


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
def factory_state():
    shuttles = {}
    for i, sid in enumerate(SHUTTLE_IDS):
        active = {p["key"]: p["default"] for p in PARAMS}
        # a little site-specific variation so shuttles are not identical
        if i % 2 == 1:
            active["accel"] = 0.45
        if i == 4:
            active["pallet_type"] = "INDU 1200x1000"
        shuttles[sid] = {"active": active, "pending": {}, "cycles": random.randint(12000, 48000)}
    return {"ui_version": 1, "shuttles": shuttles}


def load_state():
    with LOCK:
        if not os.path.exists(STATE_FILE):
            st = factory_state()
            _write(st)
            return st
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)


def _write(st):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=2)
    os.replace(tmp, STATE_FILE)


def save_state(st):
    with LOCK:
        _write(st)


def coerce(p, raw):
    """Turn a submitted string into a device value. Clamps and rounds like a real controller would."""
    k = p["kind"]
    if k == "bool":
        return raw in ("on", "true", "1", True)
    if k == "text":
        return str(raw).strip()[:64]
    if k == "select":
        return raw if raw in p["options"] else p["default"]
    try:
        v = float(str(raw).replace(",", "."))
    except ValueError:
        return None  # rejected
    v = max(p["min"], min(p["max"], v))
    step = p["step"]
    v = round(round(v / step) * step, 4)
    if k == "int":
        return int(round(v))
    return round(v, 3)


def fmt(p, v):
    if p["kind"] == "bool":
        return "on" if v else "off"
    if p["kind"] == "num":
        return f"{v:g}"
    return str(v)


def apply_change(st, sid, key, raw):
    """Apply one parameter value; returns a note string or None."""
    p = PBYKEY[key]
    sh = st["shuttles"][sid]
    v = coerce(p, raw)
    if v is None:
        return f"{p['label']}: rejected (not a number)"
    current = sh["pending"].get(key, sh["active"][key])
    if v == current:
        return None
    note = None
    if p["kind"] in ("num", "int") and str(raw).strip() not in (fmt(p, v), str(v)):
        try:
            if abs(float(str(raw).replace(",", ".")) - v) > 1e-9:
                note = f"{p['label']}: {raw} adjusted to {fmt(p, v)}"
        except ValueError:
            pass
    if p.get("restart"):
        if v == sh["active"][key]:
            sh["pending"].pop(key, None)
        else:
            sh["pending"][key] = v
            note = (note + "; " if note else "") + f"{p['label']}: becomes active after restart"
    else:
        sh["active"][key] = v
    return note


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------
CSS = """
:root{--bg:#f4f5f2;--panel:#fff;--ink:#1d2321;--muted:#5d6763;--line:#d7dbd6;--accent:#0f6e56;--accent-ink:#fff;--warn:#8a5a00;--warn-bg:#fdf1d8;--bad:#a32d2d;--ok:#3b6d11}
@media (prefers-color-scheme:dark){:root{--bg:#141716;--panel:#1c201f;--ink:#e6e9e6;--muted:#9aa39f;--line:#2f3532;--accent:#5dcaa5;--accent-ink:#06261d;--warn:#f3c26b;--warn-bg:#3a2c0d;--bad:#f09595;--ok:#97c459}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}header{display:flex;align-items:center;gap:16px;padding:14px 24px;border-bottom:1px solid var(--line);background:var(--panel)}
header .sim{margin-left:auto;font-size:12px;color:var(--muted);border:1px dashed var(--line);padding:2px 8px;border-radius:4px}
main{max-width:980px;margin:0 auto;padding:20px 24px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin-bottom:16px}
.tele{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.tele div{font-size:13px;color:var(--muted)}.tele b{display:block;font-size:17px;color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
.led{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
nav.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:0;flex-wrap:wrap}
nav.tabs a{padding:8px 14px;text-decoration:none;color:var(--muted);border:1px solid transparent;border-bottom:none;border-radius:6px 6px 0 0}
nav.tabs a.on{color:var(--ink);background:var(--panel);border-color:var(--line);margin-bottom:-1px}
table.p{width:100%;border-collapse:collapse}table.p td,table.p th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
table.p th{font-weight:500;width:42%}.unit{color:var(--muted);font-size:13px}.hint{color:var(--muted);font-size:12px}
input[type=text],input[type=number],select{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--ink);width:180px}
.btn{font:inherit;padding:7px 16px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);cursor:pointer}
.btn.sec{background:transparent;color:var(--accent)}
.msg{padding:10px 14px;border-radius:6px;margin-bottom:14px;background:var(--warn-bg);color:var(--warn);font-size:14px}
.msg.ok{background:transparent;border:1px solid var(--line);color:var(--ok)}
.pending{color:var(--warn);font-size:12px}.safety{color:var(--bad);font-size:11px;border:1px solid var(--bad);border-radius:3px;padding:0 4px;margin-left:6px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px}.grid2 .row{display:flex;flex-direction:column;gap:3px;padding:6px 0;border-bottom:1px solid var(--line)}
.grid2 .row span.l{font-size:13px;color:var(--muted)}
.fleet td,.fleet th{padding:8px;border-bottom:1px solid var(--line);text-align:left}.fleet{width:100%;border-collapse:collapse}
form.inline{display:inline}
"""


def page(title, body):
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title>
<style>{CSS}</style></head><body>{body}</body></html>"""


def fleet_page(st, msg=""):
    rows = []
    for sid in SHUTTLE_IDS:
        sh = st["shuttles"][sid]
        pend = len(sh["pending"])
        rows.append(f"""<tr><td><a href="/shuttle/{sid}/config?tab=travel">{sid}</a></td>
<td>{html.escape(str(sh['active']['pallet_type']))}</td>
<td>{fmt(PBYKEY['accel'], sh['active']['accel'])} m/s²</td>
<td>{'<span class="pending">' + str(pend) + ' pending restart</span>' if pend else '—'}</td>
<td><form class="inline" method="post" action="/fleet/remote-change"><input type="hidden" name="sid" value="{sid}">
<button class="btn sec" type="submit" title="Changes one random parameter without using this web page">Simulate RF-remote change</button></form></td></tr>""")
    uiv = st.get("ui_version", 1)
    body = f"""<header><strong>Shuttle fleet</strong><span class="sim">Simulator, not a  product</span></header><main>
{f'<div class="msg">{html.escape(msg)}</div>' if msg else ''}
<div class="card"><table class="fleet"><thead><tr><th>Shuttle</th><th>Pallet type</th><th>Acceleration</th><th>Restart</th><th></th></tr></thead>
<tbody>{''.join(rows)}</tbody></table></div>
<div class="card"><strong>Test switches</strong>
<p class="hint">UI version 2 renames every field and changes the page layout, to test that the add-on survives a redesigned device page.</p>
<form method="post" action="/fleet/ui"><label><input type="radio" name="ui" value="1" {'checked' if uiv == 1 else ''}> UI version 1</label>
&nbsp; <label><input type="radio" name="ui" value="2" {'checked' if uiv == 2 else ''}> UI version 2</label>
&nbsp; <button class="btn sec" type="submit">Switch</button></form>
<form method="post" action="/fleet/reset" style="margin-top:12px"><button class="btn sec" type="submit">Reset all shuttles to factory defaults</button></form>
<p class="hint">From a terminal: <code>python shuttle_sim.py set SH-01 accel 0.6</code> changes a value outside the browser.</p></div>
</main>"""
    return page("Shuttle fleet", body)


def field_html(p, value, ui):
    name = p["key"] if ui == 1 else p["v2"][0]
    fid = "f_" + name
    k = p["kind"]
    if k == "bool":
        return f'<input type="checkbox" id="{fid}" name="{name}" {"checked" if value else ""}>'
    if k == "select":
        opts = "".join(f'<option {"selected" if o == value else ""}>{html.escape(o)}</option>' for o in p["options"])
        return f'<select id="{fid}" name="{name}">{opts}</select>'
    if k == "text":
        return f'<input type="text" id="{fid}" name="{name}" value="{html.escape(str(value))}">'
    return f'<input type="number" id="{fid}" name="{name}" value="{fmt(p, value)}" step="{p["step"]}">'


def config_page(st, sid, tab, msg="", ok=""):
    sh = st["shuttles"][sid]
    ui = st.get("ui_version", 1)
    act = sh["active"]
    batt = random.randint(38, 97)
    led_color, led_txt = ("#3b6d11", "Operational") if not sh["pending"] else ("#ba7517", "Restart required")
    tele = f"""<div class="card tele">
<div>Status<b><span class="led" style="background:{led_color}"></span>{led_txt}</b></div>
<div>Battery<b>{batt} %</b></div><div>Position in lane<b>{random.randint(0, 24000)} mm</b></div>
<div>Cycles<b>{sh['cycles'] + random.randint(0, 40):,}</b></div><div>Firmware<b>{FIRMWARE}</b></div></div>"""
    tabs = "".join(f'<a class="{"on" if t == tab else ""}" href="/shuttle/{sid}/config?tab={t}">{lbl}</a>' for t, lbl in TABS)
    params = [p for p in PARAMS if p["tab"] == tab]

    def extras(p):
        out = ""
        if p.get("safety"):
            out += '<span class="safety">safety</span>'
        if p["key"] in sh["pending"]:
            out += f'<div class="pending">After restart: {html.escape(fmt(p, sh["pending"][p["key"]]))}</div>'
        elif p.get("restart"):
            out += '<div class="hint">Takes effect after restart</div>'
        return out

    if ui == 1:
        rows = "".join(f"""<tr><th><label for="f_{p['key']}">{html.escape(p['label'])}</label>{extras(p)}</th>
<td>{field_html(p, act[p['key']], ui)} <span class="unit">{html.escape(p['unit'])}</span></td>
<td class="hint">{'' if p['kind'] in ('bool', 'select', 'text') else f"{fmt(p, p['min'])} – {fmt(p, p['max'])}"}</td></tr>""" for p in params)
        form_inner = f'<table class="p">{rows}</table>'
    else:
        # v2: no <label for>, codes as field names, label in a sibling span
        rows = "".join(f"""<div class="row"><span class="l">{p['v2'][0]} · {html.escape(p['v2'][1])}</span>
<div>{field_html(p, act[p['key']], ui)} <span class="unit">{html.escape(p['unit'])}</span>{extras(p)}</div></div>""" for p in params)
        form_inner = f'<div class="grid2">{rows}</div>'

    body = f"""<header><a href="/">Fleet</a><strong>Shuttle {sid}</strong><span class="hint">Configuration · UI v{ui}</span>
<span class="sim">Simulator, not a  product</span></header><main>
{f'<div class="msg">{html.escape(msg)}</div>' if msg else ''}{f'<div class="msg ok">{html.escape(ok)}</div>' if ok else ''}
{tele}
<nav class="tabs">{tabs}</nav>
<div class="card" style="border-top-left-radius:0">
<form method="post" action="/shuttle/{sid}/config?tab={tab}">{form_inner}
<p style="margin-top:16px;display:flex;gap:10px"><button class="btn" type="submit">Save to shuttle</button>
<a class="btn sec" href="/shuttle/{sid}/config?tab={tab}" style="text-decoration:none">Discard</a></p></form>
<form method="post" action="/shuttle/{sid}/restart?tab={tab}"><button class="btn sec" type="submit">Restart shuttle</button>
<span class="hint">Applies parameters that wait for a restart.</span></form></div></main>"""
    return page(f"{sid} configuration", body)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "ShuttleSim/1.0"

    def log_message(self, fmt_, *args):
        sys.stderr.write("  %s %s\n" % (self.command, self.path))

    def send_html(self, code, body):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, url):
        self.send_response(303)
        self.send_header("Location", url)
        self.end_headers()

    def parse_path(self):
        u = urlparse(self.path)
        parts = [p for p in u.path.split("/") if p]
        return u, parts, {k: v[-1] for k, v in parse_qs(u.query).items()}

    def read_form(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode("utf-8")
        return {k: v[-1] for k, v in parse_qs(raw, keep_blank_values=True).items()}

    def do_GET(self):
        u, parts, q = self.parse_path()
        st = load_state()
        if not parts:
            return self.send_html(200, fleet_page(st, q.get("msg", "")))
        if len(parts) == 3 and parts[0] == "shuttle" and parts[2] == "config" and parts[1] in st["shuttles"]:
            tab = q.get("tab", "travel")
            if tab not in dict(TABS):
                tab = "travel"
            return self.send_html(200, config_page(st, parts[1], tab, q.get("msg", ""), q.get("ok", "")))
        if len(parts) == 2 and parts[0] == "shuttle" and parts[1] in st["shuttles"]:
            return self.redirect(f"/shuttle/{parts[1]}/config?tab=travel")
        self.send_html(404, page("Not found", "<main><p>Not found. <a href='/'>Fleet</a></p></main>"))

    def do_POST(self):
        from urllib.parse import quote
        u, parts, q = self.parse_path()
        form = self.read_form()
        st = load_state()
        if parts == ["fleet", "ui"]:
            st["ui_version"] = 2 if form.get("ui") == "2" else 1
            save_state(st)
            return self.redirect("/?msg=" + quote(f"Device pages now use UI version {st['ui_version']}"))
        if parts == ["fleet", "reset"]:
            save_state(factory_state())
            return self.redirect("/?msg=" + quote("All shuttles reset to factory defaults"))
        if parts == ["fleet", "remote-change"] and form.get("sid") in st["shuttles"]:
            msg = remote_change(st, form["sid"])
            save_state(st)
            return self.redirect("/?msg=" + quote(msg))
        if len(parts) == 3 and parts[0] == "shuttle" and parts[1] in st["shuttles"]:
            sid, tab = parts[1], q.get("tab", "travel")
            if parts[2] == "restart":
                sh = st["shuttles"][sid]
                n = len(sh["pending"])
                sh["active"].update(sh["pending"])
                sh["pending"] = {}
                save_state(st)
                time.sleep(0.6)
                return self.redirect(f"/shuttle/{sid}/config?tab={tab}&ok=" + quote(f"Shuttle restarted, {n} pending value(s) applied"))
            if parts[2] == "config":
                ui = st.get("ui_version", 1)
                notes = []
                for p in [p for p in PARAMS if p["tab"] == tab]:
                    name = p["key"] if ui == 1 else p["v2"][0]
                    if p["kind"] == "bool":
                        raw = "on" if name in form else "off"
                    elif name in form:
                        raw = form[name]
                    else:
                        continue
                    note = apply_change(st, sid, p["key"], raw)
                    if note:
                        notes.append(note)
                save_state(st)
                time.sleep(0.3)  # a real controller takes a moment
                url = f"/shuttle/{sid}/config?tab={tab}&ok=" + quote("Saved")
                if notes:
                    url += "&msg=" + quote(" · ".join(notes))
                return self.redirect(url)
        self.send_html(404, page("Not found", "<main><p>Not found.</p></main>"))


def remote_change(st, sid):
    sh = st["shuttles"][sid]
    candidates = [p for p in PARAMS if p["kind"] in ("num", "int") and not p.get("restart")]
    p = random.choice(candidates)
    cur = sh["active"][p["key"]]
    for _ in range(20):
        delta = p["step"] * random.choice([-3, -2, -1, 1, 2, 3])
        v = coerce(p, cur + delta)
        if v != cur:
            break
    sh["active"][p["key"]] = v
    return f"{sid}: {p['label']} changed from {fmt(p, cur)} to {fmt(p, v)} via the RF remote (not via the web page)"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", nargs="?", default="serve", choices=["serve", "set", "reset"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    if a.cmd == "reset":
        save_state(factory_state())
        print("All shuttles reset to factory defaults.")
        return
    if a.cmd == "set":
        if len(a.args) != 3:
            sys.exit("usage: shuttle_sim.py set <SHUTTLE-ID> <parameter> <value>\nparameters: " + ", ".join(PBYKEY))
        sid, key, val = a.args
        st = load_state()
        if sid not in st["shuttles"]:
            sys.exit(f"unknown shuttle {sid}; known: {', '.join(SHUTTLE_IDS)}")
        if key not in PBYKEY:
            sys.exit(f"unknown parameter {key}; known: {', '.join(PBYKEY)}")
        p = PBYKEY[key]
        v = coerce(p, val)
        if v is None:
            sys.exit("value rejected")
        st["shuttles"][sid]["active"][key] = v
        save_state(st)
        print(f"{sid}: {p['label']} = {fmt(p, v)} (changed outside the browser)")
        return
    load_state()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"Shuttle simulator running at http://localhost:{a.port}  (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
