export {};

const input = await Bun.stdin.text();
const line = input.trim().split("\n")[0] ?? "{}";
const request = JSON.parse(line) as {
  readonly id?: string;
  readonly method?: string;
};

const base = {
  session_id: "sess-fake",
  thread_id: "thread-fake",
  turn_id: "turn-0",
  input_tokens: 1,
  output_tokens: 2,
  total_tokens: 3,
};

const lines =
  request.method === "session.start"
    ? [
        { event: "session_started", ...base },
        { event: "turn_completed", ...base },
      ]
    : [{ event: "turn_completed", ...base }];

for (const result of lines) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: request.id ?? "unknown", result })}\n`,
  );
}
