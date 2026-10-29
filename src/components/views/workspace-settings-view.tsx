"use client";

import { useState, useEffect } from "react";
import {
  Settings2, Save, Loader2, Plus, Trash2, ChevronDown, Shield,
  Tag, Flag, Building2, Calendar, CheckSquare, FolderKanban,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Section } from "../fernly/section";
import { Field, FormRow } from "../fernly/field";
import { FormActions } from "../fernly/form-actions";
import {
  loadWorkspaceConfig, updateWorkspaceSettings,
  updateConfigItem, createConfigItem, deleteConfigItem,
  updateRole, createRole, deleteRole, type WorkspaceConfig } from "@/server-actions/data";

interface WorkspaceSettingsViewProps {
  currentUser: { id: string; name: string; role: string };
}

export function WorkspaceSettingsView({ currentUser }: WorkspaceSettingsViewProps) {
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>("general");

  useEffect(() => {
    loadWorkspaceConfig()
      .then((res) => {
        if (res.ok) setConfig(res.data);
        else toast.error(res.error);
      })
      .catch(() => toast.error("Failed to load workspace config"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" /> Loading workspace config…
      </div>
    );
  }

  if (!config) {
    return <div className="text-center py-20 text-sm text-muted-foreground">Failed to load config.</div>;
  }

  const tabs = [
    { key: "general", label: "General", icon: Settings2 },
    { key: "task-statuses", label: "Task Statuses", icon: CheckSquare },
    { key: "project-statuses", label: "Project Statuses", icon: FolderKanban },
    { key: "event-types", label: "Event Types", icon: Calendar },
    { key: "tags", label: "Tags", icon: Tag },
    { key: "priorities", label: "Priorities", icon: Flag },
    { key: "departments", label: "Departments", icon: Building2 },
    { key: "roles", label: "Roles & Permissions", icon: Shield },
  ];

  return (
    <div className="space-y-5 max-w-4xl">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Settings2 size={22} className="text-primary" />
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Workspace Config</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Manage statuses, tags, priorities, departments, roles, and workspace defaults — all stored in the database.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 p-1 bg-muted/60 rounded-lg flex-wrap">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5",
                activeTab === t.key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon size={12} /> {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === "general" && <GeneralSettings config={config} />}
      {activeTab === "task-statuses" && <ConfigListEditor config={config} type="taskStatuses" labelKey="label" fields={[
        { key: "key", label: "Key", type: "text" },
        { key: "label", label: "Label", type: "text" },
        { key: "accentClass", label: "Accent class", type: "text" },
        { key: "sortOrder", label: "Sort order", type: "number" },
      ]} />}
      {activeTab === "project-statuses" && <ConfigListEditor config={config} type="projectStatuses" labelKey="label" fields={[
        { key: "key", label: "Key", type: "text" },
        { key: "label", label: "Label", type: "text" },
        { key: "badgeClass", label: "Badge class", type: "text" },
        { key: "dotClass", label: "Dot class", type: "text" },
        { key: "sortOrder", label: "Sort order", type: "number" },
      ]} />}
      {activeTab === "event-types" && <ConfigListEditor config={config} type="eventTypes" labelKey="label" fields={[
        { key: "key", label: "Key", type: "text" },
        { key: "label", label: "Label", type: "text" },
        { key: "dotClass", label: "Dot class", type: "text" },
        { key: "bgClass", label: "BG class", type: "text" },
        { key: "sortOrder", label: "Sort order", type: "number" },
      ]} />}
      {activeTab === "tags" && <ConfigListEditor config={config} type="taskTags" labelKey="label" fields={[
        { key: "key", label: "Key", type: "text" },
        { key: "label", label: "Label", type: "text" },
        { key: "color", label: "Color (oklch)", type: "text" },
        { key: "sortOrder", label: "Sort order", type: "number" },
      ]} />}
      {activeTab === "priorities" && <ConfigListEditor config={config} type="priorities" labelKey="label" fields={[
        { key: "key", label: "Key", type: "text" },
        { key: "label", label: "Label", type: "text" },
        { key: "color", label: "Color (oklch)", type: "text" },
        { key: "sortOrder", label: "Sort order", type: "number" },
      ]} />}
      {activeTab === "departments" && <ConfigListEditor config={config} type="departments" labelKey="label" fields={[
        { key: "key", label: "Key", type: "text" },
        { key: "label", label: "Label", type: "text" },
        { key: "sortOrder", label: "Sort order", type: "number" },
      ]} />}
      {activeTab === "roles" && <RolesEditor config={config} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// General workspace settings
// ---------------------------------------------------------------------------

function GeneralSettings({ config }: { config: WorkspaceConfig }) {
  const { workspace } = config;
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(workspace);

  async function save() {
    setSaving(true);
    try {
      await updateWorkspaceSettings(form);
      toast.success("Workspace settings updated");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section icon={Settings2} title="General" description="Workspace-level defaults and policies">
      <div className="space-y-4">
        <Field label="Workspace name">
          <input className="f-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <FormRow>
          <Field label="Default timezone">
            <input className="f-input" value={form.defaultTimezone} onChange={(e) => setForm({ ...form, defaultTimezone: e.target.value })} />
          </Field>
          <Field label="Default role for new users">
            <select className="f-input" value={form.defaultUserRole} onChange={(e) => setForm({ ...form, defaultUserRole: e.target.value })}>
              {config.roles.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Default department">
            <select className="f-input" value={form.defaultDepartment} onChange={(e) => setForm({ ...form, defaultDepartment: e.target.value })}>
              {config.departments.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
          </Field>
          <Field label="Default avatar color">
            <input className="f-input" value={form.defaultAvatarColor} onChange={(e) => setForm({ ...form, defaultAvatarColor: e.target.value })} />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Default job title">
            <input className="f-input" value={form.defaultJobTitle} onChange={(e) => setForm({ ...form, defaultJobTitle: e.target.value })} />
          </Field>
          <Field label="Min password length">
            <input type="number" className="f-input" value={form.minPasswordLength} onChange={(e) => setForm({ ...form, minPasswordLength: Number(e.target.value) })} />
          </Field>
        </FormRow>
        <FormRow>
          <Field label="Workload full capacity (open tasks = 100%)">
            <input type="number" className="f-input" value={form.workloadFullCapacity} onChange={(e) => setForm({ ...form, workloadFullCapacity: Number(e.target.value) })} />
          </Field>
          <Field label="Audit log limit">
            <input type="number" className="f-input" value={form.auditLogLimit} onChange={(e) => setForm({ ...form, auditLogLimit: Number(e.target.value) })} />
          </Field>
        </FormRow>
        <div className="flex justify-end pt-2">
          <button onClick={save} disabled={saving} className="f-btn f-btn-primary f-btn-sm">
            {saving ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : <><Save size={14} /> Save settings</>}
          </button>
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Generic config list editor — handles all 6 domain-enum tables
// ---------------------------------------------------------------------------

interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number";
}

function ConfigListEditor({
  config,
  type,
  labelKey,
  fields,
}: {
  config: WorkspaceConfig;
  type: keyof WorkspaceConfig;
  labelKey: string;
  fields: FieldDef[];
}) {
  const items = config[type] as unknown as Array<Record<string, unknown> & { id?: string }>;
  // The server-action signature already constrains `table` to the literal
  // union of the six config tables. Mirror that union here so the call
  // sites don't need `as any` to satisfy it.
  type ConfigTable =
    | "taskStatusConfig"
    | "projectStatusConfig"
    | "eventTypeConfig"
    | "taskTagConfig"
    | "priorityConfig"
    | "departmentConfig";
  const tableMap: Record<keyof WorkspaceConfig, ConfigTable> = {
    taskStatuses: "taskStatusConfig",
    projectStatuses: "projectStatusConfig",
    eventTypes: "eventTypeConfig",
    taskTags: "taskTagConfig",
    priorities: "priorityConfig",
    departments: "departmentConfig",
    // WorkspaceConfig carries three more keys that this editor never
    // reaches (workspace settings + role/permission management have
    // their own editors). The record must still be exhaustive; we map
    // them to a placeholder table that will never be hit at runtime.
    workspace: "taskStatusConfig",
    roles: "taskStatusConfig",
    permissions: "taskStatusConfig",
  };
  const table: ConfigTable = tableMap[type];

  const [editing, setEditing] = useState<string | null>(null);
  const [newItem, setNewItem] = useState<Record<string, unknown>>({});
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSave(id: string, data: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await updateConfigItem(table, id, data);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Updated");
      setEditing(null);
      // Refresh config
      const fresh = await loadWorkspaceConfig();
      if (fresh.ok) Object.assign(config, fresh.data);
    } catch {
      toast.error("Failed to update");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate() {
    setSaving(true);
    try {
      const res = await createConfigItem(table, { ...newItem, isVisible: true });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Created");
      setNewItem({});
      setShowNew(false);
      const fresh = await loadWorkspaceConfig();
      if (fresh.ok) Object.assign(config, fresh.data);
    } catch {
      toast.error("Failed to create");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this config item?")) return;
    setSaving(true);
    try {
      const res = await deleteConfigItem(table, id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Deleted");
      const fresh = await loadWorkspaceConfig();
      if (fresh.ok) Object.assign(config, fresh.data);
    } catch {
      toast.error("Failed to delete");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{items.length} items</p>
        <button onClick={() => setShowNew(!showNew)} className="f-btn f-btn-secondary f-btn-sm">
          <Plus size={14} /> Add item
        </button>
      </div>

      {/* New item form */}
      {showNew && (
        <div className="f-card p-4 space-y-3 border-primary/30">
          <h4 className="text-xs font-semibold text-foreground">New item</h4>
          <div className="grid grid-cols-2 gap-3">
            {fields.map((f) => (
              <Field key={f.key} label={f.label}>
                <input
                  type={f.type}
                  className="f-input"
                  value={(newItem[f.key] as string | number | undefined) ?? ""}
                  onChange={(e) => setNewItem({
                    ...newItem,
                    [f.key]: f.type === "number" ? Number(e.target.value) : e.target.value,
                  })}
                />
              </Field>
            ))}
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowNew(false)} className="f-btn f-btn-ghost f-btn-sm">Cancel</button>
            <button onClick={handleCreate} disabled={saving} className="f-btn f-btn-primary f-btn-sm">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create
            </button>
          </div>
        </div>
      )}

      {/* Items list */}
      <div className="f-card overflow-hidden">
        {items.map((item, i) => {
          const id = item.id ?? `idx-${i}`;
          const isEditing = editing === id;
          return (
            <div key={id} className="border-b border-border last:border-0">
              {isEditing ? (
                <ConfigItemEditor
                  item={item}
                  fields={fields}
                  onSave={(data) => handleSave(id, data)}
                  onCancel={() => setEditing(null)}
                  saving={saving}
                />
              ) : (
                <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30">
                  <span className="text-sm font-medium text-foreground flex-1">{String(item[labelKey])}</span>
                  {Boolean(item.color) && (
                    <span className="w-4 h-4 rounded-full border border-border" style={{ background: String(item.color) }} />
                  )}
                  {Boolean(item.accentClass || item.dotClass) && (
                    <span className={cn("w-3 h-3 rounded-full", String(item.accentClass || item.dotClass))} />
                  )}
                  <span className="text-[0.625rem] text-muted-foreground font-mono">{String(item.key)}</span>
                  <button onClick={() => setEditing(id)} className="text-xs text-primary hover:underline">Edit</button>
                  <button onClick={() => handleDelete(id)} className="text-xs text-destructive hover:underline">Delete</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConfigItemEditor({
  item,
  fields,
  onSave,
  onCancel,
  saving,
}: {
  item: Record<string, unknown>;
  fields: FieldDef[];
  onSave: (data: Record<string, unknown>) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [data, setData] = useState(item);
  return (
    <div className="p-4 space-y-3 bg-muted/20">
      <div className="grid grid-cols-2 gap-3">
        {fields.map((f) => (
          <Field key={f.key} label={f.label}>
            <input
              type={f.type}
              className="f-input"
              value={String(data[f.key] ?? "")}
              onChange={(e) => setData({
                ...data,
                [f.key]: f.type === "number" ? Number(e.target.value) : e.target.value,
              })}
            />
          </Field>
        ))}
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="f-btn f-btn-ghost f-btn-sm">Cancel</button>
        <button onClick={() => onSave(data)} disabled={saving} className="f-btn f-btn-primary f-btn-sm">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roles editor — permission matrix with checkboxes
// ---------------------------------------------------------------------------

function RolesEditor({ config }: { config: WorkspaceConfig }) {
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);

  // Group permissions by group
  const permGroups = config.permissions.reduce<Record<string, typeof config.permissions>>((acc, p) => {
    (acc[p.group] ||= []).push(p);
    return acc;
  }, {});

  async function handlePermissionToggle(roleId: string, role: typeof config.roles[0], permKey: string) {
    const newPerms = role.permissions.includes(permKey)
      ? role.permissions.filter((p) => p !== permKey)
      : [...role.permissions, permKey];
    setSaving(true);
    try {
      const res = await updateRole(roleId, { permissions: newPerms });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Permissions updated");
      const fresh = await loadWorkspaceConfig();
      if (fresh.ok) Object.assign(config, fresh.data);
    } catch {
      toast.error("Failed to update");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRole(roleId: string, label: string) {
    if (!confirm(`Delete role "${label}"?`)) return;
    setSaving(true);
    try {
      const res = await deleteRole(roleId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Role deleted");
      const fresh = await loadWorkspaceConfig();
      if (fresh.ok) Object.assign(config, fresh.data);
    } catch {
      toast.error("Failed to delete");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {config.roles.length} roles · {config.permissions.length} permissions · System roles can't be deleted
        </p>
        <button onClick={() => setShowNew(!showNew)} className="f-btn f-btn-secondary f-btn-sm">
          <Plus size={14} /> Add role
        </button>
      </div>

      {/* New role form */}
      {showNew && <NewRoleForm config={config} onDone={() => setShowNew(false)} />}

      {/* Roles list with permission matrix */}
      {config.roles.map((role) => (
        <div key={role.id} className="f-card overflow-hidden">
          {/* Role header */}
          <div className="flex items-center gap-3 p-4 border-b border-border">
            <span className={cn("f-badge", role.badgeClass)}>{role.label}</span>
            {role.isSystem && <span className="text-[0.625rem] text-muted-foreground">system</span>}
            <span className="text-xs text-muted-foreground flex-1">{role.description}</span>
            <span className="text-[0.625rem] text-muted-foreground">{role.permissions.length} perms</span>
            <button onClick={() => setEditingRole(editingRole === role.id ? null : role.id)} className="text-xs text-primary hover:underline">
              {editingRole === role.id ? "Close" : "Edit permissions"}
            </button>
            {!role.isSystem && (
              <button onClick={() => handleDeleteRole(role.id, role.label)} disabled={saving} className="text-xs text-destructive hover:underline">
                Delete
              </button>
            )}
          </div>

          {/* Permission matrix */}
          {editingRole === role.id && (
            <div className="p-4 space-y-4 f-view-enter">
              {Object.entries(permGroups).map(([group, perms]) => (
                <div key={group}>
                  <h4 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{group}</h4>
                  <div className="space-y-1">
                    {perms.map((p) => {
                      const checked = role.permissions.includes(p.key);
                      return (
                        <label key={p.key} className="flex items-center gap-3 py-1.5 cursor-pointer hover:bg-muted/30 rounded px-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => handlePermissionToggle(role.id, role, p.key)}
                            disabled={saving}
                            className="accent-[var(--primary)]"
                          />
                          <div className="flex-1">
                            <div className="text-xs font-medium text-foreground">{p.label}</div>
                            <div className="text-[0.625rem] text-muted-foreground">{p.description}</div>
                          </div>
                          <code className="text-[0.625rem] text-muted-foreground/60">{p.key}</code>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function NewRoleForm({ config, onDone }: { config: WorkspaceConfig; onDone: () => void }) {
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!key.trim() || !label.trim()) {
      toast.error("Key and label are required");
      return;
    }
    setSaving(true);
    try {
      const res = await createRole({
        key: key.trim().toUpperCase().replace(/\s+/g, "_"),
        label: label.trim(),
        description,
        permissions,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Role created");
      onDone();
    } catch {
      toast.error("Failed to create role");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="f-card p-4 space-y-3 border-primary/30">
      <h4 className="text-xs font-semibold text-foreground">New role</h4>
      <FormRow>
        <Field label="Key (e.g. REVIEWER)">
          <input className="f-input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="REVIEWER" />
        </Field>
        <Field label="Label (e.g. Reviewer)">
          <input className="f-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Reviewer" />
        </Field>
      </FormRow>
      <Field label="Description">
        <input className="f-input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Can review tasks but not delete them" />
      </Field>
      <div>
        <label className="block text-xs font-medium text-foreground mb-1.5">Permissions</label>
        <div className="max-h-40 overflow-y-auto f-scroll space-y-1 border border-border rounded-lg p-2">
          {config.permissions.map((p) => (
            <label key={p.key} className="flex items-center gap-2 cursor-pointer text-xs">
              <input
                type="checkbox"
                checked={permissions.includes(p.key)}
                onChange={() => setPermissions(permissions.includes(p.key) ? permissions.filter((x) => x !== p.key) : [...permissions, p.key])}
                className="accent-[var(--primary)]"
              />
              <span className="font-medium text-foreground">{p.label}</span>
              <span className="text-muted-foreground">— {p.group}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onDone} className="f-btn f-btn-ghost f-btn-sm">Cancel</button>
        <button onClick={create} disabled={saving} className="f-btn f-btn-primary f-btn-sm">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create role
        </button>
      </div>
    </div>
  );
}
