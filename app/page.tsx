import { describeActiveProvider } from "@/lib/engine";
import { ProviderIndicator, UploadStage } from "@/components/upload";

/**
 * The dashboard.
 *
 * Rendered per request rather than at build time: `describeActiveProvider()`
 * reads the environment, and a statically baked "Offline simulation" pill would
 * be exactly the kind of dishonest status this product refuses to ship.
 */
export const dynamic = "force-dynamic";

const CLAIMS: readonly string[] = [
  "Structure, key order and formatting preserved",
  "Placeholders survive exactly",
  "Overflow repaired, not just reported",
];

export default function Home() {
  const provider = describeActiveProvider();

  return (
    <div className="flex min-h-dvh flex-col">
      <header
        className={
          "sticky top-0 z-30 border-b border-[var(--border-subtle)] " +
          "bg-[color-mix(in_oklch,var(--surface-0)_82%,transparent)] backdrop-blur-md"
        }
      >
        <div className="mx-auto flex h-14 w-full max-w-[1100px] items-center gap-3 px-6">
          <Wordmark />
          <span className="hidden text-[12px] text-[var(--text-tertiary)] sm:inline">
            AI localization for micro-SaaS and indie games
          </span>
          <div className="ml-auto flex items-center gap-2">
            <ProviderIndicator provider={provider} />
          </div>
        </div>
      </header>

      <main className="relative flex-1">
        <div
          aria-hidden="true"
          className="grid-backdrop pointer-events-none absolute inset-x-0 top-0 h-[420px]"
        />

        <div className="relative mx-auto w-full max-w-[1100px] px-6 pb-24 pt-14">
          <section className="mb-10 max-w-[62ch]">
            <h1 className="text-gradient text-[32px] font-semibold leading-[1.15] tracking-[-0.02em]">
              Ship your UI in twelve languages without breaking the layout.
            </h1>
            <p className="mt-3.5 text-[15px] leading-relaxed text-[var(--text-secondary)]">
              Drop in your source catalog. LingoLoop reads the structure, infers
              what each string is for, resolves the words English leaves
              ambiguous, and returns JSON that is byte-shape identical to what
              you uploaded — with every translation measured against the space it
              has to fit into.
            </p>
            <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
              {CLAIMS.map((claim) => (
                <li
                  key={claim}
                  className="flex items-center gap-2 text-[13px] text-[var(--text-tertiary)]"
                >
                  <CheckGlyph />
                  {claim}
                </li>
              ))}
            </ul>
          </section>

          <UploadStage provider={provider} />
        </div>
      </main>

      <footer className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto flex w-full max-w-[1100px] flex-wrap items-center gap-x-4 gap-y-2 px-6 py-5 text-[12px] text-[var(--text-tertiary)]">
          <span>LingoLoop</span>
          <span aria-hidden="true">·</span>
          <span>
            Files are parsed in your browser; only translatable strings leave it.
          </span>
          <span className="ml-auto font-[family-name:var(--font-mono)]">
            {provider.mode === "live" ? provider.model : "offline simulation"}
          </span>
        </div>
      </footer>
    </div>
  );
}

function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] bg-[var(--color-accent-500)]"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-white" fill="none">
          <path
            d="M4 5.5h8M4 8h5.5M4 10.5h8"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
        LingoLoop
      </span>
    </span>
  );
}

function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 14 14"
      className="h-3.5 w-3.5 shrink-0 text-[var(--color-ok-400)]"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m2.5 7.3 3 3 6-6.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
