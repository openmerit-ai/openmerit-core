// What a page is: it loads its data, renders it as Html, and handles the
// actions its buttons and forms name with data-action. app/main.ts mounts it.
import type { Api, Me } from "./api.ts";
import type { Html } from "./html.ts";

export interface ConfirmOptions { title: string; body: string; confirm: string; danger?: boolean; typeToConfirm?: string }

// The signed-in member, with the organization's name filled in when Clerk has none.
export type Account = Me & { account: { id: string; name: string } };

export interface Ctx {
  api: Api;
  me: Account;
  // The query string, and the run ID on /r/<id>/.
  params: URLSearchParams;
  id: string | null;
  refresh(): Promise<void>;
  toast(message: string): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
  go(url: string): void;
  download(name: string, data: unknown): void;
}

export interface View<D> {
  load(ctx: Ctx): Promise<D>;
  render(data: D, ctx: Pick<Ctx, "me" | "params" | "id">): Html;
  title?(data: D): string;
  // Wires up what data-action cannot, after each render, such as polling while something changes.
  bind?(root: HTMLElement, data: D, ctx: Ctx): void;
  actions?: Record<string, (target: HTMLElement, data: D, ctx: Ctx) => Promise<void>>;
}

export interface Mounted { html: Html; title: string | null; bind(root: HTMLElement): void; act(name: string, target: HTMLElement): Promise<void> | undefined }

export function mount<D>(view: View<D>): (ctx: Ctx) => Promise<Mounted> {
  return async (ctx) => {
    const data = await view.load(ctx);
    return { html: view.render(data, ctx), title: view.title?.(data) ?? null, bind: (root) => view.bind?.(root, data, ctx), act: (name, target) => view.actions?.[name]?.(target, data, ctx) };
  };
}
