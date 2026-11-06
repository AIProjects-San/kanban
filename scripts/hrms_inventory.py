#!/usr/bin/env python3
"""Inventory every doctype, report, notification, workflow and dashboard in frappe/hrms.

Outputs:
  - .analysis/hrms_inventory.json   (full structured data)
  - .analysis/hrms_inventory.md     (compact tables)
  - stdout summary
"""
import json
import re
from pathlib import Path

ROOT = Path("/home/z/my-project/.analysis/hrms")
APP = ROOT / "hrms"
MODULES = ["hr", "payroll"]


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def py_lines(path):
    if not path.exists():
        return 0
    with open(path, encoding="utf-8") as fh:
        return sum(1 for _ in fh)


def summarize_doctype(json_path):
    try:
        j = load_json(json_path)
    except Exception as exc:  # noqa: BLE001
        return {"name": json_path.stem, "error": str(exc)}
    fields = j.get("fields", [])
    roles = sorted({p.get("role", "?") for p in j.get("permissions", [])})
    select_status = [
        f.get("fieldname")
        for f in fields
        if f.get("fieldtype") == "Select"
        and f.get("fieldname")
        in ("status", "workflow_state", "approval_status", "leave_status", "attendance_status")
    ]
    status_options = {}
    for f in fields:
        if f.get("fieldtype") == "Select" and f.get("fieldname") in select_status:
            opts = [o.strip() for o in (f.get("options") or "").split("\n") if o.strip()]
            if opts:
                status_options[f["fieldname"]] = opts
    links = sorted(
        {
            f.get("options")
            for f in fields
            if f.get("fieldtype") == "Link" and f.get("options") and not str(f.get("options")).startswith("Doc.")
        }
    )
    child_tables = sorted(
        {
            f.get("options")
            for f in fields
            if f.get("fieldtype") == "Table" and f.get("options")
        }
    )
    return {
        "name": j.get("name"),
        "module": j.get("module"),
        "kind": "child" if j.get("istable") else ("single" if j.get("issingle") else "standard"),
        "submittable": bool(j.get("is_submittable")),
        "field_count": len(fields),
        "roles": roles,
        "status_fields": status_options,
        "links_to": links,
        "child_tables": child_tables,
        "autoname": j.get("autoname") or "",
        "py_lines": py_lines(json_path.parent / (json_path.stem + ".py")),
    }


def collect_reports(module_dir):
    reports = []
    rdir = module_dir / "report"
    if rdir.exists():
        for rep in sorted(rdir.iterdir()):
            if not rep.is_dir():
                continue
            has_json = (rep / (rep.name + ".json")).exists()
            is_script = (rep / (rep.name + ".py")).exists()
            refs = []
            py = rep / (rep.name + ".py")
            if py.exists():
                text = py.read_text(encoding="utf-8", errors="ignore")
                refs = sorted(set(re.findall(r'"(Salary Slip|Payroll Entry|Attendance|Leave Application|Expense Claim|Employee|Salary Structure[^"]*)"', text)))[:6]
            reports.append(
                {
                    "name": rep.name,
                    "query_report": has_json,
                    "script_report": is_script,
                    "references": refs,
                }
            )
    return reports


def collect_json_dir(module_dir, sub):
    out = []
    d = module_dir / sub
    if d.exists():
        for f in sorted(d.glob("*.json")):
            try:
                j = load_json(f)
                out.append({"file": f.name, "name": j.get("name"), "doctype": j.get("doctype")})
            except Exception:  # noqa: BLE001
                out.append({"file": f.name, "error": "parse"})
    return out


