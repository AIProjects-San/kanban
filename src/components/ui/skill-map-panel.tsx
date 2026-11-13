"use client";

// P37 (EM-19, PF-07, EM-18) — the employee skill-map panel
// (docs/Fernly_HR_Payroll_Enhancement_Plan.md §7.2 P37). ONE component,
// two mounts: the HR console's directory (any employee, canManage=true —
// HR rates) and the Settings self-service surface (the member's own map,
// read-only — the rating is HR's structured record; the free-text
// `skills` string stays the member's own quick summary).

import { useCallback, useEffect, useState } from "react";
import { Award, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Field } from "./field";
import { Section } from "./section";
import { cn } from "@/lib/shared/utils";
import type { EmployeeSkillT, SkillT } from "@/lib/types";
import { SKILL_PROFICIENCY_LABELS } from "@/lib/hr/skills";
import {
  getSkillMap,
  upsertEmployeeSkill,
  removeEmployeeSkill,
} from "@/server-actions/hr-skills";

const RATING_CHIP: Record<number, string> = {
  1: "bg-muted text-muted-foreground",
  2: "bg-muted text-muted-foreground",
  3: "bg-primary/10 text-primary",
  4: "bg-success/15 text-success",
  5: "bg-warning/15 text-warning",
};

export function SkillMapPanel({
  userId, self,
}: {
  /** The employee being viewed (omit = the signed-in member themself). */
  userId?: string;
  /** true = the Settings self-service mount (read-only). */
  self: boolean;
}) {
  const [entries, setEntries] = useState<EmployeeSkillT[] | null>(null);
  const [skills, setSkills] = useState<SkillT[]>([]);
  const [summary, setSummary] = useState("");
  const [canManage, setCanManage] = useState(false);
  const [skillKey, setSkillKey] = useState("");
  const [rating, setRating] = useState(3);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await getSkillMap(userId ? { userId } : {});
    if (res.ok) {
      setEntries(res.data.entries);
      setSkills(res.data.skills);
      setSummary(res.data.summary);
      setCanManage(res.data.canManage);
    } else {
      toast.error(res.error);
      setEntries([]);
    }
  }, [userId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okToast: string) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) { toast.error((res as { error: string }).error); return; }
    toast.success(okToast);
    await load();
  };

  if (entries === null) {
    return <div className="text-sm text-muted-foreground py-2">Loading skill map…</div>;
  }

  const hrActions = !self && canManage;

  return (
    <div className="space-y-3" data-testid="skill-map-panel">
      <div className="text-sm text-muted-foreground" data-testid="skill-map-summary">{summary}</div>
      <div className="space-y-1.5">
        {entries.map((e) => (
          <div
            key={e.id}
            className="rounded-md border border-border px-3 py-2 flex items-center gap-3"
            data-testid={`skill-map-${e.label}`}
          >
            <Award size={14} className="text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm truncate">{e.label}</div>
              <div className="text-[0.625rem] text-muted-foreground truncate">
                {e.assessedBy ? `assessed by ${e.assessedBy}` : "not yet assessed"}{e.assessedAt ? ` · ${new Date(e.assessedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}
                {e.notes ? ` · ${e.notes}` : ""}
              </div>
            </div>
            <span
              className={cn("shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] font-medium", RATING_CHIP[e.rating] ?? "bg-muted text-muted-foreground")}
              title={`${e.rating}/5 — ${e.proficiency}`}
              data-testid={`skill-rating-${e.label}`}
            >
              {e.rating}/5 · {e.proficiency}
            </span>
            {hrActions && (
              <button
                className="f-btn f-btn-ghost f-btn-sm text-destructive shrink-0"
                disabled={busy}
                onClick={() => void run(() => removeEmployeeSkill({ id: e.id }), "Rating removed.")}
                aria-label={`Remove ${e.label} rating`}
                data-testid={`skill-remove-${e.label}`}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
        {entries.length === 0 && (
          <div className="text-sm text-muted-foreground">No rated skills yet — the free-text summary stays on the profile.</div>
        )}
      </div>

      {hrActions && (
        <form
          className="rounded-md border border-border p-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!skillKey) return;
            void run(
              () => upsertEmployeeSkill({ userId: userId ?? "", skillKey, rating, notes }),
              `Rated ${rating}/5 (${SKILL_PROFICIENCY_LABELS[rating]}).`,
            );
            setSkillKey("");
            setNotes("");
            setRating(3);
          }}
          data-testid="skill-rate-form"
        >
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-2">
            <Field label="Rate a skill">
              <select className="f-input" value={skillKey} onChange={(e) => setSkillKey(e.target.value)} data-testid="skill-rate-select" required>
                <option value="" disabled>Pick a skill…</option>
                {skills.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Rating (1–5)">
              <select
                className="f-input"
                value={rating}
                onChange={(e) => setRating(Number(e.target.value))}
                data-testid="skill-rate-value"
              >
                {[5, 4, 3, 2, 1].map((r) => (
                  <option key={r} value={r}>{r} · {SKILL_PROFICIENCY_LABELS[r]}</option>
                ))}
              </select>
            </Field>
            <Field label="Note (optional)">
              <input className="f-input" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. owns the design-system review" />
            </Field>
          </div>
          <button type="submit" className="f-btn f-btn-secondary f-btn-sm" disabled={busy || !skillKey}>
            <Plus size={12} /> Rate
          </button>
        </form>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Settings self-service mount (P37/EM-18): the member's own map,
// read-only (HR's structured record; the free-text summary is theirs).
// ---------------------------------------------------------------------------

export function MySkillMapSection() {
  return (
    <Section
      icon={Award}
      title="My skill map"
      description="Your rated skills — HR maintains the ratings; edit your free-text summary above"
    >
      <SkillMapPanel self />
    </Section>
  );
}
