import json, os, time

BASE = r"C:\Users\vac34\AppData\Roaming\ZAICODE"
NOW = time.time() * 1000
d = json.load(open(os.path.join(BASE, "zaicode-engines-cache.json"), encoding="utf-8"))
limits = d.get("limits") or {}
out = []
for acc, s in limits.items():
    if not isinstance(s, dict):
        out.append(f"{acc}|NOSTATE")
        continue
    ws = []
    for w in (s.get("windows") or []):
        if not isinstance(w, dict):
            continue
        r = w.get("resetsAt")
        hrs = (r - NOW) / 3.6e6 if isinstance(r, (int, float)) and r > 0 else None
        ws.append(f"{w.get('key')}={w.get('remainingPercent'):.2f}%@{('%.1fh' % hrs) if hrs is not None else 'none'}")
    ca = s.get("checkedAt")
    out.append(f"{acc}|checked={time.strftime('%H:%M:%SZ', time.gmtime(ca/1000)) if isinstance(ca,(int,float)) and ca else 'none'}|err={s.get('error')}|" + "; ".join(ws))
open(r"V:\___VAC\__K\__CODE\_AI_STUFF_AGENTIC\_ZAICODE\.saipen\evidence\_probe_out.txt", "w", encoding="utf-8").write(
    "NOW=%s lastSweep=%s\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW/1000)),
                               time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(d["lastSweepAt"]/1000)) if d.get("lastSweepAt") else "none")
    + "\n".join(out) + "\n")