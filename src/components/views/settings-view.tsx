"use client";

import { useState } from "react";
import { Check, Bell, User, Palette, Clock, Lock, Loader2, Download, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp, type AccentTheme } from "@/store/app-store";
import { useRefresh } from "@/hooks/use-refresh";
import { Avatar } from "../ui/avatar";
import { toast } from "sonner";
import { updateProfile, changePassword, updateUserSettings } from "@/server-actions/data";
import { exportMyData } from "@/server-actions/data-export";
import { actionErrorMessage } from "@/lib/action-errors";
import { Section } from "../ui/section";
import { EmployeeProfileSection } from "./hr-directory";
import { MyReviewsSection } from "./hr-reviews";
import { MyOnboardingSection } from "./hr-onboarding";
// P36 (EM-21) — my identification documents (the self-service submission).
import { MyDocumentsSection } from "../ui/employee-documents-panel";
import { Field } from "../ui/field";
import { PasswordInput } from "../ui/password-input";
import { AvatarColorPicker } from "../ui/avatar-color-picker";
import { Toggle } from "../ui/toggle";
import { ACCENTS, TIMEZONES } from "@/lib/constants";
import { APP } from "@/config/app";

interface SettingsViewProps {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    timezone: string;
    bio: string;
    avatarColor: string;
    settings?: {
      accent: string;
      dark: boolean;
      notifEmail: boolean;
      notifPush: boolean;
      notifMentions: boolean;
      notifDueToday: boolean;
      notifWeekly: boolean;
      notifProduct: boolean;
    } | null;
  };
}

