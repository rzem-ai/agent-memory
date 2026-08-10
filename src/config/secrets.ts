import { readFileSync } from "node:fs";
import type { z } from "zod";
import type { SecretRefSchema } from "./schema.js";

export type SecretRef = z.infer<typeof SecretRefSchema>;

/** Resolve a SecretRef to its value. Throws when the ref resolves to nothing -
 *  a configured-but-missing secret is an operator error, never a silent skip. */
export function resolveSecret(
  reference: SecretRef | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!reference) return undefined;
  if (reference.env) {
    const value = environment[reference.env]?.trim();
    if (value) return value;
  }
  if (reference.file) {
    console.log('reference.file: ', reference.file)
    const value = readFileSync(reference.file, "utf8").trim();
    console.log('reference.file: value: ', value)
    if (value) return value;
  }
  const source = reference.env ?? reference.file ?? "unknown";
  throw new Error(`Secret ${source} is empty or unavailable`);
}
