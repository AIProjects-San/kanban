"use client";

import { Shield, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ROLE_LABELS, type Role } from "@/lib/rbac";
import { Avatar } from "./avatar";
import { RoleBadge } from "./role-badge";

/**
 * Shared user row — used by both the Users view and the Roles & Permissions
 * view's people-management section. Shows avatar, name, email, role badge,
 * and an optional role-change dropdown.
 *
 * Props control what's visible:
 *   - `onRoleChange` — if provided, shows a role <select> dropdown
 *   - `extra` — extra content rendered on the right (e.g. "Assign" button)
 *   - `currentUserId` — if the row's userId matches, shows "(you)" and
 *     disables self-role-change (can't demote yourself)
 */
export function UserRow({
  name,
  email,
  avatarColor = "forest",
  role,
  online,
  department,
  roleLabel,
  isYou,
  onRoleChange,
  changingRole,
  extra,
}: {
  name: string;
  email: string;
  avatarColor?: string;
  role: Role | null;
  online?: boolean;
  department?: string;
  roleLabel?: string;
  isYou?: boolean;
  onRoleChange?: (newRole: Role) => void;
  changingRole?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-3 border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
      <Avatar name={name} color={avatarColor} size={36} online={online} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground">{name}</span>
          {isYou && <span className="text-[0.625rem] text-primary">(you)</span>}
          {department && (
            <span className="text-[0.625rem] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {department.charAt(0) + department.slice(1).toLowerCase()}
            </span>
          )}
          {role && <RoleBadge role={role} />}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {email}
          {roleLabel && <span className="text-muted-foreground/60"> · {roleLabel}</span>}
        </div>
      </div>

      {extra}

      {onRoleChange && role && (
        <select
          value={role}
          onChange={(e) => onRoleChange(e.target.value as Role)}
          disabled={changingRole || isYou}
          className="f-input w-28 text-xs h-8"
          title={isYou ? "You cannot change your own role" : "Change role"}
        >
          <option value="ADMIN">Admin</option>
          <option value="MANAGER">Manager</option>
          <option value="MEMBER">Member</option>
        </select>
      )}

      {changingRole && <Loader2 size={12} className="animate-spin text-muted-foreground" />}
    </div>
  );
}
