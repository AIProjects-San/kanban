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
import { Briefcase, Search, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Section } from "../ui/section";
import { Field } from "../ui/field";
import { Modal } from "../ui/modal";
import { Avatar } from "../ui/avatar";
import { RoleBadge } from "../ui/role-badge";
import { DEPARTMENT_LABELS, departmentLabel } from "@/lib/config";
import type { EmployeeProfileT } from "@/lib/types";
import {
  getMyProfile,
  upsertMyProfile,
  getDirectory,
  updateProfileAsAdmin,
} from "@/server-actions/hr-directory";

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
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<EmployeeProfileT | null>(null);

  const load = useCallback(async () => {
    const res = await getDirectory();
    if (res.ok) {
      setProfiles(res.data.profiles);
      setCanAdmin(res.data.canAdmin);
    } else {
      toast.error(res.error);
      setProfiles([]);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    if (!profiles) return [];
    const q = query.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) =>
      [p.name, p.email, p.jobTitle, p.department, p.location, p.skills]
        .join(" ").toLowerCase().includes(q),
    );
  }, [profiles, query]);

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
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {visible.map((p) => (
          <div key={p.id} className="f-card p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar name={p.name} color="forest" size={36} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-foreground truncate" data-testid="directory-name">{p.name}</div>
                  <div className="text-[0.6875rem] text-muted-foreground truncate">{p.jobTitle || "—"}</div>
                </div>
              </div>
              {canAdmin && (
                <button className="f-btn f-btn-ghost f-btn-sm shrink-0" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}'s profile`}>
                  <Pencil size={12} />
                </button>
              )}
            </div>
            <div className="mt-3 space-y-1 text-[0.6875rem] text-muted-foreground">
              <div><span className="font-medium text-foreground/70">Department:</span> {p.department ? DEPARTMENT_LABELS.find((d) => d.key === p.department)?.label ?? p.department : "—"}</div>
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
        onClose={() => setEditing(null)}
        // No bumpRefresh here: it remounts the HR console and flips the
        // active tab back to Requests — the directory reload suffices.
        onSaved={load}
      />
    </div>
  );
}

function EditProfileModal({
  profile, onClose, onSaved,
}: { profile: EmployeeProfileT | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [jobTitle, setJobTitle] = useState("");
  const [department, setDepartment] = useState("ENGINEERING");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [ecName, setEcName] = useState("");
  const [ecPhone, setEcPhone] = useState("");
  const [skills, setSkills] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (profile) {
      setJobTitle(profile.jobTitle);
      setDepartment(profile.department);
      setPhone(profile.phone);
      setLocation(profile.location);
      setEcName(profile.emergencyContactName);
      setEcPhone(profile.emergencyContactPhone);
      setSkills(profile.skills);
      setNotes(profile.notes);
    }
  }, [profile]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!profile) return null;

  return (
    <Modal open={Boolean(profile)} onClose={onClose} title={`Edit ${profile.name}'s profile`}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const res = await updateProfileAsAdmin(profile.userId, {
            jobTitle, department, phone, location,
            emergencyContactName: ecName, emergencyContactPhone: ecPhone, skills, notes,
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
          <Field label="Phone">
            <input className="f-input" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
          </Field>
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
        </div>
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
