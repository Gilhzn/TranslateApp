import type { AmbiguityFlag, AmbiguityKind, UiRole } from "@/lib/types";

/**
 * Ambiguity detection.
 *
 * English UI copy is dense with words that are unambiguous *only* because a
 * human can see the screen. "Save" is a verb on a button and a noun in a
 * pricing table; "min" is a minute or a minimum; "Buff" is a polish cloth to a
 * dictionary and a stat modifier to a player. Machine translation collapses all
 * of these to the dictionary's first sense, which is exactly how localised
 * builds end up with a "Savings" button.
 *
 * This module ships a curated table of the terms that actually break, and
 * modulates the confidence of each flag by:
 *   - UI role: "Save" on a button is a near-certain imperative; the same word
 *     buried in a sentence is disambiguated by its own context;
 *   - value shape: single-word values are maximally ambiguous, long sentences
 *     are barely ambiguous at all;
 *   - key names: a key under `status.*` corroborates an action-or-state flag.
 *
 * Matching is whole-word and case-insensitive, but the *original* casing is
 * carried into the note. "Runtime" must never fire the "Run" rule.
 *
 * Each `note` is fed verbatim to the model, so every one of them is written as
 * an instruction, not as an observation.
 */

interface TermRule {
  /** Lowercase match target. May contain spaces, dots or hyphens. */
  term: string;
  kinds: AmbiguityKind[];
  /** Term-specific explanation; `{t}` is replaced with the matched casing. */
  gloss: string;
  /** Baseline confidence before role/shape modulation. */
  base?: number;
  /**
   * Unit-style abbreviations only fire when the value *is* the term or when the
   * match sits next to a number or placeholder. Without this, "no", "in" and
   * "on" would flag half of every catalogue.
   */
  unitContext?: boolean;
}

const DEFAULT_BASE: Record<AmbiguityKind, number> = {
  "verb-or-noun": 0.55,
  "action-or-state": 0.55,
  homonym: 0.5,
  "unit-or-word": 0.5,
  "brand-term": 0.7,
  "gaming-slang": 0.6,
  "tech-term": 0.55,
};

/**
 * How fast a flag loses confidence as the value grows into a sentence.
 * Brand names stay do-not-translate no matter how long the sentence is;
 * verb/noun ambiguity essentially disappears once there is a sentence around
 * the word.
 */
const SENTENCE_DECAY: Record<AmbiguityKind, number> = {
  "verb-or-noun": 0.45,
  "action-or-state": 0.45,
  homonym: 0.5,
  "unit-or-word": 0.4,
  "brand-term": 0.05,
  "gaming-slang": 0.2,
  "tech-term": 0.25,
};

/** Roles that resolve — and therefore strengthen — each ambiguity class. */
const ROLE_BOOST: Record<AmbiguityKind, ReadonlySet<UiRole>> = {
  "verb-or-noun": new Set<UiRole>([
    "button",
    "menu",
    "label",
    "badge",
    "heading",
    "title",
    "placeholder",
  ]),
  "action-or-state": new Set<UiRole>([
    "button",
    "menu",
    "toast",
    "error",
    "badge",
    "label",
  ]),
  homonym: new Set<UiRole>([
    "button",
    "menu",
    "label",
    "badge",
    "heading",
    "title",
    "tooltip",
  ]),
  "unit-or-word": new Set<UiRole>(["badge", "label", "button", "menu"]),
  "brand-term": new Set<UiRole>([]),
  "gaming-slang": new Set<UiRole>([]),
  "tech-term": new Set<UiRole>([]),
};

const MIN_CONFIDENCE = 0.28;
/** Flags are ranked; beyond this many the prompt stops getting more useful. */
const MAX_FLAGS = 6;

// ---------------------------------------------------------------------------
// Curated term table
// ---------------------------------------------------------------------------

function brand(term: string, extra?: string): TermRule {
  return {
    term,
    kinds: ["brand-term"],
    gloss: extra
      ? `'{t}' is a product or platform name. ${extra}`
      : `'{t}' is a product or platform name.`,
    base: extra ? 0.6 : 0.75,
  };
}

