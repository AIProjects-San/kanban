"use client";
import { useState, useEffect } from "react";
import { Loader2, KeyRound, UserPlus } from "lucide-react";
import { Modal } from "./modal";
import { useApp } from "@/store/app-store";
import {
  createUser,
  updateUser,
  deleteUser,
  getAllUsers } from "@/server-actions/data";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ROLE_LABELS, type Role } from "@/lib/rbac";
import { EntityHistorySection } from "./entity-history-section";
import { Field, FormRow } from "./field";
import { FormActions } from "./form-actions";
import { PasswordInput, generatePassword } from "./password-input";
import { AvatarColorPicker } from "./avatar-color-picker";
import { TIMEZONES, DEPARTMENTS } from "@/lib/constants";
import type { AccentTheme } from "@/store/app-store";

interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  managerId: string | null;
  managerName: string | null;
}

/**
 * The modal is rendered once at the AppShell level and fetches the editing
 * target's data on its own when an editId is set — this way it doesn't need
 * the full user list passed down as a prop.
 */
export function UserModal() {
  const { userModalOpen, userModalEditId, closeUserModal } = useApp();
  const [editing, setEditing] = useState<UserRecord | null>(null);
  const [loadingTarget, setLoadingTarget] = useState(false);
  // All users — needed to populate the "Reports to" dropdown. Fetched once
  // per modal open and shared by both create and edit modes.
  const [allUsers, setAllUsers] = useState<UserRecord[]>([]);

  useEffect(() => {
    if (!userModalOpen) return;
    let cancelled = false;
    getAllUsers()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setAllUsers(res.data);
      })
      .catch(() => { /* best-effort — dropdown will be empty */ });
    return () => { cancelled = true; };
  }, [userModalOpen]);

  useEffect(() => {
    if (!userModalOpen || !userModalEditId) {
      return;
    }
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoadingTarget(true);
    });
    getAllUsers()
      .then((res) => {
        if (cancelled) return;
        const found = res.ok ? res.data.find((u) => u.id === userModalEditId) ?? null : null;
        setEditing(found);
      })
      .catch(() => {
        if (!cancelled) setEditing(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingTarget(false);
      });
    return () => { cancelled = true; };
  }, [userModalOpen, userModalEditId]);

  return (
    <Modal
      open={userModalOpen}
      onClose={closeUserModal}
      title={editing ? "Edit user" : "Create user"}
      description={editing ? "Update user details and login credentials" : "Create a new user with login access"}
      size="md"
    >
      {userModalOpen && (
        userModalEditId && loadingTarget
          ? <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Loading user…
            </div>
          : <UserForm
              key={editing?.id ?? "new"}
              editing={editing}
              allUsers={allUsers}
              onClose={closeUserModal}
            />
      )}
    </Modal>
  );
}

