/**
 * Piper dashboard HTTP handler.
 *
 * Serves the Piper SPA at /piper/* from the control UI build output.
 * Extracted from server-http.ts to keep the upstream file conflict-free.
 */
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import pathMod from "node:path";
import type { ControlUiRootState } from "../gateway/control-ui.js";

export function handlePiperRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
  controlUiRoot?: ControlUiRootState,
): boolean {
  if (!requestPath.startsWith("/piper")) {
    return false;
  }
  if (!controlUiRoot || controlUiRoot.kind === "missing" || controlUiRoot.kind === "invalid") {
    return false;
  }
  const piperDir = pathMod.join(controlUiRoot.path, "piper");

  let relativePath = requestPath.slice("/piper".length) || "/";
  if (relativePath === "/") {
    relativePath = "/index.html";
  }

  // Try to serve the exact file (for assets like .js, .css)
  const filePath = pathMod.join(piperDir, relativePath);
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      const ext = pathMod.extname(filePath).toLowerCase();
      const contentTypes: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".map": "application/json",
      };
      res.writeHead(200, { "Content-Type": contentTypes[ext] ?? "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
      return true;
    }
  } catch {
    // File not found — fall through to SPA fallback
  }

  // SPA fallback: serve index.html for all /piper/* routes
  const indexPath = pathMod.join(piperDir, "index.html");
  try {
    const html = fs.readFileSync(indexPath, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return true;
  } catch {
    return false;
  }
}