function gaming(term: string, meaning: string, base?: number): TermRule {
  return {
    term,
    kinds: ["gaming-slang"],
    gloss: `'{t}' is player vernacular here (${meaning}).`,
    ...(base === undefined ? {} : { base }),
  };
}

function tech(term: string, meaning: string, alsoVerbNoun = false): TermRule {
  return {
    term,
    kinds: alsoVerbNoun ? ["tech-term", "verb-or-noun"] : ["tech-term"],
    gloss: `'{t}' is developer vocabulary here (${meaning}).`,
  };
}

const RULES: readonly TermRule[] = [
  // -- verb / noun -----------------------------------------------------------
  {
    term: "save",
    kinds: ["verb-or-noun", "action-or-state"],
    gloss:
      "'{t}' can be the imperative verb 'store this', the noun 'savings/discount', or the progressive state 'Saving…'.",
    base: 0.6,
  },
  {
    term: "run",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the imperative 'execute/start' or the noun 'a run' (one attempt or session).",
    base: 0.6,
  },
  {
    term: "load",
    kinds: ["verb-or-noun", "action-or-state"],
    gloss:
      "'{t}' can be the imperative 'load a file', the noun 'load' (weight, capacity) or the state 'Loading…'.",
    base: 0.6,
  },
  {
    term: "play",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the imperative 'start playback / start the game' or the noun 'a play'.",
  },
  {
    term: "record",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the verb 'start recording' or the noun 'a record' (a stored row, or a best score) — the two are different words in most languages.",
  },
  {
    term: "import",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the action of importing data or the noun 'an import' (the imported file).",
  },
  {
    term: "export",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the action of exporting data or the noun 'an export' (the produced file).",
  },
  {
    term: "filter",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the action 'apply a filter' or the noun 'a filter' (the saved criteria).",
  },
  {
    term: "search",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the action 'search now' or the noun 'a search' / the name of the search feature.",
  },
  {
    term: "sort",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the action 'sort these items' or the noun 'sort order'.",
  },
  {
    term: "share",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the action 'share this' or the noun 'a share' (a portion, or a shared link).",
  },
  {
    term: "link",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the action 'connect an account' or the noun 'a hyperlink'.",
  },
  {
    term: "post",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the action 'publish' or the noun 'a post' (the published item).",
  },
  {
    term: "mark",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the action 'mark as…' or the noun 'a mark' (a grade or annotation).",
  },
  {
    term: "order",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the action 'place an order', the noun 'a purchase order', or 'sort order' — three unrelated words in most languages.",
  },
  {
    term: "bookmark",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the action 'bookmark this' or the noun 'a bookmark' (the saved item).",
  },
  {
    term: "address",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the noun 'postal/email/wallet address' or the verb 'to address an issue'.",
  },
  {
    term: "object",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the noun 'a thing/entity' or the verb 'to object (to disagree)'.",
  },
  {
    term: "contact",
    kinds: ["verb-or-noun"],
    gloss:
      "'{t}' can be the action 'get in touch' or the noun 'a contact' (a person record).",
  },

  // -- action / state --------------------------------------------------------
  {
    term: "saving",
    kinds: ["action-or-state"],
    gloss:
      "'{t}' is the in-progress state ('is being saved'), not the button action 'Save' — and not the noun 'savings'.",
    base: 0.6,
  },
  {
    term: "loading",
    kinds: ["action-or-state"],
    gloss:
      "'{t}' is the in-progress state ('is being loaded'), not the button action 'Load'.",
    base: 0.6,
  },
  {
    term: "connect",
    kinds: ["action-or-state", "verb-or-noun"],
    gloss:
      "'{t}' is the action of establishing a connection, distinct from the state 'Connected'.",
  },
  {
    term: "connected",
    kinds: ["action-or-state"],
    gloss:
      "'{t}' is the resulting state ('a connection exists'), not the action 'Connect'.",
  },
  {
    term: "pause",
    kinds: ["action-or-state", "verb-or-noun"],
    gloss:
      "'{t}' is the action of pausing, distinct from the state 'Paused' and the noun 'a pause'.",
  },
  {
    term: "paused",
    kinds: ["action-or-state"],
    gloss: "'{t}' is the current state, not the action 'Pause'.",
  },
  {
    term: "sync",
    kinds: ["action-or-state", "verb-or-noun"],
    gloss:
      "'{t}' is the action 'synchronise now', distinct from the state 'Syncing' and the noun 'sync status'.",
  },
  {
    term: "syncing",
    kinds: ["action-or-state"],
    gloss: "'{t}' is the in-progress state, not the action 'Sync'.",
  },
  {
    term: "mute",
    kinds: ["action-or-state", "verb-or-noun"],
    gloss:
      "'{t}' is the action of muting, distinct from the state 'Muted'. Many locales use different words for the toggle and its state.",
  },
  {
    term: "muted",
    kinds: ["action-or-state"],
    gloss: "'{t}' is the current state, not the action 'Mute'.",
  },
  {
    term: "live",
    kinds: ["action-or-state", "homonym"],
    gloss:
      "'{t}' can be the state 'currently broadcasting', the adjective 'real-time', or the verb 'to live'.",
  },
  {
    term: "ready",
    kinds: ["action-or-state"],
    gloss:
      "'{t}' is a readiness state; on a button it instead means 'mark me as ready'.",
  },
  {
    term: "done",
    kinds: ["action-or-state"],
    gloss:
      "'{t}' can be the completion state ('finished') or a confirm button meaning 'I am finished'.",
  },
  {
    term: "complete",
    kinds: ["action-or-state", "verb-or-noun"],
    gloss:
      "'{t}' can be the adjective 'finished', the imperative 'finish this', or the noun-ish 'completion'.",
  },

  // -- homonyms --------------------------------------------------------------
  {
    term: "right",
    kinds: ["homonym"],
    gloss:
      "'{t}' can mean the direction (opposite of left), 'correct', or the noun 'a right/entitlement'.",
    base: 0.55,
  },
  {
    term: "left",
    kinds: ["homonym"],
    gloss:
      "'{t}' can mean the direction (opposite of right) or the past tense 'departed / remaining'.",
  },
  {
    term: "close",
    kinds: ["homonym", "verb-or-noun"],
    gloss:
      "'{t}' can be the verb 'shut this' (rhymes with 'chose') or the adjective 'near' (rhymes with 'dose').",
    base: 0.55,
  },
  {
    term: "free",
    kinds: ["homonym"],
    gloss:
      "'{t}' can mean 'no cost', 'unrestricted/available', or the verb 'to release'.",
    base: 0.55,
  },
  {
    term: "match",
    kinds: ["homonym"],
    gloss:
      "'{t}' can be a competitive game, a search hit, or the verb 'to correspond'.",
  },
  {
    term: "fine",
    kinds: ["homonym"],
    gloss:
      "'{t}' can mean 'acceptable', 'fine-grained/detailed', or the noun 'a monetary penalty'.",
  },
  {
    term: "light",
    kinds: ["homonym"],
    gloss:
      "'{t}' can mean illumination, the light colour theme, or 'not heavy'.",
  },
  {
    term: "mean",
    kinds: ["homonym"],
    gloss:
      "'{t}' can be the statistical average, the verb 'to signify', or the adjective 'unkind'.",
  },
  {
    term: "present",
    kinds: ["homonym"],
    gloss:
      "'{t}' can mean 'currently existing', the verb 'to show', or the noun 'a gift'.",
  },
  {
    term: "second",
    kinds: ["homonym", "unit-or-word"],
    gloss:
      "'{t}' can be the time unit or the ordinal 'number two' — different words in most languages.",
  },
  {
    term: "watch",
    kinds: ["homonym"],
    gloss:
      "'{t}' can be the verb 'to view', the verb 'to monitor for changes', or the noun 'a wristwatch'.",
  },
  {
    term: "change",
    kinds: ["homonym", "verb-or-noun"],
    gloss:
      "'{t}' can be the verb 'to modify', the noun 'a modification', or 'money returned'.",
  },
  {
    term: "current",
    kinds: ["homonym"],
    gloss:
      "'{t}' can mean 'present/active' or the electrical/water noun 'a current'.",
  },
  {
    term: "novel",
    kinds: ["homonym"],
    gloss: "'{t}' can mean 'new/original' or the noun 'a book'.",
  },
  {
    term: "type",
    kinds: ["homonym", "verb-or-noun"],
    gloss:
      "'{t}' can be the noun 'category/kind', the data type, or the verb 'to type on a keyboard'.",
  },
  {
    term: "fair",
    kinds: ["homonym"],
    gloss:
      "'{t}' can mean 'just/equitable', 'mediocre' (a rating), or the noun 'a funfair'.",
  },
  {
    term: "kind",
    kinds: ["homonym"],
    gloss: "'{t}' can be the noun 'category/type' or the adjective 'friendly'.",
  },
  {
    term: "rest",
    kinds: ["homonym"],
    gloss:
      "'{t}' can be 'the remainder', 'to pause/sleep', or the REST API style.",
  },
  {
    term: "well",
    kinds: ["homonym"],
    gloss:
      "'{t}' can be the adverb 'properly', the interjection, or the noun 'a water well'.",
  },
  {
    term: "draw",
    kinds: ["homonym"],
    gloss:
      "'{t}' can mean 'to sketch', 'to draw a card', or the noun 'a tie/stalemate'.",
  },

  // -- units vs words --------------------------------------------------------
  {
    term: "min",
    kinds: ["unit-or-word"],
    gloss:
      "'{t}' can abbreviate 'minute(s)' or 'minimum'. Many locales abbreviate these differently.",
    unitContext: true,
    base: 0.6,
  },
  {
    term: "max",
    kinds: ["unit-or-word"],
    gloss: "'{t}' abbreviates 'maximum'; it is not a name and not a unit.",
    unitContext: true,
    base: 0.55,
  },
  {
    term: "sec",
    kinds: ["unit-or-word"],
    gloss: "'{t}' can abbreviate 'second(s)' or 'section'.",
    unitContext: true,
  },
  {
    term: "s",
    kinds: ["unit-or-word"],
    gloss:
      "'{t}' is most likely the 'seconds' unit suffix; keep it attached to the number exactly as in the source.",
    unitContext: true,
    base: 0.45,
  },
  {
    term: "m",
    kinds: ["unit-or-word"],
    gloss:
      "'{t}' can be 'minutes', 'metres' or 'million' — resolve it from the neighbouring keys.",
    unitContext: true,
    base: 0.45,
  },
  {
    term: "h",
    kinds: ["unit-or-word"],
    gloss: "'{t}' abbreviates 'hour(s)'; use the locale's own abbreviation.",
    unitContext: true,
    base: 0.45,
  },
  {
    term: "mo",
    kinds: ["unit-or-word"],
    gloss:
      "'{t}' abbreviates 'month' (as in '/mo' pricing); it is not the word 'more'.",
    unitContext: true,
  },
  {
    term: "avg",
    kinds: ["unit-or-word"],
    gloss: "'{t}' abbreviates 'average'; keep it abbreviated.",
    unitContext: true,
  },
  {
    term: "no",
    kinds: ["unit-or-word"],
    gloss:
      "'{t}' can be the negative answer or the abbreviation of 'number' (as in 'No. 5').",
    unitContext: true,
  },
  {
    term: "in",
    kinds: ["unit-or-word"],
    gloss:
      "'{t}' can be the preposition or the 'inches' unit — check whether a number precedes it.",
    unitContext: true,
    base: 0.4,
  },
  {
    term: "on",
    kinds: ["unit-or-word"],
    gloss:
      "'{t}' can be the preposition or the toggle state 'switched on'; as a toggle it pairs with 'Off'.",
    unitContext: true,
    base: 0.4,
  },

  // -- brands ----------------------------------------------------------------
  brand("discord"),
  brand("twitch"),
  brand("github"),
  brand("patreon"),
  brand("kickstarter"),
  brand("itch.io"),
  brand("godot"),
  brand("xbox"),
  brand("playstation"),
  brand("reddit"),
  brand("ko-fi"),
  brand("kofi"),
  brand(
    "steam",
    "It is also the ordinary word for water vapour — here it is Valve's platform, so keep it as 'Steam'.",
  ),
  brand(
    "unity",
    "It is also the ordinary word for 'togetherness' — here it is the game engine.",
  ),
  brand(
    "unreal",
    "It is also the adjective 'not real' — here it is Epic's engine, so keep 'Unreal'.",
  ),
  brand(
    "epic",
    "It is also the adjective 'grand' and the agile term 'epic' — check whether Epic Games is meant.",
  ),
  brand(
    "switch",
    "It is also the verb 'to change' and the noun 'a toggle' — check whether the Nintendo console is meant.",
  ),

  // -- gaming slang ----------------------------------------------------------
  gaming("gg", "'good game', said at the end of a match"),
  gaming("afk", "'away from keyboard'"),
  gaming("dps", "'damage per second', a stat and a role"),
  gaming("hp", "'hit points' / health"),
  gaming("mp", "'mana points' or 'magic points'"),
  gaming("xp", "'experience points'"),
  gaming("loot", "items dropped by enemies or found in the world"),
  gaming("buff", "a positive stat modifier, or the act of strengthening"),
  gaming("nerf", "a balance change that weakens something"),
  gaming("spawn", "where or when an entity appears"),
  gaming("respawn", "reappearing after death"),
  gaming("grind", "repetitive play for progression"),
  gaming("boss", "a major enemy, not a workplace superior", 0.55),
  gaming("raid", "a large co-operative encounter"),
  gaming("quest", "a mission or task"),
  gaming("perk", "an unlockable passive bonus"),
  gaming("combo", "a chained sequence of actions"),
  gaming("crit", "a critical hit"),
  gaming("mob", "a hostile creature, not a crowd of people"),
  gaming("npc", "'non-player character'"),
  gaming("roguelike", "the run-based genre"),
  gaming("speedrun", "completing the game as fast as possible"),
  gaming("co-op", "co-operative multiplayer"),
  gaming("pvp", "'player versus player'"),
  gaming("pve", "'player versus environment'"),
  gaming("lobby", "the pre-match room, not a building entrance"),
  gaming("skin", "a cosmetic appearance, not body skin"),
  gaming("emote", "a character gesture or animation"),
  gaming("chest", "a container of rewards, not the body part"),
  gaming("drop", "an item awarded by an enemy or event"),
  gaming("rarity", "an item's rarity tier"),
  gaming("tier", "a ranked level"),
  gaming("meta", "the dominant strategy set, not the company"),

  // -- tech terms ------------------------------------------------------------
  tech("commit", "a saved changeset in version control", true),
  tech("branch", "a named line of development"),
  tech("merge", "combining branches", true),
  tech("cache", "stored data for fast reuse; not 'cash'"),
  tech("build", "a compiled artifact, or compiling one", true),
  tech("deploy", "shipping a build to an environment"),
  tech("rollback", "reverting to a previous version"),
  tech("endpoint", "an API URL"),
  tech("token", "an API credential or a lexical unit; not a game token"),
  tech("key", "an API key or an object key; not a physical key"),
  tech("hook", "a lifecycle callback (webhook, React hook)"),
  tech("bundle", "a packaged set of code or assets"),
  tech("runtime", "the execution environment; not 'the time it runs'"),
  tech("seed", "an initialisation value for randomness or a database"),
  tech("migration", "a schema change script; not human migration"),
  tech("schema", "a data structure definition"),
  tech("queue", "a pending work list"),
  tech("worker", "a background process; not an employee"),
  tech("repo", "a source repository"),
  tech("fork", "an independent copy of a repository", true),
  tech("pull", "fetching and merging changes", true),
  tech("push", "sending commits to a remote", true),
  tech("stage", "the version-control staging area", true),
  tech("patch", "a small corrective release", true),
  tech("release", "a published version", true),
  tech("rate limit", "a cap on request frequency"),
  tech("webhook", "an outbound HTTP callback"),
];

