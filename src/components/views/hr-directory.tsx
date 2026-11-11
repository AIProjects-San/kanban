"use client";

// HR module feature 2 — self-service employee profile card (settings view)
// + the HR console's directory tab (docs/HR_MODULE_PLAN.md §5).
//
// Self-service: every signed-in user edits THEIR OWN contact fields
// (settings:edit baseline — phone, location, emergency contact, skills).
// Job data (jobTitle, department, hireDate) is HR-owned and shown
// read-only here (QA-10 — the plan says "self-service edit of own contact
// fields; HR/ADMIN edit everything"). The HR console directory tab
// (hr:view) shows the roster with org-chart manager names; hr:admin can
// edit anyone including the HR-only `notes` field.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Briefcase, Download, Loader2, Search, Pencil, ArrowUpRight } from "lucide-react";
import { toast } from "sonner";
import { Section } from "../ui/section";
import { Field } from "../ui/field";
import { Modal } from "../ui/modal";
import { Avatar } from "../ui/avatar";
import { RoleBadge } from "../ui/role-badge";
import { EmploymentChangeModal } from "../ui/employment-change-modal";
import { EmploymentChangesSection } from "../ui/employment-history-section";
import { DEPARTMENT_LABELS, departmentLabel, EMPLOYMENT_TYPE_LABELS, employmentTypeLabel } from "@/lib/config";
import { retirementProjection } from "@/lib/employment-change";
import {
  EMPLOYMENT_STATUS_BADGE,
  EMPLOYMENT_STATUS_LABELS,
  EMPLOYMENT_STATUS_TRANSITIONS,
} from "@/lib/employment";
import type { EmployeeProfileT, EmploymentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  getMyProfile,
  upsertMyProfile,
  getDirectory,
  updateProfileAsAdmin,
  exportDirectoryCsv,
} from "@/server-actions/hr-directory";
import { transitionEmployment } from "@/server-actions/employment";

// ---------------------------------------------------------------------------
// Self-service card (Settings view)
// ---------------------------------------------------------------------------

