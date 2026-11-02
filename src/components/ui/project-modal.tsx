"use client";
import { useState } from "react";
import { Modal } from "./modal";
import { useApp } from "@/store/app-store";
import { useRefresh } from "@/hooks/use-refresh";
import { createProject, updateProject, deleteProject } from "@/server-actions/data";
import { toast } from "sonner";
import { EntityHistorySection } from "./entity-history-section";
import { Field, FormRow } from "./field";
import { FormActions } from "./form-actions";
import { ProjectColorPicker } from "./avatar-color-picker";
import { PRIORITIES } from "@/lib/constants";
import { PROJECT_STATUSES } from "@/lib/config";
import type { TeamMemberT, ProjectT, ProjectStatus, Priority } from "@/lib/types";

interface ProjectModalProps {
  members: TeamMemberT[];
  projects: ProjectT[];
}

export function ProjectModal({ members, projects }: ProjectModalProps) {
  const { projectModalOpen, projectModalEditId, closeProjectModal } = useApp();
  const editing = projectModalEditId ? projects.find((p) => p.id === projectModalEditId) ?? null : null;

  return (
    <Modal
      open={projectModalOpen}
      onClose={closeProjectModal}
      title={editing ? "Edit project" : "New project"}
      description={editing ? "Update project details" : "Create a new project to organize related tasks"}
    >
      {projectModalOpen && (
        <ProjectForm key={editing?.id ?? "new"} editing={editing} members={members} onClose={closeProjectModal} />
      )}
    </Modal>
  );
}

function ProjectForm({
  editing,
  members,
  onClose,
}: {
  editing: ProjectT | null;
  members: TeamMemberT[];
  onClose: () => void;
}) {
  const refresh = useRefresh();
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [status, setStatus] = useState<ProjectStatus>(editing?.status ?? "RUNNING");
  const [priority, setPriority] = useState<Priority>(editing?.priority ?? "MEDIUM");
  const [dueDate, setDueDate] = useState(editing?.dueDate ? editing.dueDate.slice(0, 10) : "");
  const [color, setColor] = useState<string>(editing?.color ?? "forest");
  // Owner is tracked by stable member id. When editing, resolve the current
  // owner's member record via the user-id link (falling back to a name match
  // for legacy rows created before the stable-id migration).
  const [ownerMemberId, setOwnerMemberId] = useState<string>(() => {
    if (editing?.ownerUserId) {
      const byId = members.find((m) => m.userId && m.userId === editing.ownerUserId);
      if (byId) return byId.id;
    }
    if (editing?.ownerName) {
      const byName = members.find((m) => m.name === editing.ownerName);
      if (byName) return byName.id;
    }
    return members[0]?.id ?? "";
  });

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Project name is required");
      return;
    }
    const payload = {
      name: name.trim(),
      description,
      status,
      priority,
      dueDate: dueDate || null,
      color,
      ownerMemberId,
    };
    if (editing) {
      const res = await updateProject(editing.id, payload);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Project updated");
    } else {
      const res = await createProject(payload);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Project created");
    }
    refresh();
    onClose();
  };

  const remove = async () => {
    if (!editing) return;
    const res = await deleteProject(editing.id);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Project deleted");
    refresh();
    onClose();
  };

  return (
    <div className="space-y-4">
      <Field label="Project name">
        <input autoFocus className="f-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Halcyon Labs Website" />
      </Field>
      <Field label="Description">
        <textarea className="f-input min-h-[64px] py-2" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <FormRow>
        <Field label="Status">
          <select className="f-input" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
            {PROJECT_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select className="f-input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
      </FormRow>
      <FormRow>
        <Field label="Due date">
          <input type="date" className="f-input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Owner">
          <select className="f-input" value={ownerMemberId} onChange={(e) => setOwnerMemberId(e.target.value)}>
            <option value="">— Unassigned —</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
      </FormRow>
      <Field label="Color">
        <ProjectColorPicker value={color} onChange={setColor} />
      </Field>
      <FormActions
        editing={!!editing}
        createLabel="Create project"
        editLabel="Save changes"
        onCancel={onClose}
        onSubmit={submit}
        onDelete={remove}
      />

      {/* Expandable audit history — only when editing an existing project */}
      {editing && (
        <EntityHistorySection
          entityType="PROJECT"
          entityId={editing.id}
          entityLabel={editing.name}
        />
      )}
    </div>
  );
}