// ---------------------------------------------------------------------------
// Note composition
// ---------------------------------------------------------------------------

const IMPERATIVE_ROLES = new Set<UiRole>(["button", "menu"]);
const NOUN_ROLES = new Set<UiRole>(["label", "badge", "heading", "title"]);
const STATE_ROLES = new Set<UiRole>([
  "toast",
  "error",
  "badge",
  "label",
  "title",
  "heading",
]);

function kindInstruction(kind: AmbiguityKind, role: UiRole): string {
  switch (kind) {
    case "verb-or-noun":
      if (IMPERATIVE_ROLES.has(role)) {
        return "Here it is a control the user activates, so use the verb (action) sense — an imperative or infinitive, never the noun.";
      }
      if (NOUN_ROLES.has(role)) {
        return "Here it names something in the interface, so use the noun sense, not a command.";
      }
      if (role === "unknown") {
        return "The UI role could not be determined — check the sibling keys before choosing verb or noun, and do not default to the dictionary's first sense.";
      }
      return "Let the surrounding sentence decide verb or noun; do not default to the dictionary's first sense.";
    case "action-or-state":
      if (IMPERATIVE_ROLES.has(role)) {
        return "Here it is the action the user triggers: use the imperative/infinitive form and keep it distinct from the progress form ('…ing') used elsewhere in this file.";
      }
      if (STATE_ROLES.has(role)) {
        return "Here it reports status, so use the state/progress form, not an imperative.";
      }
      return "Decide from the surrounding UI whether this is the action or the resulting state — most languages use different words for the two.";
    case "homonym":
      return "Choose the sense that matches this UI context, stay consistent with the rest of the file, and do not default to the most frequent dictionary sense.";
    case "unit-or-word":
      return "Decide whether this is a unit abbreviation or a whole word. If it is a unit, use the locale's standard abbreviation and keep it as short as the source.";
    case "brand-term":
      return "Keep it verbatim: do not translate, transliterate, decline or re-capitalise it.";
    case "gaming-slang":
      return "Preserve the gaming register: use the term the locale's player community actually uses — the English word is very often kept — and never a literal or corporate paraphrase.";
    case "tech-term":
      return "Preserve the developer register: use the term the locale's developer community actually uses — the English word is often kept — and never a literal paraphrase.";
  }
}

