import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { credentialsPath, readCredentials } from "../../terminal/src/scout-credentials.ts";
import { scoutRule, scoutSkill } from "../../terminal/src/scout-instructions.ts";

// The installed bundle lives beside this tiny, installer-owned connection file.
// Resolve it at session startup, not at import time or on every model turn.
function configuredCredentialsPath(): string {
  const config = new URL("./openmerit-scout.json", import.meta.url);
  let value: unknown;
  try {
    if (statSync(config).size > 16_384) throw new Error("Invalid Scout connection config");
    value = JSON.parse(readFileSync(config, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return credentialsPath("pi", "user", process.cwd());
    }
    throw new Error("Invalid Scout connection config");
  }
  if (!value || typeof value !== "object" || !("credentialsPath" in value)
    || typeof value.credentialsPath !== "string" || !value.credentialsPath.trim()) {
    throw new Error("Invalid Scout connection config");
  }
  return value.credentialsPath;
}

export function createScoutPiExtension(options: { credentialsPath?: string } = {}): ExtensionFactory {
  return (pi) => {
    pi.on("session_start", (_event, ctx) => {
      try {
        const credentials = readCredentials(options.credentialsPath ?? configuredCredentialsPath());
        if (!credentials) throw new Error("Scout credentials missing");
        pi.registerMcpServer("openmerit", {
          type: "http",
          url: `${credentials.server}/scout/mcp`,
          headers: { ...credentials.headers, Authorization: `Bearer ${credentials.key}` },
          exposure: "direct",
        });
      } catch {
        // Never surface parser, filesystem, or registration errors: they can
        // include credential/config contents. Setup is always an explicit act.
        ctx.ui.notify(
          "OpenMerit Scout could not load its connection. Run `npx -y openmerit@latest install --client pi --scope user` "
          + "(use `--scope project` for a project installation), then start a new Pi session. "
          + "SDK hosts must also load Pi's createMcpExtension().",
          "warning",
        );
      }
    });

    pi.on("before_agent_start", (event) => {
      // Mutate only our named sections; leave the host prompt, model, tool
      // allow/exclude lists, and all other extension sections untouched.
      event.systemPromptOptions.sections.openmerit_scout_rule = scoutRule("pi");
      event.systemPromptOptions.sections.openmerit_scout_skill = scoutSkill("pi");
    });
  };
}

export default createScoutPiExtension();
