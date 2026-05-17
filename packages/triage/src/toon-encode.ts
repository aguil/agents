type ToonEncode = (plain: Record<string, unknown>) => string;

let encodeResolved: ToonEncode | undefined;
let encodeRejected: Error | undefined;

/** Loads `@toon-format/toon` once; throws a stable error if unavailable or invalid. */
export async function loadToonEncode(): Promise<ToonEncode> {
  if (encodeRejected !== undefined) {
    throw encodeRejected;
  }
  if (encodeResolved !== undefined) {
    return encodeResolved;
  }
  try {
    const mod = (await import("@toon-format/toon")) as {
      readonly encode?: unknown;
    };
    if (typeof mod.encode !== "function") {
      throw new Error("@toon-format/toon exports no encode function.");
    }
    encodeResolved = mod.encode as ToonEncode;
    return encodeResolved;
  } catch (cause) {
    encodeRejected = new Error(
      "@toon-format/toon is not installed or failed to load. Install it to use --format toon or --format both, or use --format json.",
      { cause: cause instanceof Error ? cause : undefined },
    );
    throw encodeRejected;
  }
}

/** True when `loadToonEncode()` succeeds (result is cached for the process lifetime). */
export async function isToonEncodeAvailable(): Promise<boolean> {
  try {
    await loadToonEncode();
    return true;
  } catch {
    return false;
  }
}
