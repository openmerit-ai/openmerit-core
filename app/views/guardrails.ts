import { ApiError, GUARDRAIL_KINDS, type GuardrailKey, type GuardrailsAt, type Level, type Task } from "../api.ts";
import { html, usd, type Html } from "../html.ts";
import posthog, { isPostHogInitialized } from "../posthog.ts";
import type { View } from "../view.ts";
import { empty, header } from "./common.ts";

const levels: { level: Level; label: string }[] = [{ level: "environment", label: "Environment" }, { level: "agent", label: "Agent" }, { level: "task", label: "Task" }];
const isLevel = (value: string | null): value is Level => levels.some((item) => item.level === value);

type Shape = "list" | "number" | "whole" | "usd" | "percent" | "boolean" | "text";
const settings: Record<GuardrailKey, { label: string; shape: Shape; hint?: string }> = {
  allowedProviders: { label: "Allowed providers", shape: "list" },
  allowedModels: { label: "Allowed models", shape: "list" },
  endpoints: { label: "Endpoints", shape: "list", hint: "Endpoint IDs" },
  region: { label: "Region", shape: "text" },
  spendCapUsd: { label: "OpenMerit-paid spend cap", shape: "usd" },
  customerSpendCapUsd: { label: "Customer-paid spend cap", shape: "usd" },
  budgetUsd: { label: "Budget per job", shape: "usd" },
  repeats: { label: "Runs per case", shape: "whole" },
  minPassRate: { label: "Minimum pass rate", shape: "percent" },
  latencyMs: { label: "Latency limit (ms)", shape: "number" },
  watch: { label: "Watch for new models", shape: "boolean" },
  actionPolicy: { label: "What the agent may do with a pick", shape: "text", hint: "open_pr, ask_first or instructions_only" },
  agentEvalRequired: { label: "Agent eval", shape: "text", hint: "warn or required" },
  minAgentPassRate: { label: "Minimum agent pass rate", shape: "percent" },
};
const keys = Object.keys(GUARDRAIL_KINDS) as GuardrailKey[];
const shapeOf = (key: string): Shape => settings[key as GuardrailKey]?.shape ?? "text";
const labelOf = (key: string): string => settings[key as GuardrailKey]?.label ?? key;

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
    case "number": case "whole": return Number(value);
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

function from(level: Level | undefined, here: Level): Html {
  if (!level) return html`<span class="sub">Not set</span>`;
  return level === here ? html`<span class="pill tag good">This level</span>` : html`<span class="pill tag">${level[0]?.toUpperCase()}${level.slice(1)}</span>`;
}

interface Data { tasks: Task[]; level: Level; id: string | null; guardrails: GuardrailsAt | null }

// An agent's ID is environment:agent, as the cloud app keys agent-level guardrails.
export function choices(tasks: Task[], level: Level): { id: string; label: string }[] {
  if (level === "task") return tasks.map((task) => ({ id: task.id, label: `${task.name} · ${task.environment}` }));
  if (level === "environment") return [...new Set(tasks.map((task) => task.environment))].map((id) => ({ id, label: id }));
  const agents = new Map<string, string>();
  for (const task of tasks) if (task.agent) agents.set(`${task.environment}:${task.agent}`, `${task.agent} · ${task.environment}`);
  return [...agents].map(([id, label]) => ({ id, label }));
}

