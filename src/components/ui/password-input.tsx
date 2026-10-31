"use client";

import { useState } from "react";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Password input with show/hide toggle and optional "generate password" button.
 *
 * Replaces the named `PasswordInput` in settings-view and the inline copy in
 * user-modal. The `onGenerate` prop controls whether the generate button is shown.
 */
export function PasswordInput({
  value,
  onChange,
  placeholder,
  autoComplete,
  error,
  onGenerate,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  error?: string;
  /** If provided, a "generate" button is shown next to the show/hide toggle. */
  onGenerate?: () => void;
  disabled?: boolean;
}) {
  const [show, setShow] = useState(false);

  return (
    <div>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          className={cn("f-input pr-9", onGenerate && "pr-[68px]", error && "border-destructive")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          disabled={disabled}
        />
        <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          {onGenerate && (
            <button
              type="button"
              onClick={onGenerate}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
              title="Generate a strong password"
              tabIndex={-1}
            >
              <RefreshCw size={12} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted"
            aria-label={show ? "Hide password" : "Show password"}
            tabIndex={-1}
          >
            {show ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>
      </div>
      {error && <p className="text-[0.625rem] text-destructive mt-1">{error}</p>}
    </div>
  );
}

/**
 * Generate a strong random password of the given length.
 * Uses a mix of lowercase, uppercase, digits, and symbols, excluding
 * ambiguous characters (0/O, 1/l/I) for readability.
 */
export function generatePassword(length = 16): string {
  const chars = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
  let pw = "";
  for (let i = 0; i < length; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}
