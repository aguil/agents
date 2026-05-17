import { createHash } from "node:crypto";

export function fingerprint12(canonicalIngressKey: string): string {
  return createHash("sha256")
    .update(canonicalIngressKey, "utf8")
    .digest("hex")
    .slice(0, 12);
}

/**
 * Computes the leaf directory name under `{workspace}/.agents-triage/`.
 *
 * {@link producerShort} comes from `--from` (validated ASCII slug).
 */
export function computeOutputSlug(
  producerShort: string,
  canonicalIngressKey: string,
): string {
  const safeProducer = sanitizeProducerSlug(producerShort);
  const fp = fingerprint12(canonicalIngressKey);
  return `${safeProducer}-${fp}`;
}

function sanitizeProducerSlug(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(lower)) {
    throw new Error(
      `Invalid --from slug '${raw}' (expected lowercase letters, digits, hyphens only).`,
    );
  }
  return lower;
}
