"use client";

import * as React from "react";
import { JsonParseError, parseSourceFile, type ParsedCatalog } from "@/lib/core";
import { Button, cn } from "@/components/ui";
import {
  DRAG_IDLE,
  carriesFiles,
  dragTransition,
  type DragState,
} from "./drag-state";
import {
  ACCEPTED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  failureFromParseError,
  failureFromUnknown,
  formatBytes,
  looksLikeJsonObject,
  validatePastedText,
  validateUploadFile,
  type UploadFailure,
} from "./file-validation";

export interface DropZoneProps {
  onCatalog: (catalog: ParsedCatalog) => void;
  onFailure: (failure: UploadFailure) => void;
  /** Fired before the (synchronous, potentially slow) parse begins. */
  onParseStart: () => void;
  parsing: boolean;
  failure: UploadFailure | null;
  onDismissFailure: () => void;
  /** Name of the catalog already loaded; switches the zone to its compact form. */
  loadedFileName: string | null;
  loadedSummary?: string;
  disabled?: boolean;
}

const CLIPBOARD_FILE_NAME = "clipboard.json";

/** Yield one frame so the "Parsing…" state actually paints before we block. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function isEditableTarget(node: EventTarget | null): boolean {
  if (node === null || !(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function DropZone({
  onCatalog,
  onFailure,
  onParseStart,
  parsing,
  failure,
  onDismissFailure,
  loadedFileName,
  loadedSummary,
  disabled = false,
}: DropZoneProps) {
  const [drag, setDrag] = React.useState<DragState>(DRAG_IDLE);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const busy = parsing || disabled;

  // Refs keep the window-level paste listener from being torn down and
  // reattached on every parent render.
  const handlersRef = React.useRef({ onCatalog, onFailure, onParseStart });
  handlersRef.current = { onCatalog, onFailure, onParseStart };

  const ingest = React.useCallback(
    async (fileName: string, read: () => Promise<string>) => {
      const { onCatalog: emit, onFailure: fail, onParseStart: start } =
        handlersRef.current;
      start();
      await nextPaint();
      let text: string;
      try {
        text = await read();
      } catch (error) {
        fail(failureFromUnknown(error, fileName));
        return;
      }
      try {
        emit(parseSourceFile(fileName, text));
      } catch (error) {
        fail(
          error instanceof JsonParseError
            ? failureFromParseError(error)
            : failureFromUnknown(error, fileName),
        );
      }
    },
    [],
  );

  const acceptFiles = React.useCallback(
    (files: FileList | null) => {
      if (files === null || files.length === 0) return;
      if (files.length > 1) {
        handlersRef.current.onFailure({
          code: "extension",
          title: `${files.length} files were dropped`,
          detail:
            "LingoLoop translates one source catalog per run so it can keep sibling keys in the same batch. Drop a single .json file.",
        });
        return;
      }
      const file = files[0];
      if (file === undefined) return;
      const rejection = validateUploadFile({ name: file.name, size: file.size });
      if (rejection !== null) {
        handlersRef.current.onFailure(rejection);
        return;
      }
      void ingest(file.name, () => file.text());
    },
    [ingest],
  );

  const acceptText = React.useCallback(
    (text: string) => {
      const rejection = validatePastedText(text);
      if (rejection !== null) {
        handlersRef.current.onFailure(rejection);
        return;
      }
      void ingest(CLIPBOARD_FILE_NAME, async () => text);
    },
    [ingest],
  );

  const openPicker = React.useCallback(() => {
    if (busy) return;
    inputRef.current?.click();
  }, [busy]);

  // Pasting anywhere on the page (outside a text field) counts as an upload —
  // indie developers paste a catalog out of their editor at least as often as
  // they drag a file. Only payloads that look like a JSON object are claimed,
  // so ordinary copy-paste on the page is never hijacked.
  React.useEffect(() => {
    if (disabled) return;
    const onWindowPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const data = event.clipboardData;
      if (data === null) return;
      if (data.files.length > 0) {
        event.preventDefault();
        acceptFiles(data.files);
        return;
      }
      const text = data.getData("text/plain");
      if (!looksLikeJsonObject(text)) return;
      event.preventDefault();
      acceptText(text);
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
  }, [disabled, acceptFiles, acceptText]);

  const onDragEnter = (event: React.DragEvent<HTMLElement>) => {
    if (busy || !carriesFiles(event.dataTransfer.types)) return;
    event.preventDefault();
    setDrag((state) => dragTransition(state, "enter"));
  };

  const onDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (busy || !carriesFiles(event.dataTransfer.types)) return;
    // Without preventDefault on dragover the browser refuses the drop entirely.
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: React.DragEvent<HTMLElement>) => {
    if (busy) return;
    event.preventDefault();
    setDrag((state) => dragTransition(state, "leave"));
  };

  const onDrop = (event: React.DragEvent<HTMLElement>) => {
    if (busy) return;
    event.preventDefault();
    setDrag(DRAG_IDLE);
    acceptFiles(event.dataTransfer.files);
  };

  const dragProps = {
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openPicker();
  };

  const onPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const data = event.clipboardData;
    if (data.files.length > 0) {
      event.preventDefault();
      acceptFiles(data.files);
      return;
    }
    const text = data.getData("text/plain");
    if (text.trim().length === 0) return;
    event.preventDefault();
    acceptText(text);
  };

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept={`${ACCEPTED_EXTENSIONS.join(",")},application/json`}
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(event) => {
        acceptFiles(event.target.files);
        // Reset so re-selecting the same file after a fix fires change again.
        event.target.value = "";
      }}
    />
  );

  if (loadedFileName !== null) {
    return (
      <div className="space-y-3">
        <div
          {...dragProps}
          className={cn(
            "surface-card flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 transition-colors duration-150",
            drag.active &&
              "border-[var(--color-accent-500)] bg-[color-mix(in_oklch,var(--color-accent-500)_10%,transparent)]",
          )}
        >
          <FileGlyph className="h-5 w-5 shrink-0 text-[var(--color-accent-400)]" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-[family-name:var(--font-mono)] text-[13px] text-[var(--text-primary)]">
              {loadedFileName}
            </p>
            {loadedSummary !== undefined && (
              <p className="mt-0.5 truncate text-[12px] text-[var(--text-tertiary)]">
                {drag.active ? "Release to replace this catalog" : loadedSummary}
              </p>
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={openPicker} loading={parsing}>
            Replace file
          </Button>
          {fileInput}
        </div>
        {failure !== null && (
          <FailurePanel failure={failure} onDismiss={onDismissFailure} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div
        {...dragProps}
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-disabled={busy || undefined}
        aria-label="Upload a JSON locale catalog. Press Enter to browse, or paste JSON."
        onClick={openPicker}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className={cn(
          "group relative flex min-h-[260px] cursor-pointer flex-col items-center justify-center gap-4",
          "rounded-[var(--radius-xl)] border border-dashed px-6 py-12 text-center",
          "transition-[border-color,background-color,box-shadow] duration-200 ease-[var(--ease-out-expo)]",
          "border-[var(--border-strong)] bg-[color-mix(in_oklch,var(--color-ink-900)_60%,transparent)]",
          !busy && "hover:border-[var(--color-ink-600)] hover:bg-[var(--surface-2)]",
          drag.active &&
            "border-solid border-[var(--color-accent-500)] bg-[color-mix(in_oklch,var(--color-accent-500)_12%,transparent)] shadow-[0_0_0_4px_color-mix(in_oklch,var(--color-accent-500)_14%,transparent)]",
          busy && "cursor-progress opacity-80",
        )}
      >
        {parsing ? (
          <ParsingState />
        ) : drag.active ? (
          <DragActiveState />
        ) : (
          <IdleState />
        )}
        {fileInput}
      </div>

      {failure !== null && (
        <FailurePanel failure={failure} onDismiss={onDismissFailure} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function IdleState() {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "grid h-12 w-12 place-items-center rounded-[var(--radius-lg)]",
          "border border-[var(--border-subtle)] bg-[var(--surface-2)]",
          "transition-colors duration-200 group-hover:border-[var(--border-strong)]",
        )}
      >
        <UploadGlyph className="h-5 w-5 text-[var(--text-secondary)]" />
      </span>

      <div className="space-y-1.5">
        <p className="text-[15px] font-medium text-[var(--text-primary)]">
          Drop your source catalog
        </p>
        <p className="max-w-[40ch] text-[13px] leading-relaxed text-[var(--text-tertiary)]">
          A JSON locale file — flat or nested, {formatBytes(MAX_UPLOAD_BYTES)} max.
          Structure, key order and formatting come back untouched.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2 text-[13px]">
        <span
          className={cn(
            "inline-flex h-8 select-none items-center rounded-[var(--radius-sm)] px-3 font-medium",
            "border border-[var(--border-subtle)] bg-[var(--surface-3)] text-[var(--text-primary)]",
            "transition-colors duration-150 group-hover:border-[var(--border-strong)]",
          )}
        >
          Browse files
        </span>
        <span className="text-[var(--text-tertiary)]">
          or paste JSON with <Kbd>⌘</Kbd>
          <Kbd>V</Kbd>
        </span>
      </div>
    </>
  );
}

function DragActiveState() {
  return (
    <>
      <span
        aria-hidden="true"
        className="grid h-12 w-12 place-items-center rounded-[var(--radius-lg)] border border-[var(--color-accent-500)] bg-[color-mix(in_oklch,var(--color-accent-500)_18%,transparent)]"
      >
        <UploadGlyph className="h-5 w-5 text-[var(--color-accent-400)]" />
      </span>
      <p className="text-[15px] font-medium text-[var(--color-accent-400)]">
        Release to parse
      </p>
      <p className="text-[13px] text-[var(--text-tertiary)]">
        Nothing is uploaded until you press Translate.
      </p>
    </>
  );
}

function ParsingState() {
  return (
    <>
      <span
        aria-hidden="true"
        className="grid h-12 w-12 place-items-center rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-2)]"
      >
        <svg className="h-5 w-5 animate-spin text-[var(--color-accent-400)]" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
          <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>
      <p className="text-[15px] font-medium text-[var(--text-primary)]">Parsing catalog…</p>
      <p className="text-[13px] text-[var(--text-tertiary)]">
        Flattening keys, extracting placeholders, inferring UI roles.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

function FailurePanel({
  failure,
  onDismiss,
}: {
  failure: UploadFailure;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "animate-in-fade rounded-[var(--radius-lg)] border px-4 py-3.5",
        "border-[color-mix(in_oklch,var(--color-danger-500)_32%,transparent)]",
        "bg-[color-mix(in_oklch,var(--color-danger-500)_9%,transparent)]",
      )}
    >
      <div className="flex items-start gap-3">
        <WarnGlyph className="mt-px h-4 w-4 shrink-0 text-[var(--color-danger-400)]" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-[13px] font-medium text-[var(--color-danger-400)]">
            {failure.title}
            {failure.location !== undefined && (
              <span className="ml-2 font-normal text-[var(--text-tertiary)]">
                {failure.location}
              </span>
            )}
          </p>
          <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
            {failure.detail}
          </p>
          {failure.snippet !== undefined && (
            <pre
              className={cn(
                "mt-2 overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border-subtle)]",
                "bg-[var(--surface-0)] px-3 py-2.5",
                "font-[family-name:var(--font-mono)] text-[12px] leading-[1.6] text-[var(--text-secondary)]",
              )}
            >
              <code>{failure.snippet}</code>
            </pre>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          className={cn(
            "-mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-sm)]",
            "text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)]",
          )}
        >
          <CloseGlyph className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className={cn(
        "mx-0.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-[var(--radius-xs)]",
        "border border-[var(--border-subtle)] bg-[var(--surface-3)] px-1",
        "font-[family-name:var(--font-mono)] text-[11px] text-[var(--text-secondary)]",
      )}
    >
      {children}
    </kbd>
  );
}

function UploadGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 13.5V3.5m0 0L6.5 7M10 3.5 13.5 7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 12.5v2a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FileGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M11.5 2.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 17.5h8a1.5 1.5 0 0 0 1.5-1.5V6.5l-4-4Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M11.5 2.5v4h4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function WarnGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.75v3.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11" r="0.85" fill="currentColor" />
    </svg>
  );
}

function CloseGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="m3.5 3.5 7 7m0-7-7 7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