export function EmployeeProfileSection() {
  const [profile, setProfile] = useState<EmployeeProfileT | null | "none">(null); // null → loading; "none" → no row yet
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [ecName, setEcName] = useState("");
  const [ecPhone, setEcPhone] = useState("");
  const [skills, setSkills] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await getMyProfile();
    if (res.ok) {
      const p = res.data;
      setProfile(p ?? "none");
      if (p) {
        setPhone(p.phone);
        setLocation(p.location);
        setEcName(p.emergencyContactName);
        setEcPhone(p.emergencyContactPhone);
        setSkills(p.skills);
      }
    } else {
      setProfile("none");
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  return (
    <Section icon={Briefcase} title="Employee profile" description="Your job data and emergency contact — visible to HR and your manager">
      {profile === null ? (
        <div className="text-sm text-muted-foreground py-2">Loading employee profile…</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* QA-10: job data is HR-owned — displayed read-only, not editable. */}
          <div className="sm:col-span-2 rounded-lg border border-border bg-muted/40 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Job data (set by HR)</span>
            <span className="text-sm font-medium text-foreground" data-testid="ro-job-title">
              {profile !== "none" && profile.jobTitle ? profile.jobTitle : "—"}
            </span>
            <span className="text-sm text-muted-foreground" data-testid="ro-department">
              {profile !== "none" && profile.department ? departmentLabel(profile.department) : "—"}
            </span>
            {profile !== "none" && profile.hireDate ? (
              <span className="text-sm text-muted-foreground">Hired {profile.hireDate}</span>
            ) : null}
            {/* P34 (EM-03) — the grouping axes are HR-owned job data too:
                read-only here (QA-10), rendered only when classified (the
                hireDate/employmentStatus conditional pattern — "" stays
                silent, never fabricated). */}
            {profile !== "none" && profile.grade ? (
              <span className="text-sm text-muted-foreground" data-testid="ro-grade">Grade {profile.grade}</span>
            ) : null}
            {profile !== "none" && profile.employmentType ? (
              <span className="text-sm text-muted-foreground" data-testid="ro-employment-type">
                {employmentTypeLabel(profile.employmentType)}
              </span>
            ) : null}
            {profile !== "none" && profile.branch ? (
              <span className="text-sm text-muted-foreground" data-testid="ro-branch">{profile.branch}</span>
            ) : null}
            {/* F1.6 — employment status is HR-owned, shown read-only like the
                rest of the job-data strip ("" stays silent until HR asserts). */}
            {profile !== "none" && profile.employmentStatus ? (
              <span className="text-sm text-muted-foreground" data-testid="ro-employment-status">
                {EMPLOYMENT_STATUS_LABELS[profile.employmentStatus]}
                {profile.employmentStatus === "PROBATION" && profile.probationEndsAt
                  ? ` — ends ${profile.probationEndsAt}`
                  : ""}
              </span>
            ) : null}
          </div>
          <Field label="Phone">
            <input className="f-input" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} placeholder="+64 21 555 0123" />
          </Field>
          <Field label="Location">
            <input className="f-input" value={location} maxLength={100} onChange={(e) => setLocation(e.target.value)} placeholder="Auckland, NZ" />
          </Field>
          <Field label="Emergency contact">
            <input className="f-input" value={ecName} maxLength={100} onChange={(e) => setEcName(e.target.value)} placeholder="Name" />
          </Field>
          <Field label="Emergency contact phone">
            <input className="f-input" value={ecPhone} maxLength={40} onChange={(e) => setEcPhone(e.target.value)} placeholder="+64 21 555 0199" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Skills (comma-separated)">
              <input className="f-input" value={skills} maxLength={500} onChange={(e) => setSkills(e.target.value)} placeholder="React, TypeScript, Design systems" />
            </Field>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between mt-4 gap-3">
        {profile !== null && profile !== "none" && profile.managerName ? (
          <span className="text-xs text-muted-foreground">Reports to {profile.managerName}</span>
        ) : <span />}
        <button
          className="f-btn f-btn-primary f-btn-sm"
          disabled={busy || profile === null}
          onClick={async () => {
            setBusy(true);
            const res = await upsertMyProfile({
              phone, location,
              emergencyContactName: ecName, emergencyContactPhone: ecPhone, skills,
            });
            setBusy(false);
            if (res.ok) {
              toast.success("Employee profile saved");
              await load();
            } else {
              toast.error(res.error);
            }
          }}
        >
          {busy ? "Saving…" : "Save employee profile"}
        </button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Directory tab (HR console)
// ---------------------------------------------------------------------------

export function DirectoryTab() {
  const [profiles, setProfiles] = useState<EmployeeProfileT[] | null>(null);
  const [canAdmin, setCanAdmin] = useState(false);
  // P33 (EM-B02) — the retirement-age display knob rides the directory
  // load (null = not configured → the modal renders no projection).
  const [retirementAge, setRetirementAge] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  // P34 (EM-03) — the org-slicing filter chips: department, employment
  // type, grade and branch (the benchmark's "grouping axes — org slicing
  // everywhere" key feature, on the ONE employee list Fernly has). "" = All;
  // picking a value slices the roster to exact matches (unclassified
  // members surface only under All — honest slicing, not silent defaults).
  const [filterDepartment, setFilterDepartment] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterGrade, setFilterGrade] = useState("");
  const [filterBranch, setFilterBranch] = useState("");
  const [editing, setEditing] = useState<EmployeeProfileT | null>(null);
  // P33 (EM-06/EM-01) — the promotion/transfer modal's subject.
  const [changing, setChanging] = useState<EmployeeProfileT | null>(null);
  // P32 (EM-R02) — the employee_information export's busy flag.
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    const res = await getDirectory();
    if (res.ok) {
      setProfiles(res.data.profiles);
      setCanAdmin(res.data.canAdmin);
      setRetirementAge(res.data.retirementAge);
    } else {
      toast.error(res.error);
      setProfiles([]);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    if (!profiles) return [];
    return profiles.filter((p) =>
      (!filterDepartment || p.department === filterDepartment) &&
      (!filterType || p.employmentType === filterType) &&
      (!filterGrade || p.grade === filterGrade) &&
      (!filterBranch || p.branch === filterBranch)
    ).filter((p) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return [
        p.name, p.email, p.jobTitle, p.department, p.location, p.skills,
        p.grade, p.employmentType, p.branch,
      ].join(" ").toLowerCase().includes(q);
    });
  }, [profiles, query, filterDepartment, filterType, filterGrade, filterBranch]);

  // The free-form axes' chip options are the roster's own distinct values
  // (sorted, deduped) — a workspace names its own grades and offices.
  const gradeOptions = useMemo(
    () => Array.from(new Set((profiles ?? []).map((p) => p.grade).filter(Boolean))).sort(),
    [profiles],
  );
  const branchOptions = useMemo(
    () => Array.from(new Set((profiles ?? []).map((p) => p.branch).filter(Boolean))).sort(),
    [profiles],
  );

  // P32 (EM-R02) — the employee_information report CSV (the analytics Blob
  // pattern; the action builds the RFC 4180 file and audits the export like
  // every report CSV).
  const exportCsv = async () => {
    setExporting(true);
    const res = await exportDirectoryCsv();
    setExporting(false);
    if (!res.ok) { toast.error(res.error); return; }
    const blob = new Blob([res.data.csv], { type: res.data.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.data.filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Employee information report exported (${res.data.filename}).`);
  };

  if (profiles === null) {
    return <div className="p-6 text-sm text-muted-foreground">Loading directory…</div>;
  }

  return (
    <div className="space-y-3" data-testid="hr-directory">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            className="f-input pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, title, skill, location…"
            aria-label="Search directory"
          />
        </div>
        <span className="text-xs text-muted-foreground">{visible.length} of {profiles.length} people</span>
        <button
          type="button"
          className="f-btn f-btn-secondary f-btn-sm"
          onClick={exportCsv}
          disabled={exporting}
          data-testid="directory-export"
          aria-label="Export the employee information report as CSV"
        >
          {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          Export CSV
        </button>
      </div>

      {/* P34 (EM-03) — the org-slicing filter chips: one select per grouping
          axis. Grade/branch options come from the roster itself (a workspace
          names its own ladder and offices); unclassified members surface only
          under "All axes". Combined with the text search they narrow the same
          visible list (the count line above always tells the truth). */}
      <div className="flex flex-wrap items-center gap-2" data-testid="directory-filter-chips">
        <select
          className="f-input h-8 max-w-[150px] text-xs"
          value={filterDepartment}
          onChange={(e) => setFilterDepartment(e.target.value)}
          aria-label="Filter by department"
          data-testid="directory-filter-department"
        >
          <option value="">All departments</option>
          {DEPARTMENT_LABELS.map((d) => (
            <option key={d.key} value={d.key}>{d.label}</option>
          ))}
        </select>
        <select
          className="f-input h-8 max-w-[150px] text-xs"
          value={filterType}
          onChange={(e) => setFilterType(e.target.value)}
          aria-label="Filter by employment type"
          data-testid="directory-filter-employment-type"
        >
          <option value="">All types</option>
          {EMPLOYMENT_TYPE_LABELS.map((t) => (
            <option key={t.key} value={t.key}>{t.label}</option>
          ))}
        </select>
        <select
          className="f-input h-8 max-w-[150px] text-xs"
          value={filterGrade}
          onChange={(e) => setFilterGrade(e.target.value)}
          aria-label="Filter by grade"
          data-testid="directory-filter-grade"
          disabled={gradeOptions.length === 0}
        >
          <option value="">All grades</option>
          {gradeOptions.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
        <select
          className="f-input h-8 max-w-[170px] text-xs"
          value={filterBranch}
          onChange={(e) => setFilterBranch(e.target.value)}
          aria-label="Filter by branch"
          data-testid="directory-filter-branch"
          disabled={branchOptions.length === 0}
        >
          <option value="">All branches</option>
          {branchOptions.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        {(filterDepartment || filterType || filterGrade || filterBranch) && (
          <button
            type="button"
            className="f-btn f-btn-ghost f-btn-sm text-xs"
            onClick={() => {
              setFilterDepartment("");
              setFilterType("");
              setFilterGrade("");
              setFilterBranch("");
            }}
            data-testid="directory-filter-clear"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {visible.map((p) => (
          <div key={p.id} className="f-card p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar name={p.name} color="forest" size={36} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate" data-testid="directory-name">{p.name}</div>
                  {p.employeeNumber && (
                    <div className="text-[0.625rem] font-mono text-muted-foreground" data-testid="directory-emp-no">{p.employeeNumber}</div>
                  )}
                  <div className="text-[0.6875rem] text-muted-foreground truncate">{p.jobTitle || "—"}</div>
                </div>
              </div>
              {canAdmin && (
                <div className="flex items-center gap-1 shrink-0">
                  {/* P33 (EM-06/EM-01) — the effective-dated promotion/transfer
                      writer (structured property history + structure revision). */}
                  <button
                    className="f-btn f-btn-ghost f-btn-sm"
                    onClick={() => setChanging(p)}
                    aria-label={`Promote or transfer ${p.name}`}
                    data-testid="directory-promote"
                  >
                    <ArrowUpRight size={12} />
                  </button>
                  <button className="f-btn f-btn-ghost f-btn-sm" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}'s profile`}>
                    <Pencil size={12} />
                  </button>
                </div>
              )}
            </div>
            <div className="mt-3 space-y-1 text-[0.6875rem] text-muted-foreground">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="font-medium text-foreground/70">Employment:</span>
                {/* F1.6 — "" renders as "Not set" until HR classifies (QA-19). */}
                <span
                  className={cn("inline-flex px-2 py-0.5 rounded text-[0.6875rem] font-medium", EMPLOYMENT_STATUS_BADGE[p.employmentStatus])}
                  data-testid="employment-status"
                >
                  {EMPLOYMENT_STATUS_LABELS[p.employmentStatus]}
                </span>
                {p.employmentStatus === "PROBATION" && p.probationEndsAt ? (
                  <span>ends {p.probationEndsAt}</span>
                ) : null}
              </div>
              <div><span className="font-medium text-foreground/70">Department:</span> {p.department ? DEPARTMENT_LABELS.find((d) => d.key === p.department)?.label ?? p.department : "—"}</div>
              {/* P34 (EM-03) — the grouping axes on the card, rendered only
                  when classified (the skills-line pattern: "" stays silent,
                  the edit modal shows "—"). */}
              {p.grade && <div data-testid="directory-grade"><span className="font-medium text-foreground/70">Grade:</span> {p.grade}</div>}
              {p.employmentType && (
                <div data-testid="directory-employment-type">
                  <span className="font-medium text-foreground/70">Type:</span> {employmentTypeLabel(p.employmentType)}
                </div>
              )}
              {p.branch && <div data-testid="directory-branch"><span className="font-medium text-foreground/70">Branch:</span> {p.branch}</div>}
              <div><span className="font-medium text-foreground/70">Manager:</span> {p.managerName ?? "—"}</div>
              <div><span className="font-medium text-foreground/70">Location:</span> {p.location || "—"}</div>
              {p.skills && <div className="truncate"><span className="font-medium text-foreground/70">Skills:</span> {p.skills}</div>}
            </div>
            <div className="mt-2">
              <RoleBadge role={p.role as never} />
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <div className="f-card p-6 text-sm text-muted-foreground md:col-span-2 xl:col-span-3">No profiles match this search.</div>
        )}
      </div>

      <EditProfileModal
        profile={editing}
        roster={(profiles ?? []).map((p) => ({ userId: p.userId, name: p.name }))}
        retirementAge={retirementAge}
        onClose={() => setEditing(null)}
        // No bumpRefresh here: it remounts the HR console and flips the
        // active tab back to Requests — the directory reload suffices.
        onSaved={load}
      />

      {/* P33 (EM-06/EM-01) — the promotion/transfer writer. */}
      <EmploymentChangeModal
        profile={changing}
        roster={(profiles ?? []).map((p) => ({ userId: p.userId, name: p.name }))}
        onClose={() => setChanging(null)}
        onSaved={load}
      />
    </div>
  );
}

