import { useEffect, useRef, useState } from "react";
import { defaultAreas } from "@/lib/areas";
import { useAreas } from "@/lib/hooks/use-areas";
import { usePeopleMutations } from "@/lib/hooks/use-people";
import type { AreaId } from "@/lib/types";

interface NewPersonFormProps {
  onCreated: () => void;
  onCancel: () => void;
}

/**
 * Inline person creator. Compact form: name, role, company, email, area.
 * Initials are auto-derived from the name (first letter of first two
 * words). Sidecar id is slugged from the name on the Rust side. Avatars
 * are added later by clicking the avatar on the detail page; until then
 * the fallback shows initials on a Woodshed-teal tint.
 */
export function NewPersonForm({ onCreated, onCancel }: NewPersonFormProps) {
  const { create } = usePeopleMutations();
  const { data: liveAreas } = useAreas();
  const areas = liveAreas ?? defaultAreas;

  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [area, setArea] = useState<AreaId | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  async function commit() {
    const trimmed = name.trim();
    if (!trimmed || create.isPending) return;
    await create.mutateAsync({
      name: trimmed,
      role: role.trim(),
      company: company.trim(),
      email: email.trim(),
      area,
    });
    onCreated();
  }

  return (
    <div
      className="space-y-2 rounded-md border border-border bg-background/50 p-3 outline-none"
      onKeyDown={(e) => {
        if (e.key.length === 1 || e.key === "Enter" || e.key === "Escape") {
          e.stopPropagation();
        }
      }}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
        New person
      </p>
      <input
        ref={nameRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Name"
        className="w-full px-2 h-8 text-sm rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
      />
      <input
        value={role}
        onChange={(e) => setRole(e.target.value)}
        placeholder="Role"
        className="w-full px-2 h-7 text-[13px] rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
      />
      <input
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        placeholder="Company"
        className="w-full px-2 h-7 text-[13px] rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
      />
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
        className="w-full px-2 h-7 text-[13px] rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
      />
      <select
        value={area ?? ""}
        onChange={(e) => setArea(e.target.value === "" ? null : e.target.value)}
        aria-label="Area"
        className="w-full px-2 h-7 text-[13px] rounded-sm border border-border bg-background outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
      >
        <option value="">Empty</option>
        {areas.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <div className="flex items-center justify-end gap-1.5 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={create.isPending}
          className="h-7 px-3 rounded-sm text-[13px] text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={commit}
          disabled={create.isPending || !name.trim()}
          className="h-7 px-3 rounded-sm bg-accent text-accent-foreground text-[13px] disabled:opacity-50"
        >
          {create.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