const ROLE_CLAUSE: Record<UiRole, string> = {
  button: "It renders on a button, so it must stay short.",
  menu: "It renders as a menu item, so it must stay short.",
  label: "It labels a form field.",
  placeholder: "It is placeholder text inside an input.",
  tooltip: "It is help text shown on hover.",
  title: "It is a title.",
  heading: "It is a heading.",
  body: "It is body copy.",
  error: "It is an error message.",
  toast: "It is a transient notification.",
  badge: "It is a badge and has almost no room.",
  unknown: "",
};

/** Kinds whose advice changes with the UI role. */
const ROLE_SENSITIVE = new Set<AmbiguityKind>([
  "verb-or-noun",
  "action-or-state",
  "homonym",
  "unit-or-word",
]);

function buildNote(
  kind: AmbiguityKind,
  matched: string,
  gloss: string,
  role: UiRole,
): string {
  const parts = [gloss.replaceAll("{t}", matched), kindInstruction(kind, role)];
  if (ROLE_SENSITIVE.has(kind)) {
    const clause = ROLE_CLAUSE[role];
    if (clause.length > 0) parts.push(clause);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

/**
 * Whole-word search without lookbehind (Safari < 16.4 lacks it, and these
 * modules must run in the browser). Returns the index of the first standalone
 * occurrence, or -1.
 */
export function findWholeWord(haystackLower: string, term: string): number {
  if (term.length === 0) return -1;
  let from = 0;
  for (;;) {
    const at = haystackLower.indexOf(term, from);
    if (at < 0) return -1;
    const before = at > 0 ? haystackLower[at - 1] : undefined;
    const after = haystackLower[at + term.length];
    if (!isWordChar(before) && !isWordChar(after)) return at;
    from = at + 1;
  }
}

/** A number or a placeholder immediately adjacent to the match. */
const LEFT_NUMERIC =
  /(?:\d|[}\])]|%[-+0#]*\d*(?:\.\d+)?[a-zA-Z@])\s{0,2}[/·-]?\s{0,2}$/;
const RIGHT_NUMERIC = /^\s{0,2}[/·-]?\s{0,2}(?:\d|[{([]|%)/;

function hasNumericNeighbor(text: string, start: number, end: number): boolean {
  return (
    LEFT_NUMERIC.test(text.slice(0, start)) ||
    RIGHT_NUMERIC.test(text.slice(end))
  );
}

/**
 * How sentence-like the value is, 0..1. A single word is maximally ambiguous;
 * by ~10 words the surrounding grammar has resolved the ambiguity on its own.
 */
function sentenceness(text: string, wordCount: number): number {
  let s = (wordCount - 1) / 9;
  if (s < 0) s = 0;
  if (s > 1) s = 1;
  if (wordCount > 5 && /[.!?…]/.test(text)) s = Math.min(1, s + 0.15);
  return s;
}

function keyBoost(kind: AmbiguityKind, keyLower: string): number {
  if (
    kind === "action-or-state" &&
    /(?:^|[.\][_-])(?:status|state|states|loading|progress)(?:$|[.\][_-])/.test(
      keyLower,
    )
  ) {
    return 0.1;
  }
  if (
    kind === "verb-or-noun" &&
    /(?:^|[.\][_-])(?:btn|button|buttons|cta|action|actions)(?:$|[.\][_-])/.test(
      keyLower,
    )
  ) {
    return 0.1;
  }
  if (kind === "brand-term" && /brand|product|platform|partner/.test(keyLower)) {
    return 0.1;
  }
  return 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Flag the terms in `value` whose translation depends on context the model
 * cannot see. Returns at most {@link MAX_FLAGS} flags, highest confidence
 * first.
 */
export function detectAmbiguities(
  key: string,
  value: string,
  role: UiRole,
): AmbiguityFlag[] {
  const text = value.trim();
  if (text.length === 0) return [];

  const lower = text.toLowerCase();
  const keyLower = key.toLowerCase();
  const wordCount = text.split(/\s+/).length;
  const sentence = sentenceness(text, wordCount);

  const flags: Array<AmbiguityFlag & { term: string }> = [];
  const seen = new Set<string>();

  for (const rule of RULES) {
    const at = findWholeWord(lower, rule.term);
    if (at < 0) continue;

    const isWholeValue = lower === rule.term;
    if (
      rule.unitContext &&
      !isWholeValue &&
      !hasNumericNeighbor(text, at, at + rule.term.length)
    ) {
      continue;
    }

    const matched = text.slice(at, at + rule.term.length);

    for (const kind of rule.kinds) {
      const dedupeKey = `${kind}|${rule.term}`;
      if (seen.has(dedupeKey)) continue;

      let confidence = rule.base ?? DEFAULT_BASE[kind];
      if (isWholeValue) confidence += 0.25;
      if (ROLE_BOOST[kind].has(role)) confidence += 0.15;
      confidence += keyBoost(kind, keyLower);
      confidence -= SENTENCE_DECAY[kind] * sentence;

      if (confidence < MIN_CONFIDENCE) continue;
      if (confidence > 0.97) confidence = 0.97;

      seen.add(dedupeKey);
      flags.push({
        kind,
        note: buildNote(kind, matched, rule.gloss, role),
        confidence: round2(confidence),
        term: rule.term,
      });
    }
  }

  flags.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.kind.localeCompare(b.kind) ||
      a.term.localeCompare(b.term),
  );

  return flags
    .slice(0, MAX_FLAGS)
    .map(({ kind, note, confidence }) => ({ kind, note, confidence }));
}

/** Exposed for tests and for the settings UI's "what do you detect?" panel. */
export function ambiguityTermCount(): number {
  return RULES.length;
}
