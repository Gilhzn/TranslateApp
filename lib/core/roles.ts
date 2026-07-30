import type { UiRole } from "@/lib/types";

/**
 * UI role inference.
 *
 * The role is the single most load-bearing signal in the pipeline: it sets the
 * length budget (a button that grows 40% breaks the layout, a paragraph that
 * grows 40% does not) and it sets the register (imperative for buttons,
 * descriptive for body copy).
 *
 * Inference is a cascade, strongest evidence first:
 *   1. key names, nearest segment first — `dialog.confirm.button` is a button
 *      even though `dialog` and `confirm` are also meaningful;
 *   2. value shape — long punctuated text is body copy whatever the key says;
 *   3. an explicitly honest "unknown".
 *
 * Where the evidence is weak we deliberately bias toward the *tighter* budget
 * (button/label over body). Under-estimating available width produces a
 * shorter translation; over-estimating produces an overflow, and overflow is
 * the one failure mode the product promises never to ship.
 */

/** Direct key-word to role table. Checked against tokenised key segments. */
const ROLE_WORDS: Record<string, UiRole> = {
  // buttons / actions
  btn: "button",
  button: "button",
  buttons: "button",
  cta: "button",
  action: "button",
  actions: "button",
  submit: "button",
  confirm: "button",
  cancel: "button",
  dismiss: "button",
  retry: "button",
  // menus / navigation
  menu: "menu",
  menus: "menu",
  menuitem: "menu",
  nav: "menu",
  navbar: "menu",
  navigation: "menu",
  tab: "menu",
  tabs: "menu",
  sidebar: "menu",
  dropdown: "menu",
  breadcrumb: "menu",
  breadcrumbs: "menu",
  // tooltips / help
  tooltip: "tooltip",
  tooltips: "tooltip",
  hint: "tooltip",
  hints: "tooltip",
  help: "tooltip",
  helper: "tooltip",
  tip: "tooltip",
  tips: "tooltip",
  // errors
  error: "error",
  errors: "error",
  err: "error",
  failure: "error",
  failures: "error",
  failed: "error",
  invalid: "error",
  validation: "error",
  // transient notifications
  toast: "toast",
  toasts: "toast",
  notification: "toast",
  notifications: "toast",
  notify: "toast",
  snackbar: "toast",
  // input affordances
  placeholder: "placeholder",
  placeholders: "placeholder",
  // labels
  label: "label",
  labels: "label",
  field: "label",
  fields: "label",
  caption: "label",
  legend: "label",
  // headings
  heading: "heading",
  headings: "heading",
  header: "heading",
  headline: "heading",
  section: "heading",
  subheading: "heading",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  // titles
  title: "title",
  subtitle: "title",
  // badges
  badge: "badge",
  badges: "badge",
  tag: "badge",
  tags: "badge",
  chip: "badge",
  chips: "badge",
  pill: "badge",
  // body copy
  description: "body",
  descriptions: "body",
  desc: "body",
  body: "body",
  paragraph: "body",
  paragraphs: "body",
  copy: "body",
  intro: "body",
  blurb: "body",
  summary: "body",
  content: "body",
};

/** Segments that mark an input context; combined with a hint word below. */
const INPUT_CONTEXT = new Set([
  "input",
  "inputs",
  "form",
  "forms",
  "search",
  "textarea",
  "field",
  "fields",
  "filter",
]);

/**
 * Split a key segment into lowercase words, understanding camelCase,
 * PascalCase, snake_case, kebab-case and dotted names: `saveBtn` -> ["save",
 * "btn"], `ARIALabel` -> ["aria", "label"].
 */
export function tokenizeSegment(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

function lookupWord(word: string): UiRole | null {
  const direct = ROLE_WORDS[word];
  if (direct !== undefined) return direct;
  // Cheap plural fallback for words not spelled out in the table.
  if (word.length > 3 && word.endsWith("s")) {
    const singular = ROLE_WORDS[word.slice(0, -1)];
    if (singular !== undefined) return singular;
  }
  return null;
}

function countWords(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/** Every word starts with an uppercase letter (ignoring short function words). */
function isTitleCase(value: string): boolean {
  const words = value.trim().split(/\s+/);
  let capitalised = 0;
  for (const word of words) {
    const first = word[0];
    if (first === undefined) continue;
    if (first >= "A" && first <= "Z") capitalised += 1;
    else if (!/^(?:a|an|the|of|to|in|on|for|and|or)$/i.test(word)) return false;
  }
  return capitalised > 0;
}

/**
 * Infer where a string surfaces from its structural path and its own shape.
 *
 * @param path structural path segments; numeric segments (array indices) carry
 *             no naming information and are skipped.
 */
export function inferRole(
  path: ReadonlyArray<string | number>,
  value: string,
): UiRole {
  const segments: string[][] = [];
  for (const segment of path) {
    if (typeof segment === "string") segments.push(tokenizeSegment(segment));
  }

  // 1. Key evidence, nearest segment first, and within a segment the trailing
  //    word first (`saveButton` is a button, `buttonLabel` is a label).
  for (let s = segments.length - 1; s >= 0; s--) {
    const words = segments[s];
    if (words === undefined || words.length === 0) continue;

    // `titleAttr` / `title_attribute` is the HTML tooltip, not a page title.
    if (
      words.includes("title") &&
      (words.includes("attr") || words.includes("attribute"))
    ) {
      return "tooltip";
    }
    // `input.hint`, `searchPlaceholder`, `form.field.hint` -> placeholder text.
    if (words.includes("hint") || words.includes("placeholder")) {
      const contextual =
        words.some((w) => INPUT_CONTEXT.has(w)) ||
        segments
          .slice(0, s)
          .some((prev) => prev.some((w) => INPUT_CONTEXT.has(w)));
      if (contextual) return "placeholder";
    }

    for (let w = words.length - 1; w >= 0; w--) {
      const word = words[w];
      if (word === undefined) continue;
      const role = lookupWord(word);
      if (role !== null) return role;
    }
  }

  // 2. Value shape.
  const text = value.trim();
  if (text.length === 0) return "unknown";
  const words = countWords(text);
  const hasSentencePunctuation = /[.!?…]/.test(text);
  const endsWithTerminal = /[.!?…]$/.test(text);

  if (text.includes("\n")) return "body";
  // Long, punctuated prose is body copy regardless of what the key is called.
  if (text.length > 80 && hasSentencePunctuation) return "body";
  if (words >= 12) return "body";
  if (text.endsWith(":")) return "label";
  // Short Title Case with no terminal punctuation is an actionable control far
  // more often than it is prose: take the tighter budget.
  if (words <= 3 && !endsWithTerminal && text.length <= 24 && isTitleCase(text)) {
    return "button";
  }

  return "unknown";
}
