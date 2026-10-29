"use client";

import { Loader2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Modal form footer — the Cancel / Save / Delete button row.
 *
 * Replaces 4+ near-identical inline copies across task-modal, project-modal,
 * user-modal, member-modal, and calendar-view.
 *
 * Layout: [Delete (left, edit-only)] ... [Cancel] [Save/Create (right)]
 */
export function FormActions({
  editing,
  createLabel = "Create",
  editLabel = "Save changes",
  saving = false,
  deleting = false,
  showDelete = true,
  onCancel,
  onSubmit,
  onDelete,
  submitIcon,
  className,
}: {
  editing: boolean;
  /** Label for the primary button when creating. */
  createLabel?: string;
  /** Label for the primary button when editing. */
  editLabel?: string;
  /** Disable the submit button + show a spinner. */
  saving?: boolean;
  /** Disable the delete button + show a spinner. */
  deleting?: boolean;
  /** Show the delete button at all (default true, only in edit mode). */
  showDelete?: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  onDelete?: () => void;
  /** Optional icon element for the submit button. */
  submitIcon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between pt-2", className)}>
      {editing && showDelete ? (
        <button
          onClick={onDelete}
          disabled={deleting}
          className="f-btn f-btn-ghost f-btn-sm text-destructive"
        >
          {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          Delete
        </button>
      ) : (
        <div />
      )}
      <div className="flex gap-2">
        <button onClick={onCancel} className="f-btn f-btn-ghost f-btn-sm">
          Cancel
        </button>
        <button
          onClick={onSubmit}
          disabled={saving}
          className="f-btn f-btn-primary f-btn-sm"
        >
          {saving ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Saving…
            </>
          ) : (
            <>
              {submitIcon}
              {editing ? editLabel : createLabel}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
