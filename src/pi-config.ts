/** Safe, explicit Pi subprocess configuration. */

import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

export interface ProviderExtensionValidation {
  valid: string[];
  errors: string[];
}

/**
 * Provider extensions execute as code. Require exact, existing, absolute files
 * and refuse OpenMerit itself so an isolated trial cannot recursively launch
 * another merit loop.
 */
export function validatePiProviderExtensions(paths: string[]): ProviderExtensionValidation {
  const valid: string[] = [];
  const errors: string[] = [];
  for (const configured of [...new Set(paths)]) {
    if (!isAbsolute(configured)) {
      errors.push(`${configured}: path is not absolute`);
      continue;
    }
    if (!existsSync(configured)) {
      errors.push(`${configured}: file does not exist`);
      continue;
    }
    let actual = configured;
    try {
      actual = realpathSync(configured);
      if (!statSync(actual).isFile()) {
        errors.push(`${configured}: path is not a file`);
        continue;
      }
    } catch (error) {
      errors.push(`${configured}: ${(error as Error).message}`);
      continue;
    }
    if (/^openmerit\.[cm]?[jt]s$/i.test(basename(actual))) {
      errors.push(`${configured}: refusing to load OpenMerit recursively`);
      continue;
    }
    valid.push(actual);
  }
  return { valid, errors };
}

export function piProviderExtensionArgs(paths: string[]): string[] {
  const checked = validatePiProviderExtensions(paths);
  if (checked.errors.length) throw new Error(`invalid pi.provider_extensions: ${checked.errors.join("; ")}`);
  return checked.valid.flatMap((file) => ["--extension", file]);
}
