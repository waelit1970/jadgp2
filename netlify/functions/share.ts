/**
 * Web Share Target receiver (server-side backup).
 * Handles the POST that the manifest declares at action "/share" — this works even when the
 * Service Worker is not controlling the page (first launch after install, after an update, etc.).
 *
 * UPDATED 2026-09: reports honestly when no file part arrived instead of silently succeeding.
 * UPDATED 2026-09: Cloudflare R2 removed entirely — catbox.moe is the only remote uploader,
 * and when it fails the caller falls back to inline handling.
 */
import type { Config } from "@netlify/functions";

/**
 * Stores a received share file on catbox.moe — the free host the app already uses for media links.
 * catbox limit: 200MB per file, direct link with the original extension, no account needed.
 * NOTE: catbox rejects datacenter IPs, so this often fails from the server and succeeds from the
 * user's browser — that is why callers must handle a null return instead of assuming success.
 */
async function uploadSharedMedia(file: File): Promise<string | null> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const name = file.name && file.name.includes(".") ? file.name : "shared.jpg";
  const contentType = file.type || "application/octet-stream";

  try {
    const fd = new FormData();
    fd.append("reqtype", "fileupload");
    fd.append("fileToUpload", new Blob([buffer], { type: contentType }), name);
    const res = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: fd });
    const text = (await res.text()).trim();
    if (res.ok && /^https?:\/\//.test(text)) {
      return text;
    }
    console.error("[share] catbox upload failed:", res.status, text.slice(0, 200));
  } catch (e) {
    console.error("[share] catbox error:", e);
  }

  return null;
}

export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const params = new URLSearchParams({ shared: "true" });

  try {
    const form = await req.formData();
    const title = String(form.get("title") || "");
    const text = String(form.get("text") || "");
    const url = String(form.get("url") || "");
    if (title) params.set("title", title);
    if (text) params.set("text", text);
    if (url) params.set("url", url);

    const file = form.get("media");
    if (file instanceof File && file.size > 0) {
      const publicUrl = await uploadSharedMedia(file);
      if (publicUrl) {
        params.set("sharedImageUrl", publicUrl);
      } else {
        params.set("sharedNoFile", "true");
        params.set("sharedUploadFailed", "true");
      }
    } else {
      params.set("sharedNoFile", "true");
    }
  } catch (e: any) {
    params.set("sharedError", String(e?.message || e));
  }

  return new Response(null, {
    status: 303,
    headers: { Location: `/?${params.toString()}` },
  });
};

export const config: Config = { path: "/share" };
