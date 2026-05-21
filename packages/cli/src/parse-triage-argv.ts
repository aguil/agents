/** Parse argv slice after `agents triage` (optional legacy `ingest` token stripped by caller). */

export interface TriageCliOptions {
  readonly from: string;
  readonly workspace?: string;
  readonly result?: string;
  readonly format: "json" | "toon" | "both";
  /** True when the user passed `--format` (including `=…` forms). */
  readonly formatExplicit: boolean;
  readonly outputDir?: string;
  readonly stdout?: boolean;
}

export type ParseTriageArgvResult =
  | { readonly ok: true; readonly options: TriageCliOptions }
  | { readonly ok: false; readonly error: string };

function consumeEqualsValue(token: string): {
  readonly key: string;
  value?: string;
} {
  const idx = token.indexOf("=");
  if (idx < 0) {
    return { key: token };
  }
  return {
    key: token.slice(0, idx),
    value: token.length > idx + 1 ? token.slice(idx + 1) : undefined,
  };
}

/** Legacy `agents triage ingest …` forwards to the same parser after skipping `ingest`. */
export function stripLegacyTriageIngestArgv(
  argv: readonly string[],
): readonly string[] {
  return argv.length > 0 && argv[0] === "ingest" ? argv.slice(1) : argv;
}

export function parseTriageArgv(
  argv: readonly string[],
): ParseTriageArgvResult {
  let from: string | undefined;
  let workspace: string | undefined;
  let result: string | undefined;
  let format: "json" | "toon" | "both" | undefined;
  let formatExplicit = false;
  let outputDir: string | undefined;
  let stdout = false;

  let i = 0;
  while (i < argv.length) {
    const raw = argv[i];
    if (raw === undefined) {
      break;
    }

    if (raw === "--stdout") {
      stdout = true;
      i += 1;
      continue;
    }

    if (!raw.startsWith("--")) {
      return {
        ok: false,
        error: `Unexpected positional argument '${raw}'.`,
      };
    }

    const { key: optKeyRaw, value: eqVal } = consumeEqualsValue(raw.slice(2));

    let value: string | undefined = eqVal;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        if (optKeyRaw === "stdout") {
          return {
            ok: false,
            error: `--${optKeyRaw} does not accept a separate value.`,
          };
        }
        return {
          ok: false,
          error: `--${optKeyRaw} expects a value.`,
        };
      }
      value = next;
      i += 2;
    } else {
      i += 1;
    }

    switch (optKeyRaw) {
      case "from":
        from = value?.trim();
        break;
      case "workspace":
        workspace = value?.trim();
        break;
      case "result":
        result = value?.trim();
        break;
      case "format": {
        formatExplicit = true;
        const v = value?.trim();
        if (v !== "json" && v !== "toon" && v !== "both") {
          return {
            ok: false,
            error: `--format expects json, toon, or both (got '${value ?? ""}').`,
          };
        }
        format = v;
        break;
      }
      case "output":
        outputDir = value?.trim();
        break;
      default:
        return { ok: false, error: `Unknown option '--${optKeyRaw}'.` };
    }
  }

  const fromFinal = from?.trim();
  if (fromFinal === undefined || fromFinal === "" || fromFinal.includes(" ")) {
    return {
      ok: false,
      error:
        "--from <producer> is required (supported: code-review, pr-feedback).",
    };
  }

  const formatFinal = format ?? "both";

  if (stdout === true && formatFinal === "both") {
    return {
      ok: false,
      error:
        "--stdout requires --format json or --format toon (omit --stdout for dual file writes).",
    };
  }

  const options: TriageCliOptions = {
    from: fromFinal,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(result !== undefined ? { result } : {}),
    format: formatFinal,
    formatExplicit,
    ...(outputDir !== undefined ? { outputDir } : {}),
    ...(stdout === true ? { stdout } : {}),
  };

  return { ok: true, options };
}
