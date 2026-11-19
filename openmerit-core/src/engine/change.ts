// The change that applies a pick to the user's code: only the string literal that names a model is
// replaced, keeping its quotes, a `provider:` prefix SDKs read (`openai:gpt-4.1`) and the code around
// it, such as an environment variable it falls back from. A ref with no such literal gets an
// instruction instead. OpenRouter needs the full catalogue ID; another endpoint gets the name it
// calls the model by. The CLI's Configure step and the cloud app's result both use it.
import type { CatalogueModel } from "./catalogue.ts";

/** Where code names the model. `spelling` is the code as written, with the literal's quotes. */
export interface CodeRef {
  file: string;
  line: number;
  spelling: string;
  /** The literal's text when the caller knows which one it is, such as from a scan; else the first literal that names a model. */
  literal?: string;
}

/** One line's change; `from` and `to` are the literal's text before and after. */
export interface Edit { file: string; line: number; before: string; after: string; from: string; to: string }

/** The model to write, and whether the code calls it on OpenRouter. */
export interface EditTarget { model: string; endpoint: string; endpointModel: string; onOpenRouter: boolean }

export interface ProposedChange { edits: Edit[]; instructions: string | null }

/** A quoted string in code: double, single or backtick quotes, with escapes. */
const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
/** An SDK's provider prefix, as in `openai:gpt-4.1`; not a URL scheme. */
const PREFIX = /^[a-z][a-z_-]*:(?!\/)/i;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ID to write for a target: the catalogue ID on OpenRouter, else the endpoint's name for the model. */
export const writtenId = (target: EditTarget) => (target.onOpenRouter ? target.model : target.endpointModel);

/** What replaces a literal's text: the target's ID, after the literal's provider prefix if it has one. */
export const respell = (text: string, target: EditTarget) => `${PREFIX.exec(text)?.[0] ?? ""}${writtenId(target)}`;

/**
 * One ref's edit, or null when its spelling has no literal that names a model. `names` gives the
 * catalogue ID a literal's text names, or null. The literal's provider prefix is kept.
 */
export function editRef(ref: CodeRef, target: EditTarget, names: (text: string) => string | null): (Edit & { names: string }) | null {
  let start: number, quote: string, text: string;
  if (ref.literal !== undefined) {
    const found = new RegExp(`(["'\`])${escape(ref.literal)}\\1`).exec(ref.spelling);
    if (!found) return null;
    [start, quote, text] = [found.index, found[1]!, ref.literal];
  } else if (!/["'`]/.test(ref.spelling) && names(ref.spelling.trim()) !== null) {
    // An older client sends the model ID alone, without its quotes: that is the literal's text.
    text = ref.spelling.trim();
    const to = respell(text, target);
    return { file: ref.file, line: ref.line, before: ref.spelling, after: ref.spelling.replace(text, to), from: text, to, names: names(text)! };
  } else {
    const found = [...ref.spelling.matchAll(LITERAL)].find(match => names(match[2]!) !== null);
    if (!found) return null;
    [start, quote, text] = [found.index, found[1]!, found[2]!];
  }
  const to = respell(text, target);
  const after = `${ref.spelling.slice(0, start)}${quote}${to}${quote}${ref.spelling.slice(start + text.length + 2)}`;
  return { file: ref.file, line: ref.line, before: ref.spelling, after, from: text, to, names: names(text) ?? text };
}

/**
 * The change for a pick: an edit for each ref whose literal names a model, and instructions for refs
 * without one, for a literal that names another model than the current one (a fallback: production
 * sets the model elsewhere), and for a move to another endpoint.
 */
export function proposeEdit(input: { task: string; current: string; refs: readonly CodeRef[]; pick: EditTarget; baselineEndpoint: string | null; find: (id: string) => CatalogueModel | null }): ProposedChange {
  const { pick, find } = input;
  const id = writtenId(pick);
  const current = find(input.current)?.id ?? input.current;
  const names = (text: string) => find(text)?.id ?? (text.toLowerCase() === input.current.toLowerCase() ? current : null);
  const edits: Edit[] = [];
  const notes: string[] = [];
  let fallback = false;
  for (const ref of input.refs) {
    const edit = editRef(ref, pick, names);
    if (!edit) {
      notes.push(`\`${ref.file}:${ref.line}\` (\`${ref.spelling}\`) holds no model ID string, so it is not edited: set the model it gives ${input.task} to \`${id}\` where that value comes from.`);
      continue;
    }
    if (edit.names !== current) fallback = true;
    const { names: _named, ...change } = edit;
    if (change.after !== change.before) edits.push(change);
  }
  const moves = input.baselineEndpoint !== null && pick.endpoint !== input.baselineEndpoint;
  const parts = [
    !edits.length && !notes.length ? `Set the model for ${input.task} to \`${id}\`.` : null,
    ...notes,
    fallback ? `The code's literal is a fallback; production's model comes from elsewhere (for example an environment variable). Set it to \`${id}\`.` : null,
    moves ? `Call it on ${pick.onOpenRouter ? "OpenRouter (https://openrouter.ai/api/v1)" : `your endpoint ${pick.endpoint}`} instead of ${input.baselineEndpoint}.` : null,
  ].filter(Boolean);
  return { edits, instructions: parts.length ? parts.join(" ") : null };
}
