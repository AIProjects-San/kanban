"use client";
import { useState, useEffect } from "react";
import { Modal } from "./modal";
import { useApp } from "@/store/app-store";
import { createMember, getAllUsers } from "@/server-actions/data";
import { isActionError } from "@/lib/action-errors";
import { toast } from "sonner";
import { Field, FormRow } from "./field";
import { FormActions } from "./form-actions";
import { ProjectColorPicker } from "./avatar-color-picker";
import { DEPARTMENTS } from "@/lib/constants";
import { Avatar } from "./avatar";
import { Loader2, Plus, Search, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Department } from "@/lib/types";

interface ExistingUser {
  id: string;
  email: string;
  name: string;
  role: string;
  avatarColor: string;
}

export function MemberModal() {
  const { memberModalOpen, closeMemberModal } = useApp();
  return (
    <Modal
      open={memberModalOpen}
      onClose={closeMemberModal}
      title="Add team member"
      description="Invite an existing user or create a new team member"
      size="md"
    >
      {memberModalOpen && <MemberForm key="new" onClose={closeMemberModal} />}
    </Modal>
  );
}

function MemberForm({ onClose }: { onClose: () => void }) {
  const { bumpRefresh } = useApp();
  const [mode, setMode] = useState<"pick" | "create">("pick");
  const [existingUsers, setExistingUsers] = useState<ExistingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<ExistingUser | null>(null);

  // Form fields for "create new" mode
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [department, setDepartment] = useState<Department>("ENGINEERING");
  const [email, setEmail] = useState("");
  const [avatarColor, setAvatarColor] = useState("forest");
  const [online, setOnline] = useState(false);

  useEffect(() => {
    if (mode !== "pick") return;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
    });
    getAllUsers()
      .then((users) => {
        if (!cancelled) {
          // Show users that have a login account — they can be added as team members
          setExistingUsers(users.map((u) => ({
            id: u.id,
            email: u.email,
            name: u.name,
            role: u.role,
            avatarColor: u.avatarColor ?? "forest",
          })));
        }
      })
      .catch((e) => {
        if (isActionError(e)) {
          // Non-admins can't call getAllUsers — fall back to create mode
          setMode("create");
        } else {
          toast.error("Failed to load users");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [mode]);

  const filteredUsers = existingUsers.filter((u) => {
    if (query) {
      const q = query.toLowerCase();
      if (!`${u.name} ${u.email}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const submit = async () => {
    if (mode === "pick" && selectedUser) {
      // Add the selected user as a team member
      if (!selectedUser.name.trim() || !selectedUser.email.trim()) {
        toast.error("Name and email are required");
        return;
      }
      await createMember({
        name: selectedUser.name.trim(),
        role: role.trim() || "Team Member",
        department,
        email: selectedUser.email.trim(),
        avatarColor: selectedUser.avatarColor,
        online,
      });
      toast.success(`${selectedUser.name} added to the team`);
      bumpRefresh();
      onClose();
    } else if (mode === "create") {
      if (!name.trim() || !email.trim()) {
        toast.error("Name and email are required");
        return;
      }
      await createMember({
        name: name.trim(),
        role: role.trim() || "Team Member",
        department,
        email: email.trim(),
        avatarColor,
        online,
      });
      toast.success("Team member added");
      bumpRefresh();
      onClose();
    }
  };

  return (
    <div className="space-y-4">
      {/* Mode toggle */}
      <div className="flex items-center gap-1 p-1 bg-muted/60 rounded-lg w-fit">
        <button
          onClick={() => setMode("pick")}
          className={cn(
            "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
            mode === "pick" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          )}
        >
          Pick existing user
        </button>
        <button
          onClick={() => setMode("create")}
          className={cn(
            "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
            mode === "create" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          )}
        >
          Create new
        </button>
      </div>

      {mode === "pick" ? (
        <>
          {/* User picker table */}
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Loading users…
            </div>
          ) : (
            <>
              <div className="relative">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search users…"
                  className="f-input h-9 pl-8 text-sm"
                />
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              </div>
              <div className="max-h-[280px] overflow-y-auto f-scroll border border-border rounded-lg">
                {filteredUsers.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">No users found.</div>
                ) : (
                  filteredUsers.map((u) => (
                    <button
                      key={u.id}
                      onClick={() => {
                        setSelectedUserId(u.id);
                        setSelectedUser(u);
                      }}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 border-b border-border last:border-0 transition-colors text-left",
                        selectedUserId === u.id ? "bg-primary/5" : "hover:bg-muted/30"
                      )}
                    >
                      <Avatar name={u.name} color={u.avatarColor} size={32} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-foreground truncate">{u.name}</div>
                        <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                      </div>
                      <span className="text-[0.625rem] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        {u.role}
                      </span>
                      {selectedUserId === u.id && (
                        <Check size={14} className="text-primary shrink-0" />
                      )}
                    </button>
                  ))
                )}
              </div>
            </>
          )}

          {/* Optional fields for picked user */}
          {selectedUser && (
            <FormRow>
              <Field label="Job title (optional)">
                <input className="f-input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Senior Engineer" />
              </Field>
              <Field label="Department">
                <select className="f-input" value={department} onChange={(e) => setDepartment(e.target.value as Department)}>
                  {DEPARTMENTS.map((d) => <option key={d} value={d}>{d.charAt(0) + d.slice(1).toLowerCase()}</option>)}
                </select>
              </Field>
            </FormRow>
          )}
        </>
      ) : (
        <>
          {/* Create new member form */}
          <FormRow>
            <Field label="Full name">
              <input autoFocus className="f-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan Lee" />
            </Field>
            <Field label="Email">
              <input type="email" className="f-input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jordan@fernly.app" />
            </Field>
          </FormRow>
          <FormRow>
            <Field label="Role">
              <input className="f-input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Senior Engineer" />
            </Field>
            <Field label="Department">
              <select className="f-input" value={department} onChange={(e) => setDepartment(e.target.value as Department)}>
                {DEPARTMENTS.map((d) => <option key={d} value={d}>{d.charAt(0) + d.slice(1).toLowerCase()}</option>)}
              </select>
            </Field>
          </FormRow>
          <Field label="Avatar color">
            <ProjectColorPicker value={avatarColor} onChange={setAvatarColor} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
            <input type="checkbox" checked={online} onChange={(e) => setOnline(e.target.checked)} className="accent-[var(--primary)]" />
            Show as online now
          </label>
        </>
      )}

      <FormActions
        editing={false}
        createLabel={mode === "pick" ? "Add to team" : "Add member"}
        showDelete={false}
        onCancel={onClose}
        onSubmit={submit}
        submitIcon={<Plus size={14} />}
      />
    </div>
  );
}
