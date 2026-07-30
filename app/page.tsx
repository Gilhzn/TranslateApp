import { describeActiveProvider } from "@/lib/engine";
import { ProviderIndicator } from "@/components/upload";
import { TranslationFlow } from "@/components/flow";

/**
 * The dashboard — and the whole product.
 *
 * Rendered per request rather than at build time: `describeActiveProvider()`
 * reads the environment, and a statically baked "Offline simulation" pill would
 * be exactly the kind of dishonest status this product refuses to ship.
 *
 * The shell is deliberately thin. Everything between the header and the footer
 * belongs to `TranslationFlow`, which owns the upload → run → review phases; a
 * server component cannot hold that state and splitting the hero away from it
 * would mean the page could not get out of the developer's way once a job is
 * running.
 */
export const dynamic = "force-dynamic";

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
        <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center gap-3 px-6">
          <Wordmark />
          <span className="hidden text-[12px] text-[var(--text-tertiary)] sm:inline">
            AI localization for micro-SaaS and indie games
          </span>
          <div className="ml-auto flex items-center gap-2">
            {/*
              The pill is the persistent, glanceable answer to "which engine is
              answering right now". It is the only place the mode is *named*;
              the flow's callout explains the consequence instead of repeating
              this line.
            */}
            <ProviderIndicator provider={provider} />
          </div>
        </div>
      </header>

      <main className="relative flex-1">
        <TranslationFlow provider={provider} />
      </main>

      <footer className="border-t border-[var(--border-subtle)]">
        <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-2 px-6 py-5 text-[12px] text-[var(--text-tertiary)]">
          <span>LingoLoop</span>
          <span aria-hidden="true">·</span>
          <span>
            Files are parsed in your browser; only translatable strings leave it.
          </span>
          {/*
            The third and last place the engine is mentioned, and deliberately
            the most technical: the pill names the mode, the flow's callout
            names the consequence, and this names the identifier you would put
            in a bug report. Repeating "offline simulation" here was the fourth
            copy of one sentence.
          */}
          <span className="ml-auto font-[family-name:var(--font-mono)]">
            engine: {provider.mode === "live" ? provider.model : provider.id}
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
