import type { GuardrailSetting, Guardrails, Level, Task } from "../api.ts";
import { ApiError } from "../api.ts";
import { html, usd, type Html } from "../html.ts";
import type { View } from "../view.ts";
import { empty, header } from "./common.ts";

const levels: { level: Level; label: string }[] = [{ level: "environment", label: "Environment" }, { level: "agent", label: "Agent" }, { level: "task", label: "Task" }];
const isLevel = (value: string | null): value is Level => levels.some((item) => item.level === value);

type Shape = "list" | "number" | "usd" | "percent" | "boolean" | "text";
const settings: Record<string, { label: string; shape: Shape }> = {
  allowedProviders: { label: "Allowed providers", shape: "list" },
  allowedModels: { label: "Allowed models", shape: "list" },
  endpoints: { label: "Endpoints", shape: "list" },
  region: { label: "Region", shape: "text" },
  spendCapUsd: { label: "OpenMerit-paid spend cap per job", shape: "usd" },
  customerSpendCapUsd: { label: "Customer-paid spend cap per job", shape: "usd" },
  budgetUsd: { label: "Budget per job", shape: "usd" },
  repeats: { label: "Runs per case", shape: "number" },
  minPassRate: { label: "Minimum pass rate", shape: "percent" },
  latencyMs: { label: "Latency limit (ms)", shape: "number" },
  watch: { label: "Watch for new models", shape: "boolean" },
  actionPolicy: { label: "What the agent may do with a pick", shape: "text" },
  agentEvalRequired: { label: "Agent eval required", shape: "boolean" },
  minAgentPassRate: { label: "Minimum agent pass rate", shape: "percent" },
};
const shapeOf = (key: string): Shape => settings[key]?.shape ?? "text";

export function show(key: string, value: unknown): string {
  if (value === null || value === undefined) return "–";
  const shape = shapeOf(key);
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
  if (shape === "boolean" || typeof value === "boolean") return value ? "On" : "Off";
  if (shape === "usd" && typeof value === "number") return usd(value);
  if (shape === "percent" && typeof value === "number") return `${Math.round(value * 100)}%`;
  return typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value);
}

// The text a user types back into the value it stands for; empty means inherit.
export function parse(key: string, text: string): unknown {
  const value = text.trim();
  if (!value) return null;
  switch (shapeOf(key)) {
    case "list": return value.split(",").map((item) => item.trim()).filter(Boolean);
    case "boolean": return /^(on|true|yes)$/i.test(value);
    case "percent": return Number(value.replace("%", "")) / (value.includes("%") || Number(value) > 1 ? 100 : 1);
    case "usd": return Number(value.replace("$", ""));
    case "number": return Number(value);
    default: return value;
  }
}
const editable = (key: string, value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (shapeOf(key) === "percent" && typeof value === "number") return `${Math.round(value * 100)}%`;
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
};

function from(setting: GuardrailSetting, level: Level): Html {
  if (!setting.from) return html`<span class="sub">Not set</span>`;
  return setting.from === level ? html`<span class="pill good">This level</span>` : html`<span class="pill">${setting.from[0]?.toUpperCase()}${setting.from.slice(1)}</span>`;
}

interface Data { tasks: Task[]; level: Level; id: string | null; guardrails: Guardrails | null }

const choices = (tasks: Task[], level: Level): { id: string; label: string }[] => {
  if (level === "task") return tasks.map((task) => ({ id: task.id, label: `${task.name} · ${task.environment}` }));
  const ids = [...new Set(tasks.map((task) => (level === "environment" ? task.environment : task.agent)).filter((id): id is string => !!id))];
  return ids.map((id) => ({ id, label: id }));
};

