import posthog from "posthog-js";
import type { AppConfig } from "./auth.ts";

let initialized = false;

// The Worker supplies these public browser settings from its environment bindings.
export function initializePostHog(config: AppConfig): void {
  if (initialized) return;
  if (!config.posthogKey || !config.posthogHost) {
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      const missing = config.posthogKey ? "POSTHOG_HOST" : "POSTHOG_KEY";
      console.error(new Error(`${missing} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missing} is configured`));
    }
    return;
  }

  posthog.init(config.posthogKey, {
    api_host: config.posthogHost,
    defaults: "2026-08-30",
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    logs: {
      serviceName: "openmerit-web",
      environment: location.hostname === "localhost" || location.hostname === "127.0.0.1" ? "development" : "production",
    },
  });
  initialized = true;
  logPostHog("log_capture_initialized", { runtime: "browser" });
}

// Only purpose-written integration records use the PostHog logger; browser console output stays local.
export function logPostHog(message: "log_capture_initialized" | "app_view_rendered", attributes: Record<string, string>): void {
  if (initialized) posthog.logger.info(message, attributes);
}

export const isPostHogInitialized = (): boolean => initialized;

export default posthog;
