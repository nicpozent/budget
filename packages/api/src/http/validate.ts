/**
 * Schema validation at the boundary (SEC-022).
 *
 * Failures are reported as field -> message using our own wording. Zod's raw
 * issue objects are not serialised: they can echo the received value back,
 * which turns an error response into a reflection surface.
 */

import type { z } from 'zod';
import { validationFailed } from './errors.ts';

export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    // Keep the first message per field; later ones are usually consequences.
    if (!(key in fields)) fields[key] = issue.message;
  }
  throw validationFailed(fields);
}
