/**
 * Deterministic health signal for the incident-triage example.
 *
 * Deliberately NOT a `*.test.ts` file: the repository test runner must not
 * pick it up. The verify role (and CI assertions) run `bun run check.ts`
 * from this directory and read the exit code: 0 = healthy, 1 = incident
 * still present.
 */
import { paginate } from "./src/pagination";

interface Failure {
  readonly name: string;
  readonly detail: string;
}

const failures: Failure[] = [];

function check(name: string, condition: boolean, detail: string): void {
  if (!condition) {
    failures.push({ name, detail });
  }
}

const items = ["a", "b", "c", "d", "e"];

const firstPage = paginate(items, 0, 2);
check(
  "first page is full",
  firstPage.items.length === 2 && firstPage.items[1] === "b",
  `expected ["a","b"], got ${JSON.stringify(firstPage.items)}`,
);

const secondPage = paginate(items, firstPage.nextCursor ?? items.length, 2);
check(
  "second page continues without gaps",
  secondPage.items[0] === "c",
  `expected page starting at "c", got ${JSON.stringify(secondPage.items)}`,
);

let collected: string[] = [];
let cursor: number | undefined = 0;
while (cursor !== undefined) {
  const page = paginate(items, cursor, 2);
  collected = collected.concat([...page.items]);
  cursor = page.nextCursor;
}
check(
  "walking all pages yields every item exactly once",
  JSON.stringify(collected) === JSON.stringify(items),
  `expected ${JSON.stringify(items)}, got ${JSON.stringify(collected)}`,
);

if (failures.length > 0) {
  console.error(`INCIDENT CHECK FAILED (${failures.length} failing checks)`);
  for (const failure of failures) {
    console.error(`- ${failure.name}: ${failure.detail}`);
  }
  process.exit(1);
}
console.log("INCIDENT CHECK PASSED: pagination healthy");
