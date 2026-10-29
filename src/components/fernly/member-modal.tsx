"use client";
import { useState, useEffect } from "react";
import { Modal } from "./modal";
import { useApp } from "@/store/app-store";
import { createMember, getAllUsers } from "@/server-actions/data";
import { toast } from "sonner";
import { Field, FormRow } from "./field";
import { FormActions } from "./form-actions";
import { Avatar } from "./avatar";
import { Loader2, Plus, Search, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEPARTMENTS } from "@/lib/constants";
import type { Department } from "@/lib/types";

interface ExistingUser {
  id: string;
  email: string;
  name: string;
  role: string;
  avatarColor: string;
}

// ---------------------------------------------------------------------------
// MemberModal — "Pick an existing user to add to the team directory"
// ---------------------------------------------------------------------------
// This modal used to have a two-tab interface:
//   1. "Pick existing user" — link a User (who already has a login) into the
//      team directory as a TeamMember row.
//   2. "Create new" — call createMember() directly with name/email/role,
//      creating a TeamMember WITHOUT a User login account.
//
// Tab #2 was the obsolete "old option": it produced team-directory entries
// that could not sign in, could not be granted RBAC permissions, and were
// orphaned from the auth system. The modern, unified flow lives in
// UserModal ("Create user" from the Users page or ⌘K), which mints a real
// login account AND a team-member row in one atomic step. Tab #2 has been
// removed; this modal now only offers the pick-existing-user flow.
//
// Entry point: the "Add Member" button on the Team page header.
// ---------------------------------------------------------------------------

export function MemberModal() {
  const { memberModalOpen, closeMemberModal } = useApp();
  return (
    <Modal
      open={memberModalOpen}
      onClose={closeMemberModal}
      title="Add team member"
      description="Pick an existing user to add to the team directory. To create a brand-new user with a login, use the Users page instead."
      size="md"
    >
      {memberModalOpen && <MemberForm key="pick" onClose={closeMemberModal} />}
    </Modal>
  );
}

function MemberForm({ onClose }: { onClose: () => void }) {
  const { bumpRefresh } = useApp();
  const [existingUsers, setExistingUsers] = useState<ExistingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<ExistingUser | null>(null);

  // Optional metadata for the team-directory row.
  const [role, setRole] = useState("");
  const [department, setDepartment] = useState<Department>("ENGINEERING");

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
    });
    getAllUsers()
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          // Non-admins can't call getAllUsers — surface the error and bail;
          // the modal is admin-only by entry point anyway.
          toast.error(res.error || "Failed to load users");
          return;
        }
        setExistingUsers(res.data.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          avatarColor: u.avatarColor ?? "forest",
        })));
      })
      .catch(() => {
        if (!cancelled) toast.error("Failed to load users");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const filteredUsers = existingUsers.filter((u) => {
    if (query) {
      const q = query.toLowerCase();
      if (!`${u.name} ${u.email}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const submit = async () => {
    if (!selectedUser) {
      toast.error("Pick a user to add to the team");
      return;
    }
    if (!selectedUser.name.trim() || !selectedUser.email.trim()) {
      toast.error("Name and email are required");
      return;
    }
    const res = await createMember({
      name: selectedUser.name.trim(),
      role: role.trim() || "Team Member",
      department,
      email: selectedUser.email.trim(),
      avatarColor: selectedUser.avatarColor,
      online: false,
    });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(`${selectedUser.name} added to the team`);
    bumpRefresh();
    onClose();
  };

  return (
    <div className="space-y-4">
      {/* User picker */}
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

      {/* Optional fields for the picked user */}
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

      <FormActions
        editing={false}
        createLabel="Add to team"
        showDelete={false}
        onCancel={onClose}
        onSubmit={submit}
        submitIcon={<Plus size={14} />}
      />
    </div>
  );
}
