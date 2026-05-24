const port = Number(process.env.PORT ?? 18765);

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/selection") {
      const body = await req.json();
      console.log(JSON.stringify({ event: "notify_receiver", body }));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (req.method === "GET" && url.pathname === "/") {
      return new Response("agentsd notify receiver\n", {
        headers: { "content-type": "text/plain" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`notify receiver listening on http://127.0.0.1:${port}`);