function UserForm({
  editing,
  allUsers,
  onClose,
}: {
  editing: UserRecord | null;
  allUsers: UserRecord[];
  onClose: () => void;
}) {
  const { bumpRefresh } = useApp();
  const [name, setName] = useState(editing?.name ?? "");
  const [email, setEmail] = useState(editing?.email ?? "");
  const [role, setRole] = useState<Role>((editing?.role as Role) ?? "MEMBER");
  const [timezone, setTimezone] = useState("Pacific/Auckland");
  const [bio, setBio] = useState("");
  const [avatarColor, setAvatarColor] = useState<AccentTheme>("forest");
  const [department, setDepartment] = useState("ENGINEERING");
  const [jobTitle, setJobTitle] = useState("Team Member");
  // "Reports to" — the user's manager in the org chart. null = root
  // (workspace owner / unmanaged). When editing, the existing managerId
  // is the initial value; when creating, default to no manager.
  const [managerId, setManagerId] = useState<string | null>(editing?.managerId ?? null);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function handleGeneratePassword() {
    const pw = generatePassword();
    setPassword(pw);
    toast.success("Generated a strong password", { description: pw });
  }

  async function submit() {
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (!email.trim()) { toast.error("Email is required"); return; }
    if (!editing && (!password || password.length < 8)) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const res = await updateUser(editing.id, {
          name, email, role, timezone, bio, avatarColor, department, jobTitle,
          managerId,
          resetPassword: password || undefined,
        });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success("User updated");
      } else {
        const res = await createUser({
          name, email, password, role, timezone, bio, avatarColor, department, jobTitle,
          managerId,
        });
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success("User created", {
          description: `${name} can now sign in with ${email}`,
        });
      }
      bumpRefresh();
      onClose();
    } catch {
      toast.error("Failed to save user");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!editing) return;
    setDeleting(true);
    try {
      const res = await deleteUser(editing.id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("User deleted");
      bumpRefresh();
      onClose();
    } catch {
      toast.error("Failed to delete user");
    } finally {
      setDeleting(false);
    }
  }

  // Build the "Reports to" dropdown options. Exclude the user being edited
  // (cannot be your own manager). For new users there's no id yet so the
  // list is the full directory.
  const managerOptions = allUsers.filter((u) => u.id !== editing?.id);

  return (
    <div className="space-y-4">
      {/* Identity */}
      <div className="flex items-start gap-4">
        <div className={cn("w-14 h-14 rounded-full flex items-center justify-center text-white text-lg font-bold f-avatar", `f-avatar-${avatarColor}`)}>
          {(name || "?").slice(0, 2).toUpperCase()}
        </div>
        <div className="flex-1">
          <label className="block text-xs font-medium text-foreground mb-1.5">Avatar color</label>
          <AvatarColorPicker value={avatarColor} onChange={setAvatarColor} />
        </div>
      </div>

      <FormRow>
        <Field label="Full name">
          <input className="f-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" />
        </Field>
        <Field label="Email (login)">
          <input className="f-input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@fernly.app" type="email" />
        </Field>
      </FormRow>

      <FormRow>
        <Field label="Role">
          <select className="f-input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="ADMIN">Admin — full access</option>
            <option value="MANAGER">Manager — create & edit</option>
            <option value="MEMBER">Member — own tasks only</option>
          </select>
        </Field>
        <Field label="Reports to" hint="Who this user reports to in the org chart">
          <select
            className="f-input"
            value={managerId ?? ""}
            onChange={(e) => setManagerId(e.target.value || null)}
          >
            <option value="">— No manager (root) —</option>
            {managerOptions.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role})
              </option>
            ))}
          </select>
        </Field>
      </FormRow>

      <FormRow>
        <Field label="Timezone">
          <select className="f-input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </Field>
        <Field label="Department">
          <select className="f-input" value={department} onChange={(e) => setDepartment(e.target.value)}>
            {DEPARTMENTS.map((d) => <option key={d} value={d}>{d.charAt(0) + d.slice(1).toLowerCase()}</option>)}
          </select>
        </Field>
      </FormRow>

      <Field label="Job title">
        <input className="f-input" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="Senior Engineer" />
      </Field>

      <Field label="Bio">
        <textarea
          className="f-input min-h-[60px] py-2"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder="Optional — shown in the team directory"
        />
      </Field>

      {/* Login credentials — created in the same submit (single click) */}
      <div className="border border-border rounded-lg p-3 bg-muted/30 space-y-2">
        <div className="flex items-center gap-2">
          <KeyRound size={14} className="text-primary" />
          <span className="text-xs font-semibold text-foreground">
            {editing ? "Reset password (optional)" : "Login credentials"}
          </span>
        </div>
        <p className="text-[0.625rem] text-muted-foreground">
          {editing
            ? "Leave blank to keep the current password. Enter a new one to reset."
            : "The login account is created in the same step — no separate setup needed."}
        </p>
        <PasswordInput
          value={password}
          onChange={setPassword}
          placeholder={editing ? "Leave blank to keep current" : "At least 8 characters"}
          onGenerate={handleGeneratePassword}
        />
      </div>

      <FormActions
        editing={!!editing}
        createLabel="Create user"
        editLabel="Save changes"
        saving={saving}
        deleting={deleting}
        onCancel={onClose}
        onSubmit={submit}
        onDelete={remove}
        submitIcon={<UserPlus size={14} />}
      />

      {/* Expandable audit history — only when editing an existing user. */}
      {editing && (
        <EntityHistorySection
          entityType="USER"
          entityId={editing.id}
          entityLabel={editing.name}
        />
      )}
    </div>
  );
}
