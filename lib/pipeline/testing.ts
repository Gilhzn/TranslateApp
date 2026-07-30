/**
 * Test support for the pipeline.
 *
 * A scripted provider is the only honest way to test the repair loop: the
 * deterministic simulator converges on its own, which proves the happy path but
 * cannot produce "still broken on attempt three". Not imported by production
 * code.
 */

import type {
  Issue,
  ProviderRequest,
  ProviderResponse,
  ProviderTranslation,
  TranslationProvider,
  TranslationSettings,
  TranslationUnit,
} from "@/lib/types";

export interface ScriptedCall {
  locale: string;
  keys: string[];
  repair: boolean;
}

/**
 * What a scripted provider does with one unit:
 *   - a string  → that translation
 *   - `null`    → no entry for this key at all (a dropped key)
 */
export type ScriptedReply = (
  unit: TranslationUnit,
  context: { attempt: number; locale: string },
) => string | null;

export interface ScriptedProviderOptions {
  id?: string;
  /** Batch-level issues returned with every response. */
  issues?: Issue[];
  /** Invoked before each batch; throw or abort from here to test cancellation. */
  onBatch?: (request: ProviderRequest, call: ScriptedCall) => void | Promise<void>;
  configured?: boolean;
}

export class ScriptedProvider implements TranslationProvider {
  readonly id: string;
  readonly label = "Scripted test provider";
  readonly calls: ScriptedCall[] = [];

  private readonly reply: ScriptedReply;
  private readonly options: ScriptedProviderOptions;
  private readonly attempts = new Map<string, number>();

  constructor(reply: ScriptedReply, options: ScriptedProviderOptions = {}) {
    this.reply = reply;
    this.options = options;
    this.id = options.id ?? "scripted";
  }

  isConfigured(): boolean {
    return this.options.configured ?? true;
  }

  async translate(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    const call: ScriptedCall = {
      locale: request.locale.code,
      keys: request.units.map((unit) => unit.key),
      repair: request.units.some((unit) => unit.repairFeedback !== undefined),
    };
    this.calls.push(call);
    await this.options.onBatch?.(request, call);

    if (signal?.aborted === true) {
      return {
        translations: [],
        issues: [
          {
            code: "provider-error",
            severity: "warning",
            message: "Cancelled before the batch ran.",
          },
        ],
      };
    }

    const translations: ProviderTranslation[] = [];
    for (const unit of request.units) {
      const id = `${request.locale.code}|${unit.key}`;
      const attempt = (this.attempts.get(id) ?? 0) + 1;
      this.attempts.set(id, attempt);
      const target = this.reply(unit, { attempt, locale: request.locale.code });
      if (target === null) continue;
      translations.push({ key: unit.key, target, rationale: `attempt ${attempt}` });
    }

    return { translations, issues: [...(this.options.issues ?? [])] };
  }
}

export function settings(
  overrides: Partial<TranslationSettings> = {},
): TranslationSettings {
  return {
    sourceLocale: "en",
    targetLocales: ["de"],
    tone: "neutral-product",
    productContext: "A roguelike deckbuilder for PC.",
    glossary: [],
    enforceLayout: true,
    maxRepairAttempts: 2,
    ...overrides,
  };
}