export const guardrailsView: View<Data> = {
  async load({ api, params }) {
    const tasks = await api.get<Task[]>("/api/tasks");
    const level = isLevel(params.get("level")) ? params.get("level") as Level : "environment";
    const id = params.get("id") ?? choices(tasks, level)[0]?.id ?? null;
    const guardrails = id ? await api.get<Guardrails>(`/api/guardrails?level=${level}&id=${encodeURIComponent(id)}`) : null;
    return { tasks, level, id, guardrails };
  },
  render({ tasks, level, id, guardrails }, { me }) {
    const top = header(me, "Guardrails", "Rules for which models OpenMerit may pick and how it measures them, set for an environment, an agent or a task. Constraints only narrow at lower levels; defaults are replaced by them.");
    const tabs = html`<nav class="tabs" aria-label="Level">${levels.map((item) => html`<a href="?level=${item.level}"${item.level === level ? html` aria-current="page"` : ""}>${item.label}</a>`)}</nav>`;
    const options = choices(tasks, level);
    if (!guardrails || !id) return html`${top}${tabs}<section>${empty(`No ${level === "environment" ? "environments" : `${level}s`} yet`, "Environments, agents and tasks appear when a coding agent first sends a task. Their guardrails can be set here then.")}</section>`;
    const picker = html`<form class="picker" method="get"><input type="hidden" name="level" value="${level}"><label>${levels.find((item) => item.level === level)?.label}
      <select name="id" data-action="pick">${options.map((option) => html`<option value="${option.id}"${option.id === id ? html` selected` : ""}>${option.label}</option>`)}</select></label></form>`;
    return html`${top}${tabs}${picker}
    ${guardrails.rejected.length ? html`<div class="card notice warn" role="status">${guardrails.rejected.map((item) => html`<p>${settings[item.key]?.label ?? item.key} at the ${item.level} level was not applied: ${item.reason}</p>`)}</div>` : ""}
    <section aria-labelledby="settings">
      <h2 id="settings">Settings</h2>
      <form data-action="save">
        <div class="tablewrap">
          <table class="guardrails">
            <thead><tr><th>Setting</th><th class="hide-sm">Kind</th><th>Set at this level</th><th>Effective</th><th>From</th></tr></thead>
            <tbody>
              ${guardrails.settings.map((setting) => html`<tr>
                <td><label for="g-${setting.key}">${settings[setting.key]?.label ?? setting.key}</label><span class="sub"><code>${setting.key}</code></span></td>
                <td class="hide-sm"><span class="sub">${setting.kind === "constraint" ? "Constraint · only narrows" : "Default · can be replaced"}</span></td>
                <td><input id="g-${setting.key}" name="${setting.key}" value="${editable(setting.key, setting.value)}" placeholder="Inherit" spellcheck="false"></td>
                <td>${show(setting.key, setting.effective)}</td>
                <td>${from(setting, level)}</td>
              </tr>`)}
            </tbody>
          </table>
        </div>
        <p class="form-error" role="alert" hidden></p>
        <p style="margin-top: 14px"><button class="btn primary" type="submit">Save ${level} guardrails</button></p>
      </form>
      <p class="note">Leave a value empty to inherit it from the level above. Lists are comma-separated; caps are in US dollars per job.</p>
    </section>`;
  },
  actions: {
    async pick(target) {
      const select = target as HTMLSelectElement;
      select.form?.requestSubmit();
    },
    async save(form, { level, id, guardrails }, { api, refresh, toast }) {
      if (!(form instanceof HTMLFormElement) || !guardrails || !id) return;
      const fields = new FormData(form), changes: Record<string, unknown> = {};
      for (const setting of guardrails.settings) changes[setting.key] = parse(setting.key, String(fields.get(setting.key) ?? ""));
      const error = form.querySelector<HTMLElement>(".form-error");
      try {
        await api.send("PUT", "/api/guardrails", { level, id, settings: changes });
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status !== 400 || !error) throw failure;
        error.textContent = failure.message;
        error.hidden = false;
        return;
      }
      await refresh();
      toast("Guardrails saved.");
    },
  },
};
