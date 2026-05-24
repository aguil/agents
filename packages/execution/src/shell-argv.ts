/** Parse a shell-style command string into argv (supports single/double quotes). */
export function parseShellArgv(command: string): readonly string[] {
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (inSingle) {
      if (char === "'") {
        inSingle = false;
      } else {
        current += char;
      }
      continue;
    }
    if (inDouble) {
      if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inDouble = false;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'") {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}
