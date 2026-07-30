/**
 * Minimal class-name joiner.
 *
 * Deliberately dependency-free: `clsx`/`tailwind-merge` would pull runtime
 * weight for behaviour this codebase does not need. Conflicting Tailwind
 * classes are avoided by construction in the primitives below rather than
 * resolved at runtime.
 */
export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | ClassValue[]
  | { [key: string]: boolean | null | undefined };

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];

  const walk = (value: ClassValue): void => {
    if (!value && value !== 0) return;

    if (typeof value === "string" || typeof value === "number") {
      out.push(String(value));
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    if (typeof value === "object") {
      for (const [key, enabled] of Object.entries(value)) {
        if (enabled) out.push(key);
      }
    }
  };

  for (const input of inputs) walk(input);

  return out.join(" ");
}