export function SettingsView({ user }: SettingsViewProps) {
  const { accent, setAccent, dark, setDark, sidebarRail, toggleSidebarRail } = useApp();
  const refresh = useRefresh();
  const [name, setName] = useState(user.name);
  const [timezone, setTimezone] = useState(user.timezone);
  const [bio, setBio] = useState(user.bio);
  const [avatarColor, setAvatarColor] = useState<AccentTheme>(user.avatarColor as AccentTheme);

  // Notification prefs — initialized from DB-backed user settings
  const [notif, setNotif] = useState({
    email: user.settings?.notifEmail ?? true,
    push: user.settings?.notifPush ?? true,
    mentions: user.settings?.notifMentions ?? true,
    dueToday: user.settings?.notifDueToday ?? true,
    weeklyDigest: user.settings?.notifWeekly ?? false,
    productUpdates: user.settings?.notifProduct ?? true,
  });

  const saveProfile = async () => {
    // Deep-dive review F-01: no `role` is sent — the RBAC role is managed by
    // admins via the People view; job titles are edited on the roster there.
    const res = await updateProfile(user.id, { name, timezone, bio, avatarColor });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    refresh();
    toast.success("Profile updated");
  };

  // Persist notification toggle changes to DB immediately. The local Zustand
  // store already drives the UI for these toggles, so we don't call refresh()
  // here — the next refresh from any other action will re-fetch user.settings
  // (with our persisted values) and the AppShell useEffect will re-apply them,
  // reconciling any drift. Calling refresh() per-toggle would cause a full
  // app remount per click (defect #8 in the P0-1 review).
  const toggleNotif = async (key: keyof typeof notif, value: boolean) => {
    setNotif((prev) => ({ ...prev, [key]: value }));
    const dbKey = key === "weeklyDigest" ? "notifWeekly" : key === "productUpdates" ? "notifProduct" : `notif${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    try {
      const res = await updateUserSettings(user.id, { [dbKey]: value });
      if (!res.ok) toast.error(res.error);
    } catch (e) {
      toast.error(actionErrorMessage(e, "Failed to save setting"));
    }
  };

  // Persist theme + dark mode changes to DB immediately. Same rationale as
  // toggleNotif: the Zustand store already drives the UI; no refresh needed.
  const handleAccentChange = async (a: AccentTheme) => {
    setAccent(a);
    try { await updateUserSettings(user.id, { accent: a }); } catch { /* ignore */ }
  };
  const handleDarkChange = async (v: boolean) => {
    setDark(v);
    try { await updateUserSettings(user.id, { dark: v }); } catch { /* ignore */ }
  };
  // PR-65 — the rail is a per-user preference, persisted like accent/dark.
  const handleRailChange = async (v: boolean) => {
    toggleSidebarRail();
    try { await updateUserSettings(user.id, { sidebarRail: v }); } catch { /* ignore */ }
  };

  return (
    <div className="space-y-5 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your profile, notifications, and appearance</p>
      </div>

      {/* Profile */}
      <Section icon={User} title="Profile" description="Update your personal information">
        <div className="flex items-start gap-5 mb-5">
          <Avatar name={name || "?"} color={avatarColor} size={64} />
          <div className="flex-1">
            <div className="text-sm font-semibold text-foreground">{name}</div>
            <div className="text-xs text-muted-foreground">{user.email}</div>
            <div className="mt-3">
              <label className="block text-xs font-medium text-foreground mb-1.5">Avatar color</label>
              <AvatarColorPicker value={avatarColor} onChange={setAvatarColor} variant="check" />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Full name">
            <input className="f-input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Email">
            <input className="f-input" value={user.email} disabled />
          </Field>
          <Field label="Role">
            {/* F-01: read-only — User.role is the RBAC role (ADMIN/MANAGER/MEMBER),
                managed by admins in the People view. It is NOT a job title. */}
            <input className="f-input" value={user.role} disabled title="Roles are managed by workspace admins" />
          </Field>
          <Field label="Time zone">
            <select className="f-input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Bio">
              <textarea
                className="f-input min-h-[80px] py-2"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Tell your team a bit about yourself"
              />
            </Field>
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={saveProfile} className="f-btn f-btn-primary f-btn-sm">Save changes</button>
        </div>
      </Section>

      {/* HR module — self-service employee profile (docs/HR_MODULE_PLAN.md §5) */}
      <EmployeeProfileSection />

      {/* HR module — my performance reviews (docs/HR_MODULE_PLAN.md §6) */}
      <MyReviewsSection />

      {/* HR module — my onboarding tasks (docs/HR_MODULE_PLAN.md §7) */}
      <MyOnboardingSection />

      {/* P36 (EM-21) — my identification documents: the member submits,
          HR verifies. */}
      <MyDocumentsSection />

      {/* Security — change password */}
      <SecuritySection userId={user.id} email={user.email} />

      {/* Notifications

          Audit gate 9 ("no cosmetic controls shipped") + §1.11: a settings
          toggle must either be honoured by the product or be visibly labelled
          as not-yet-live. The Mentions toggle is honoured server-side by
          notifyMentionedUsers (it skips recipients who opted out). The other
          channels have no delivery mechanism yet (no push service; email
          digests arrive with the mail/scheduler work) — they render disabled
          with a "Coming soon" badge instead of pretending to work. */}
      <Section icon={Bell} title="Notifications" description="Choose what you want to be notified about">
        <div className="space-y-1">
          {[
            { key: "mentions" as const, label: "Mentions", desc: "When someone @mentions you in a task or message" },
            { key: "email" as const, label: "Email notifications", desc: "Receive notifications via email", comingSoon: true },
            { key: "push" as const, label: "Push notifications", desc: "Receive push notifications in your browser", comingSoon: true },
            { key: "dueToday" as const, label: "Due today digest", desc: "Morning summary of tasks due today", comingSoon: true },
            { key: "weeklyDigest" as const, label: "Weekly digest", desc: "Monday morning summary of last week", comingSoon: true },
            { key: "productUpdates" as const, label: "Product updates", desc: "New features and improvements", comingSoon: true },
          ].map((item) => (
            <div key={item.key} className="flex items-center justify-between py-2.5 border-b border-border last:border-0">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{item.label}</span>
                  {item.comingSoon && (
                    <span className="text-[10px] font-medium uppercase tracking-wide rounded-full bg-muted px-2 py-0.5 text-muted-foreground" title="This channel isn’t wired to a delivery mechanism yet — it will start working in a future update.">
                      Coming soon
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{item.desc}</div>
              </div>
              <Toggle
                checked={notif[item.key]}
                onChange={(v) => toggleNotif(item.key, v)}
                disabled={item.comingSoon}
                label={item.label}
              />
            </div>
          ))}
        </div>
      </Section>

      {/* Appearance */}
      <Section icon={Palette} title="Appearance" description={`Customize how ${APP.name} looks for you`}>
        <div className="space-y-5">
          <div>
            <label className="block text-xs font-medium text-foreground mb-2">Accent color</label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {ACCENTS.map((a) => {
                const Icon = a.icon;
                return (
                  <button
                    key={a.key}
                    onClick={() => { handleAccentChange(a.key); toast.success(`Theme: ${a.label}`); }}
                    className={cn(
                      "flex items-center gap-2 p-3 rounded-lg border-2 transition-all",
                      accent === a.key ? "border-foreground bg-muted/40" : "border-border hover:border-muted-foreground"
                    )}
                  >
                    <span className="w-7 h-7 rounded-full flex items-center justify-center text-white" style={{ background: a.color }}>
                      <Icon size={14} />
                    </span>
                    <span className="text-sm font-medium text-foreground">{a.label}</span>
                    {accent === a.key && <Check size={14} className="text-foreground ml-auto" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between py-2 border-t border-border">
            <div>
              <div className="text-sm font-medium text-foreground">Dark mode</div>
              <div className="text-xs text-muted-foreground">Use dark theme across the app</div>
            </div>
            <Toggle checked={dark} onChange={(v) => { handleDarkChange(v); toast.success(v ? "Dark mode on" : "Light mode on"); }} label="Dark mode" />
          </div>

          {/* PR-65 — per-user sidebar density (was browser-localStorage only). */}
          <div className="flex items-center justify-between py-2 border-t border-border">
            <div>
              <div className="text-sm font-medium text-foreground">Compact sidebar</div>
              <div className="text-xs text-muted-foreground">Icon-only rail instead of the full sidebar (⌘B)</div>
            </div>
            <Toggle checked={sidebarRail} onChange={handleRailChange} label="Compact sidebar" />
          </div>
        </div>
      </Section>

      {/* Time & locale */}
      <Section icon={Clock} title="Time & Locale" description="How dates and times are displayed">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Time format">
            <select className="f-input" defaultValue="24h">
              <option value="24h">24-hour (14:30)</option>
              <option value="12h">12-hour (2:30 PM)</option>
            </select>
          </Field>
          <Field label="First day of week">
            <select className="f-input" defaultValue="mon">
              <option value="mon">Monday</option>
              <option value="sun">Sunday</option>
            </select>
          </Field>
        </div>
      </Section>

      <PrivacySection userId={user.id} />
    </div>
  );
}

/**
 * Privacy section — GDPR / NZ Privacy Act 2020 principle 6 (access to
 * personal information). Lets the signed-in user download every row the app
 * stores about them as a JSON file. Self-service: the server action scopes
 * every query to the caller's own userId, so no permission gate beyond a
 * signed-in session is needed.
 */
function PrivacySection({ userId }: { userId: string }) {
  const [exporting, setExporting] = useState(false);

  const download = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await exportMyData();
      if (!res.ok) {
        toast.error(actionErrorMessage(res.error));
        return;
      }
      // Serialize + trigger a browser download. Filename includes the userId
      // prefix and ISO date so multiple exports don't collide.
      const blob = new Blob([JSON.stringify(res.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${APP.slug}-data-export-${userId.slice(0, 8)}-${new Date()
        .toISOString()
        .slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Data export ready", {
        description:
          "Your personal data has been downloaded as a JSON file.",
      });
    } catch {
      toast.error("Failed to export data");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Section
      icon={Shield}
      title="Privacy"
      description={`Access the personal data ${APP.name} stores about you`}
    >
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          You can request a copy of all the personal data {APP.name} holds
          about you — your profile, projects, tasks, messages, notifications,
          reminders, time entries, and audit trail. The export is generated
          on demand and downloaded to your device.
        </p>
        <button
          type="button"
          onClick={download}
          disabled={exporting}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {exporting ? "Preparing export…" : "Download my data"}
        </button>
      </div>
    </Section>
  );
}

function SecuritySection({ userId, email }: { userId: string; email: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && next !== confirm;
  const sameAsCurrent = current.length > 0 && next.length > 0 && current === next;
  const canSubmit =
    current.length > 0 &&
    next.length >= 8 &&
    next === confirm &&
    next !== current &&
    !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const res = await changePassword({
        userId,
        currentPassword: current,
        newPassword: next,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Password updated", {
        description: "Use your new password the next time you sign in.",
      });
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch {
      toast.error("Failed to change password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section icon={Lock} title="Security" description="Change your sign-in password">
      <div className="space-y-4">
        <div className="text-xs text-muted-foreground bg-muted/40 border border-border rounded-md p-3 flex items-start gap-2">
          <Lock size={12} className="mt-0.5 shrink-0" />
          <span>
            Your account <span className="font-semibold text-foreground">{email}</span> uses a password
            you set during sign-up. Pick a strong, unique password — at least 8 characters.
          </span>
        </div>

        <Field label="Current password">
          <PasswordInput
            value={current}
            onChange={setCurrent}
            placeholder="Enter your current password"
            autoComplete="current-password"
          />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="New password">
            <PasswordInput
              value={next}
              onChange={setNext}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              error={tooShort ? "Must be at least 8 characters" : sameAsCurrent ? "Must be different from current" : undefined}
            />
          </Field>
          <Field label="Confirm new password">
            <PasswordInput
              value={confirm}
              onChange={setConfirm}
              placeholder="Re-enter the new password"
              autoComplete="new-password"
              error={mismatch ? "Passwords don't match" : undefined}
            />
          </Field>
        </div>

        <div className="flex justify-end">
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="f-btn f-btn-primary f-btn-sm"
          >
            {saving ? <><Loader2 size={14} className="animate-spin" /> Updating…</> : <><Lock size={14} /> Update password</>}
          </button>
        </div>

        {/* P2 (production-readiness re-audit) — sign out all devices */}
        <div className="border-t border-border pt-4 mt-4">
          <h4 className="text-sm font-semibold text-foreground mb-1">Sign out all devices</h4>
          <p className="text-xs text-muted-foreground mb-3">
            Revokes every active session for your account — on this device, on
            other browsers, on every device you've signed in from. You'll need
            to sign in again afterward. Useful if you suspect someone else has
            your credentials, or if you simply want a clean slate.
          </p>
          <SignOutAllDevicesButton />
        </div>
      </div>
    </Section>
  );
}

/**
 * P2 (production-readiness re-audit) — "Sign out all devices" button.
 * Bumps tokenVersion via the signOutAllDevices server action, then
 * navigates to / so the proxy re-evaluates the (now-invalid) session
 * cookie and shows the login screen.
 */
function SignOutAllDevicesButton() {
  const [revoking, setRevoking] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const revoke = async () => {
    if (revoking) return;
    setRevoking(true);
    try {
      const { signOutAllDevices } = await import("@/server-actions/users");
      const res = await signOutAllDevices();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("All sessions revoked", {
        description: "You'll be redirected to the login screen.",
      });
      // The tokenVersion bump invalidates this session too — navigate to /
      // so the proxy strips the stale cookie and shows the login screen.
      setTimeout(() => {
        if (typeof window !== "undefined") window.location.replace("/");
      }, 1000);
    } catch {
      toast.error("Failed to revoke sessions");
    } finally {
      setRevoking(false);
    }
  };

  if (!confirm) {
    return (
      <button
        type="button"
        onClick={() => setConfirm(true)}
        className="f-btn f-btn-sm text-destructive border-destructive hover:bg-destructive/10"
      >
        Sign out all devices
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Are you sure?</span>
      <button
        type="button"
        onClick={revoke}
        disabled={revoking}
        className="f-btn f-btn-sm text-destructive border-destructive hover:bg-destructive/10"
      >
        {revoking ? <><Loader2 size={14} className="animate-spin" /> Revoking…</> : "Yes, sign out everywhere"}
      </button>
      <button
        type="button"
        onClick={() => setConfirm(false)}
        disabled={revoking}
        className="f-btn f-btn-sm"
      >
        Cancel
      </button>
    </div>
  );
}
