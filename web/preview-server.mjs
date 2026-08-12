import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT || 3000);
const backend = process.env.VYNTRA_API_URL || "http://localhost:8000";
const root = fileURLToPath(new URL(".", import.meta.url));

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

async function proxyApi(request, response) {
  const target = new URL(request.url || "/", backend);
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const upstream = await fetch(target, {
    method: request.method,
    headers: {
      "content-type": request.headers["content-type"] || "application/json",
      authorization: request.headers.authorization || "",
      "x-admin-token": request.headers["x-admin-token"] || "",
    },
    body,
  });
  const text = await upstream.text();
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json",
  });
  response.end(text);
}

async function serveFile(pathname, response) {
  const safePath = pathname === "/" ? "/preview.html" : pathname;
  const filePath = join(root, safePath.replace(/^\/+/, ""));
  const content = await readFile(filePath);
  response.writeHead(200, {
    "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
  });
  response.end(content);
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://localhost:${port}`);
    if (url.pathname.startsWith("/api/")) {
      await proxyApi(request, response);
      return;
    }
    await serveFile(url.pathname, response);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : "Preview server error");
  }
}).listen(port, () => {
  console.log(`VYNTRA preview running at http://localhost:${port}`);
  console.log(`Proxying API requests to ${backend}`);
});