function EditProfileModal({
  profile, roster, retirementAge, onClose, onSaved,
}: {
  profile: EmployeeProfileT | null;
  /** S14 — the roster feeds the leave-approver override picker. */
  roster: { userId: string; name: string }[];
  /** P33 (EM-B02) — the retirement-age display knob (null = not
   * configured → no projection line). */
  retirementAge: number | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [jobTitle, setJobTitle] = useState("");
  const [department, setDepartment] = useState("ENGINEERING");
  // P34 (EM-03) — the grouping axes ("" = unclassified, QA-19).
  const [grade, setGrade] = useState("");
  const [employmentType, setEmploymentType] = useState("");
  const [branch, setBranch] = useState("");
  // P25 (PL-02) — the birthday engine's input ("" = not on file).
  const [birthDate, setBirthDate] = useState("");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [ecName, setEcName] = useState("");
  const [ecPhone, setEcPhone] = useState("");
  const [skills, setSkills] = useState("");
  const [notes, setNotes] = useState("");
  // F1.6 — employment lifecycle: the status select holds the CURRENT value
  // plus the machine's legal targets (illegal moves never render); picking a
  // new one routes the save through the guarded transitionEmployment action
  // BEFORE the plain profile fields save.
  const [employmentStatus, setEmploymentStatus] = useState<EmploymentStatus>("");
  const [probationEndsAt, setProbationEndsAt] = useState("");
  const [noticeWeeks, setNoticeWeeks] = useState("");
  const [lastWorkingDay, setLastWorkingDay] = useState("");
  // S14 — the leave-approver override ("" = the reporting-manager rule).
  const [leaveApproverId, setLeaveApproverId] = useState("");
  const [busy, setBusy] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (profile) {
      setJobTitle(profile.jobTitle);
      setDepartment(profile.department);
      setGrade(profile.grade);
      setEmploymentType(profile.employmentType);
      setBranch(profile.branch);
      setBirthDate(profile.birthDate ?? "");
      setPhone(profile.phone);
      setLocation(profile.location);
      setEcName(profile.emergencyContactName);
      setEcPhone(profile.emergencyContactPhone);
      setSkills(profile.skills);
      setNotes(profile.notes);
      setEmploymentStatus(profile.employmentStatus);
      setProbationEndsAt(profile.probationEndsAt ?? "");
      setNoticeWeeks(profile.noticePeriodWeeks != null ? String(profile.noticePeriodWeeks) : "");
      setLastWorkingDay(profile.lastWorkingDay ?? "");
      setLeaveApproverId(profile.leaveApproverId ?? "");
    }
  }, [profile]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!profile) return null;

  // Current status + its legal targets only — a pick from this list is
  // always a legal transition; everything else (incl. un-classifying to "")
  // is not offered.
  const statusOptions: EmploymentStatus[] = [
    profile.employmentStatus,
    ...EMPLOYMENT_STATUS_TRANSITIONS[profile.employmentStatus],
  ];
  const statusChanged = employmentStatus !== profile.employmentStatus;

  return (
    <Modal open={Boolean(profile)} onClose={onClose} title={`Edit ${profile.name}'s profile`}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          // F1.6 — a changed status goes through the GUARDED transition
          // (machine + §9.3 probation-review hard gate + audit) first; the
          // gate's refusal surfaces as a toast and stops the save.
          if (statusChanged) {
            const tRes = await transitionEmployment(profile.userId, {
              target: employmentStatus as "PROBATION" | "ACTIVE" | "SUSPENDED" | "EXITED",
              probationEndsAt: probationEndsAt || null,
              lastWorkingDay: lastWorkingDay || null,
            });
            if (!tRes.ok) {
              setBusy(false);
              toast.error(tRes.error);
              return;
            }
          }
          const res = await updateProfileAsAdmin(profile.userId, {
            jobTitle, department, grade, employmentType, branch, phone, location,
            birthDate: birthDate || null,
            emergencyContactName: ecName, emergencyContactPhone: ecPhone, skills, notes,
            probationEndsAt: probationEndsAt || null,
            noticePeriodWeeks: noticeWeeks === "" ? null : Number(noticeWeeks),
            lastWorkingDay: lastWorkingDay || null,
            leaveApproverId: leaveApproverId || null,
          });
          setBusy(false);
          if (res.ok) {
            toast.success("Profile updated");
            onClose();
            await onSaved();
          } else {
            toast.error(res.error);
          }
        }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Job title">
            <input className="f-input" value={jobTitle} maxLength={100} onChange={(e) => setJobTitle(e.target.value)} />
          </Field>
          <Field label="Department">
            <select className="f-input" value={department} onChange={(e) => setDepartment(e.target.value)}>
              {/* QA-19: "" = not classified yet — saving without picking one
                  must not fabricate a department (it used to stamp
                  "ENGINEERING" on the create branch). */}
              <option value="">— Not set —</option>
              {DEPARTMENT_LABELS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </Field>
          {/* P34 (EM-03) — the grouping axes. Grade is the free-form ladder
              string (the Employee Grade master, EM-09, stays a later epic);
              "" = ungraded. Branch is a plain string ("" = unset). */}
          <Field label="Grade">
            <input
              className="f-input"
              value={grade}
              maxLength={64}
              placeholder="e.g. L4"
              data-testid="edit-grade-input"
              onChange={(e) => setGrade(e.target.value)}
            />
          </Field>
          <Field label="Employment type">
            <select
              className="f-input"
              value={employmentType}
              data-testid="edit-employment-type-select"
              onChange={(e) => setEmploymentType(e.target.value)}
            >
              <option value="">— Not set —</option>
              {EMPLOYMENT_TYPE_LABELS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Branch">
            <input
              className="f-input"
              value={branch}
              maxLength={64}
              placeholder="e.g. Auckland HQ"
              data-testid="edit-branch-input"
              onChange={(e) => setBranch(e.target.value)}
            />
          </Field>
          <Field label="Phone">
            <input className="f-input" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          {/* P25 (PL-02) — the birthday reminder engine's input (date-only;
            the roster never displays the year, the engine compares month+day). */}
          <Field label="Birthday">
            <input
              className="f-input"
              type="date"
              value={birthDate}
              data-testid="birth-date-input"
              onChange={(e) => setBirthDate(e.target.value)}
            />
          </Field>
          {/* P33 (EM-B02) — the retirement-age display field (the benchmark's
              retirement_date projection): birthDate + the workspace's
              retirement age. Rendered ONLY when both exist — no birthday on
              file or no configured age renders no line (never a fabricated
              projection). Display-only: nothing gates on it. */}
          {(() => {
            const projection = retirementProjection({
              birthDate: profile.birthDate ?? null,
              retirementAge,
            });
            return projection ? (
              <div
                className="sm:col-span-2 text-[0.6875rem] text-muted-foreground"
                data-testid="retirement-projection"
              >
                Projected retirement: <span className="font-medium text-foreground">{projection.monthLabel} {projection.year}</span>{" "}
                (at age {retirementAge}) — display only, nothing gates on it.
              </div>
            ) : null;
          })()}
          <Field label="Location">
            <input className="f-input" value={location} maxLength={100} onChange={(e) => setLocation(e.target.value)} />
          </Field>
          <Field label="Emergency contact">
            <input className="f-input" value={ecName} maxLength={100} onChange={(e) => setEcName(e.target.value)} />
          </Field>
          <Field label="Emergency contact phone">
            <input className="f-input" value={ecPhone} maxLength={40} onChange={(e) => setEcPhone(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Skills (comma-separated)">
              <input className="f-input" value={skills} maxLength={500} onChange={(e) => setSkills(e.target.value)} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="HR notes (HR/admin only)">
              <textarea className="f-input min-h-20" value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} placeholder="Visible to HR and admins only" />
            </Field>
          </div>

          {/* F1.6 — Employment section. LAST in the form so the modal's
              first input stays the job title (an e2e step relies on it). */}
          <div className="sm:col-span-2 rounded-lg border border-border bg-muted/30 p-3 space-y-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Employment</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Status">
                <select
                  className="f-input"
                  value={employmentStatus}
                  data-testid="employment-status-select"
                  onChange={(e) => setEmploymentStatus(e.target.value as EmploymentStatus)}
                >
                  {statusOptions.map((s) => (
                    <option key={s || "not-set"} value={s}>
                      {s === "" ? "— Not set —" : EMPLOYMENT_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Notice period (weeks)">
                <input
                  className="f-input"
                  type="number"
                  min={0}
                  max={52}
                  value={noticeWeeks}
                  data-testid="notice-weeks-input"
                  onChange={(e) => setNoticeWeeks(e.target.value)}
                  placeholder="e.g. 4"
                />
              </Field>
              <Field label="Probation ends">
                <input
                  className="f-input"
                  type="date"
                  value={probationEndsAt}
                  data-testid="probation-ends-input"
                  onChange={(e) => setProbationEndsAt(e.target.value)}
                />
              </Field>
              <Field label="Last working day">
                <input
                  className="f-input"
                  type="date"
                  value={lastWorkingDay}
                  data-testid="last-working-day-input"
                  onChange={(e) => setLastWorkingDay(e.target.value)}
                />
              </Field>
            </div>
            {/* S14 (EM-B04/LV-B13) — the leave-approver override: the chosen
                member decides this employee's leave (and is notified)
                instead of the reporting manager. Empty = the manager rule. */}
            <Field label="Leave approver (overrides the reporting manager)">
              <select
                className="f-input"
                value={leaveApproverId}
                data-testid="leave-approver-select"
                onChange={(e) => setLeaveApproverId(e.target.value)}
              >
                <option value="">Reporting manager decides (default)</option>
                {roster
                  .filter((r) => r.userId !== profile?.userId)
                  .map((r) => (
                    <option key={r.userId} value={r.userId}>{r.name}</option>
                  ))}
              </select>
            </Field>
            {statusChanged && employmentStatus === "ACTIVE" && profile.employmentStatus === "PROBATION" ? (
              <div className="text-[0.6875rem] text-muted-foreground" data-testid="probation-gate-hint">
                Confirmation requires the probation review to be completed first — it will be refused while the cycle is outstanding.
              </div>
            ) : null}
            {statusChanged && employmentStatus === "EXITED" ? (
              <div className="text-[0.6875rem] text-muted-foreground">
                Recording an exit requires a last working day.
              </div>
            ) : null}
          </div>
        </div>
        {/* P33 (EM-06) — the structured employment-changes panel (the
            benchmark's Employee Property History child under the Employee
            form): lazy, collapsed by default, one row per changed property. */}
        <EmploymentChangesSection userId={profile.userId} userName={profile.name} />
        <div className="flex justify-end gap-2">
          <button type="button" className="f-btn f-btn-ghost f-btn-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className="f-btn f-btn-primary f-btn-sm" disabled={busy}>
            {busy ? "Saving…" : "Save profile"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
