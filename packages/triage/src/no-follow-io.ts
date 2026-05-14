import { constants as fsc } from "node:fs";
import { open } from "node:fs/promises";

const nofollow = fsc.O_NOFOLLOW ?? 0;

export async function readUtf8FileNoFollow(path: string): Promise<string> {
  const fh = await open(path, fsc.O_RDONLY | nofollow);
  try {
    return await fh.readFile("utf8");
  } finally {
    await fh.close().catch(() => {});
  }
}

export async function writeUtf8FileNoFollow(
  path: string,
  body: string,
): Promise<void> {
  const fh = await open(
    path,
    fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | nofollow,
    0o644,
  );
  try {
    await fh.writeFile(body, "utf8");
  } finally {
    await fh.close().catch(() => {});
  }
}