export const guardrailsView: View<Data> = {
  async load({ api, params }) {
    const tasks = await api.get<Task[]>("/api/tasks");
    const asked = params.get("level");
    const level: Level = isLevel(asked) ? asked : "environment";
    const id = params.get("id") ?? choices(tasks, level)[0]?.id ?? null;
    const guardrails = id ? await api.get<GuardrailsAt>(`/api/guardrails?level=${level}&id=${encodeURIComponent(id)}`) : null;
    return { tasks, level, id, guardrails };
  },
  render({ tasks, level, id, guardrails }, { me }) {
    const top = header(me, "Guardrails", "Rules for which models OpenMerit may pick and how it measures them, set for an environment, an agent or a task. Constraints only narrow at lower levels; defaults are replaced by them.");
    const tabs = html`<nav class="tabs" aria-label="Level">${levels.map((item) => html`<a href="?level=${item.level}"${item.level === level ? html` aria-current="page"` : ""}>${item.label}</a>`)}</nav>`;
    const options = choices(tasks, level);
    if (!guardrails || !id) return html`${top}${tabs}<section>${empty(`No ${level === "environment" ? "environments" : `${level}s`} yet`, "Environments, agents and tasks appear when a coding agent first sends a task. Their guardrails can be set here then.")}</section>`;
    const here = new Map(guardrails.settings.map((setting) => [setting.key, setting.value]));
    const effective = guardrails.effective as Record<string, unknown>;
    const locked = level === "environment" && me.role !== "admin";
    const picker = html`<form class="picker" method="get"><input type="hidden" name="level" value="${level}"><label>${levels.find((item) => item.level === level)?.label}
      <select name="id" data-action="pick">${options.some((option) => option.id === id) ? "" : html`<option value="${id}" selected>${id}</option>`}${options.map((option) => html`<option value="${option.id}"${option.id === id ? html` selected` : ""}>${option.label}</option>`)}</select></label></form>`;
    return html`${top}${tabs}${picker}
    ${guardrails.rejected.length ? html`<div class="card notice warn" role="status">${guardrails.rejected.map((item) => html`<p>${labelOf(item.key)} at the ${item.level} level is not applied: it ${item.reason}.</p>`)}</div>` : ""}
    <section aria-labelledby="settings">
      <h2 id="settings">Settings</h2>
      <form data-action="save">
        <div class="tablewrap">
          <table class="guardrails">
            <thead><tr><th>Setting</th><th>Kind</th><th>Set at this level</th><th>Effective</th><th>From</th></tr></thead>
            <tbody>
              ${keys.map((key) => html`<tr>
                <td><label for="g-${key}">${labelOf(key)}</label><span class="sub"><code>${key}</code></span></td>
                <td><span class="sub">${GUARDRAIL_KINDS[key] === "constraint" ? "Constraint · only narrows" : "Default · can be replaced"}</span></td>
                <td><input id="g-${key}" name="${key}" value="${editable(key, here.get(key))}" placeholder="${settings[key].hint ?? "Inherit"}" spellcheck="false"${locked ? html` disabled` : ""}></td>
                <td>${show(key, effective[key])}</td>
                <td>${from(guardrails.from[key], level)}</td>
              </tr>`)}
            </tbody>
          </table>
        </div>
        <p class="form-error" role="alert" hidden></p>
        ${locked
          ? html`<p class="note">Only an admin of ${me.account.name} can change environment guardrails, from which every constraint starts.</p>`
          : html`<p style="margin-top: 10px"><button class="btn primary" type="submit">Save ${level} guardrails</button></p>`}
      </form>
      <p class="note">Leave a value empty to inherit it from the level above. Lists are comma-separated; caps and budgets are in US dollars per job.</p>
    </section>`;
  },
  actions: {
    async pick(target) {
      (target as HTMLSelectElement).form?.requestSubmit();
    },
    async save(form, { level, id }, { api, refresh, toast }) {
      if (!(form instanceof HTMLFormElement) || !id) return;
      const fields = new FormData(form), changes: Record<string, unknown> = {};
      for (const key of keys) {
        const value = parse(key, String(fields.get(key) ?? ""));
        if (value !== null) changes[key] = value;
      }
      const error = form.querySelector<HTMLElement>(".form-error");
      let saved: { rejected: { key: string; reason: string }[] };
      try {
        saved = await api.send("PUT", "/api/guardrails", { level, id, settings: changes });
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status !== 400 || !error) throw failure;
        error.textContent = failure.message;
        error.hidden = false;
        return;
      }
      if (isPostHogInitialized()) posthog.capture("guardrails_saved", {
        level,
        requested_setting_count: Object.keys(changes).length,
        rejected_setting_count: saved.rejected.length,
      });
      await refresh();
      toast(saved.rejected.length ? `Saved, except ${saved.rejected.map((item) => item.key).join(", ")}: not a guardrail.` : "Guardrails saved.");
    },
  },
};
