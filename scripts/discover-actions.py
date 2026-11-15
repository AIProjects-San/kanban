#!/usr/bin/env python3
"""Phase 0 discovery: enumerate server actions, their permission gates and
their Prisma model touches. Output: a compact per-file report."""
import re, os, json, glob

ROOT = "/home/z/my-project/src/server-actions"
files = sorted(f for f in glob.glob(os.path.join(ROOT, "*.ts")) if "__tests__" not in f)

PERM_RE = re.compile(r'"((?:task|project|member|message|event|settings|role|analytics|team|audit|bug|hr|leave|review|onboarding|hiring|payroll|attendance|statutory):[a-z:]+)"')
EXPORT_RE = re.compile(r'^export (?:async )?function (\w+)', re.M)
MODEL_MUT_RE = re.compile(r'\b(?:tx|db)\.(\w+)\.(?:create|update|delete|upsert|deleteMany|updateMany|createMany)\b')
MODEL_READ_RE = re.compile(r'\b(?:tx|db)\.(\w+)\.(?:findUnique|findFirst|findMany|count|aggregate|groupBy)\b')

report = {}
for path in files:
    name = os.path.basename(path)
    src = open(path).read()
    exports = EXPORT_RE.findall(src)
    perms = sorted(set(PERM_RE.findall(src)))
    muts = sorted(set(MODEL_MUT_RE.findall(src)))
    reads = sorted(set(MODEL_READ_RE.findall(src)))
    # "use server" marker means UI-callable actions live here
    use_server = '"use server"' in src.split("\n", 5)[0] or '"use server"' in src[:200]
    report[name] = {
        "exports": exports,
        "count": len(exports),
        "permissions": perms,
        "mutates": muts,
        "reads": reads,
    }

total = sum(v["count"] for v in report.values())
print(f"FILES: {len(report)}  TOTAL EXPORTED FNS: {total}")
print()
for name, v in report.items():
    print(f"### {name} ({v['count']} exports)")
    if v["permissions"]:
        print(f"  perms: {', '.join(v['permissions'])}")
    if v["mutates"]:
        print(f"  mutates: {', '.join(v['mutates'])}")
    print(f"  exports: {', '.join(v['exports'])}")
    print()

with open("/tmp/actions-report.json", "w") as f:
    json.dump(report, f, indent=1)
