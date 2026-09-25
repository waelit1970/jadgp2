/**
 * Share diagnostics endpoint (2026-09).
 * Android Chrome has no devtools console, so the app reports every share attempt here
 * and we read the result server-side with:  netlify logs:function share-diag
 * It stores nothing and returns immediately.
 */
import type { Config } from "@netlify/functions";

const cors = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    console.log("[SHARE-DIAG] " + JSON.stringify(body));
  } catch (e) {
    console.error("[SHARE-DIAG] failed to parse payload", e);
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
};

export const config: Config = { path: "/api/share-diag" };
