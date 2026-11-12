"use client";

import {
  Shield, ShieldCheck, ShieldAlert, ShieldX,
  UserCog, HeartHandshake, Crown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app-store";
import {
  type Role,
  ROLE_LABELS, ROLE_DESCRIPTIONS, ALL_PERMISSIONS,
  hasPermission,
} from "@/lib/rbac";
import { Section } from "../ui/section";

/**
 * Embedded RBAC view — used as a tab inside the Users page.
 * Same content as the standalone RbacView but without the page-level header
 * (the parent Users view provides the header + tab bar).
 */
export function RbacView({ currentUser }: { currentUser: { id: string; name: string; email: string; role: string } }) {
  const role = currentUser.role as Role;
  const canManageRoles = hasPermission(role, "role:manage");

  return (
    <div className="space-y-5">
      {/* Your role card */}
      <div className="f-card p-6">
        <div className="flex items-start gap-4">
          <RoleIcon role={role} size={24} />
          <div className="flex-1">
            <h2 className="text-base font-semibold text-foreground">
              {ROLE_LABELS[role]} <span className="text-xs font-normal text-muted-foreground">(your role)</span>
            </h2>
            <p className="text-sm text-muted-foreground mt-1">{ROLE_DESCRIPTIONS[role]}</p>
            <p className="text-xs text-muted-foreground mt-2">
              You are signed in as <span className="font-semibold text-foreground">{currentUser.name}</span>
            </p>
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

      {/* Workspace Config link */}
      {canManageRoles ? (
        <div className="f-card p-6">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <UserCog size={18} className="text-primary" />
            </div>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-foreground">Advanced role configuration</h2>
              <p className="text-xs text-muted-foreground mt-0.5 mb-3">
                Create custom roles, edit the permission matrix, and configure workspace defaults in the Workspace Config page.
              </p>
              <button
                onClick={() => useApp.getState().setView("workspace-settings")}
                className="f-btn f-btn-primary f-btn-sm"
              >
                <UserCog size={14} /> Open Workspace Config
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

function RoleIcon({ role, size = 24 }: { role: Role; size?: number }) {
  const icons: Record<Role, React.ComponentType<{ size?: number; className?: string }>> = {
    SUPER_ADMIN: Crown,
    ADMIN: ShieldAlert,
    MANAGER: ShieldCheck,
    MEMBER: Shield,
    HR: HeartHandshake,
  };
  const colors: Record<Role, string> = {
    SUPER_ADMIN: "text-violet-600 bg-violet-500/10",
    ADMIN: "text-destructive bg-destructive/10",
    MANAGER: "text-primary bg-primary/10",
    MEMBER: "text-muted-foreground bg-muted",
    HR: "text-pink-600 bg-pink-500/10",
  };
  const Icon = icons[role];
  return (
    <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center", colors[role])}>
      <Icon size={size} />
    </div>
  );
}