def main():
    result = {"modules": {}}
    for mod in MODULES:
        mdir = APP / mod
        dt_dir = mdir / "doctype"
        doctypes = []
        if dt_dir.exists():
            for dt in sorted(dt_dir.iterdir()):
                if not dt.is_dir():
                    continue
                jf = dt / (dt.name + ".json")
                if jf.exists():
                    doctypes.append(summarize_doctype(jf))
        result["modules"][mod] = {
            "doctypes": doctypes,
            "reports": collect_reports(mdir),
            "notifications": collect_json_dir(mdir, "notification"),
            "workflows": collect_json_dir(mdir, "workflow"),
            "dashboard_charts": collect_json_dir(mdir, "dashboard_chart"),
            "number_cards": collect_json_dir(mdir, "number_card"),
            "dashboards": collect_json_dir(mdir, "dashboard"),
        }

    # setup + patches + hooks
    setup_dir = APP / "setup"
    patches_file = ROOT / "hrms" / "patches.txt"
    hooks_file = ROOT / "hrms" / "hooks.py"
    result["setup_files"] = sorted(p.name for p in setup_dir.rglob("*.py")) if setup_dir.exists() else []
    result["patches_count"] = (
        sum(1 for line in patches_file.read_text(encoding="utf-8").splitlines() if line.strip() and not line.startswith("#"))
        if patches_file.exists()
        else 0
    )
    hooks = {}
    if hooks_file.exists():
        text = hooks_file.read_text(encoding="utf-8")
        for key in ("doc_events", "scheduler_events", "fixtures", "after_install", "permission_query_conditions", "has_permission"):
            hooks[key] = len(re.findall(rf'^\s*"{key}"|^{key}', text, re.M))
    result["hooks_keys"] = hooks

    # roster app at repo root?
    roster = ROOT / "roster"
    result["roster_dir"] = sorted(p.name for p in roster.iterdir())[:20] if roster.exists() else []

    out_json = Path("/home/z/my-project/.analysis/hrms_inventory.json")
    out_json.write_text(json.dumps(result, indent=1), encoding="utf-8")

    # markdown digest
    lines = []
    for mod in MODULES:
        m = result["modules"][mod]
        std = [d for d in m["doctypes"] if d.get("kind") == "standard"]
        child = [d for d in m["doctypes"] if d.get("kind") == "child"]
        single = [d for d in m["doctypes"] if d.get("kind") == "single"]
        lines.append(f"\n## Module: {mod}")
        lines.append(f"- Doctypes: {len(m['doctypes'])} total ({len(std)} standard, {len(child)} child tables, {len(single)} singles)")
        lines.append(f"- Reports: {len(m['reports'])} | Notifications: {len(m['notifications'])} | Workflows: {len(m['workflows'])} | Dashboards: {len(m['dashboards'])} | Charts: {len(m['dashboard_charts'])} | Cards: {len(m['number_cards'])}")
        lines.append(f"\n### {mod} standard doctypes (submittable marked *)")
        for d in sorted(std, key=lambda x: x.get("name", "")):
            sub = "*" if d.get("submittable") else ""
            sts = "; ".join(f"{k}={','.join(v[:8])}" for k, v in d.get("status_fields", {}).items())
            lines.append(f"- {d.get('name')}{sub} — {d.get('field_count')} fields, {d.get('py_lines')} py lines{(' | ' + sts) if sts else ''}")
        lines.append(f"\n### {mod} child tables")
        for d in sorted(child, key=lambda x: x.get("name", "")):
            lines.append(f"- {d.get('name')} — {d.get('field_count')} fields")
        lines.append(f"\n### {mod} singles")
        for d in sorted(single, key=lambda x: x.get("name", "")):
            lines.append(f"- {d.get('name')} — {d.get('field_count')} fields")
        lines.append(f"\n### {mod} reports")
        for r in m["reports"]:
            kind = "script" if r["script_report"] else "query"
            lines.append(f"- {r['name']} ({kind})")
        if m["notifications"]:
            lines.append(f"\n### {mod} notifications: " + ", ".join(n.get("name") or n["file"] for n in m["notifications"]))
        if m["workflows"]:
            lines.append(f"### {mod} workflows: " + ", ".join(n.get("name") or n["file"] for n in m["workflows"]))
    Path("/home/z/my-project/.analysis/hrms_inventory.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(f"\npatches: {result['patches_count']} entries; setup files: {len(result['setup_files'])}; roster dir: {result['roster_dir'][:8]}")


if __name__ == "__main__":
    main()
