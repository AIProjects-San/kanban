"use client";

import {
  Shield, ShieldCheck, ShieldAlert, ShieldX,
  UserCog,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app-store";
import {
  type Role,
  ROLE_LABELS, ROLE_DESCRIPTIONS, ALL_PERMISSIONS,
  hasPermission,
} from "@/lib/rbac";
import { RoleBadge } from "../fernly/role-badge";
import { Section } from "../fernly/section";

interface RbacViewProps {
  currentUser: { id: string; name: string; email: string; role: string };
}

export function RbacView({ currentUser }: RbacViewProps) {
  const role = currentUser.role as Role;
  const canManageRoles = hasPermission(role, "role:manage");

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Shield size={22} className="text-primary" />
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Roles & Permissions</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          You are signed in as <span className="font-semibold text-foreground">{currentUser.name}</span> with role{" "}
          <RoleBadge role={role} />
        </p>
      </div>

      {/* Your role card */}
      <div className="f-card p-6">
        <div className="flex items-start gap-4">
          <RoleIcon role={role} size={24} />
          <div className="flex-1">
            <h2 className="text-base font-semibold text-foreground">
              {ROLE_LABELS[role]} <span className="text-xs font-normal text-muted-foreground">(your role)</span>
            </h2>
            <p className="text-sm text-muted-foreground mt-1">{ROLE_DESCRIPTIONS[role]}</p>
          </div>
        </div>
      </div>

      {/* Permission matrix — collapsible */}
      <Section
        icon={ShieldCheck}
        title="Permission matrix"
        description={`${ALL_PERMISSIONS.length} permissions across ${ROLE_LABELS.ADMIN}, ${ROLE_LABELS.MANAGER}, and ${ROLE_LABELS.MEMBER} roles`}
        collapsible
        defaultOpen={false}
      >
        <div className="overflow-x-auto f-scroll">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-4 font-medium text-muted-foreground text-xs uppercase tracking-wider">
                  Permission
                </th>
                {(["ADMIN", "MANAGER", "MEMBER"] as Role[]).map((r) => (
                  <th
                    key={r}
                    className={cn(
                      "py-2 px-3 text-center font-medium text-xs uppercase tracking-wider min-w-[90px]",
                      r === role ? "text-primary" : "text-muted-foreground"
                    )}
                  >
                    {ROLE_LABELS[r]}
                    {r === role && <div className="text-[0.625rem] font-normal text-primary mt-0.5">(you)</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ALL_PERMISSIONS.map((perm) => (
                <tr key={perm.key} className="border-b border-border last:border-0">
                  <td className="py-2.5 pr-4">
                    <div className="text-sm font-medium text-foreground">{perm.label}</div>
                    <div className="text-[0.6875rem] text-muted-foreground">{perm.description}</div>
                  </td>
                  {(["ADMIN", "MANAGER", "MEMBER"] as Role[]).map((r) => {
                    const allowed = hasPermission(r, perm.key);
                    return (
                      <td key={r} className="py-2.5 px-3 text-center">
                        {allowed ? (
                          <ShieldCheck size={16} className={cn("inline", r === role ? "text-primary" : "text-success")} />
                        ) : (
                          <ShieldX size={16} className="inline text-muted-foreground/40" />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* People & role management — links to the dedicated Users view */}
      {canManageRoles ? (
        <div className="f-card p-6">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <UserCog size={18} className="text-primary" />
            </div>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-foreground">People & role management</h2>
              <p className="text-xs text-muted-foreground mt-0.5 mb-3">
                Create users, change roles, assign projects, and manage login accounts — all in one place.
              </p>
              <button
                onClick={() => useApp.getState().setView("users")}
                className="f-btn f-btn-primary f-btn-sm"
              >
                <UserCog size={14} /> Open User Management
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="f-card p-6 border-dashed">
          <div className="flex items-center gap-3 text-muted-foreground">
            <ShieldAlert size={20} />
            <div>
              <div className="text-sm font-medium text-foreground">Role management locked</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                Your role ({ROLE_LABELS[role]}) does not have permission to manage user roles.
                Only Admins can change roles.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function RoleIcon({ role, size = 24 }: { role: Role; size?: number }) {
  const icons: Record<Role, React.ComponentType<{ size?: number; className?: string }>> = {
    ADMIN: ShieldAlert,
    MANAGER: ShieldCheck,
    MEMBER: Shield,
  };
  const colors: Record<Role, string> = {
    ADMIN: "text-destructive bg-destructive/10",
    MANAGER: "text-primary bg-primary/10",
    MEMBER: "text-muted-foreground bg-muted",
  };
  const Icon = icons[role];
  return (
    <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center", colors[role])}>
      <Icon size={size} />
    </div>
  );
}
