/**
 * GET /api/health — the honest mode indicator.
 *
 * The UI must be able to state, without guessing, whether the strings on screen
 * came from a model or from the offline simulator. That answer depends on
 * server-side environment the browser cannot see, so it is served from here.
 *
 * What this endpoint will never do is leak the key. Not the value, not a
 * prefix, not a length, not a hash — only the boolean "is one configured", which
 * is the entire question the UI has.
 */

import { describeActiveProvider, readEngineEnv } from "@/lib/engine";
import {
  MAX_GLOSSARY_TERMS,
  MAX_PRODUCT_CONTEXT,
  MAX_REPAIR_ATTEMPTS,
  MAX_REQUEST_BYTES,
  MAX_SOURCE_TEXT_BYTES,
  MAX_TARGET_LOCALES,
} from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface HealthBody {
  status: "ok" | "degraded";
  /** True when ANTHROPIC_API_KEY is set and non-empty. Never the key itself. */
  apiKeyConfigured: boolean;
  provider: {
    id: string;
    label: string;
    mode: "live" | "simulation";
    model: string | null;
    ready: boolean;
    forced: boolean;
    headline: string;
    detail: string;
  };
  limits: {
    maxRequestBytes: number;
    maxSourceTextBytes: number;
    maxTargetLocales: number;
    maxGlossaryTerms: number;
    maxProductContext: number;
    maxRepairAttempts: number;
  };
  time: string;
}

export function GET(): Response {
  const env = readEngineEnv();
  const provider = describeActiveProvider();
  const apiKeyConfigured =
    typeof env.ANTHROPIC_API_KEY === "string" &&
    env.ANTHROPIC_API_KEY.trim().length > 0;

  const body: HealthBody = {
    // "degraded" means the selected provider cannot actually run — an explicit
    // Anthropic request with no key. Simulation mode is a legitimate `ok`,
    // because everything works; the copy in `provider.detail` says what it is.
    status: provider.ready ? "ok" : "degraded",
    apiKeyConfigured,
    provider: {
      id: provider.id,
      label: provider.label,
      mode: provider.mode,
      model: provider.model,
      ready: provider.ready,
      forced: provider.forced,
      headline: provider.headline,
      detail: provider.detail,
    },
    limits: {
      maxRequestBytes: MAX_REQUEST_BYTES,
      maxSourceTextBytes: MAX_SOURCE_TEXT_BYTES,
      maxTargetLocales: MAX_TARGET_LOCALES,
      maxGlossaryTerms: MAX_GLOSSARY_TERMS,
      maxProductContext: MAX_PRODUCT_CONTEXT,
      maxRepairAttempts: MAX_REPAIR_ATTEMPTS,
    },
    time: new Date().toISOString(),
  };

  return Response.json(body, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
