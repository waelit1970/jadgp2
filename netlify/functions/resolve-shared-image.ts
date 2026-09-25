/**
 * Lead-image resolver for shared links (og:image / twitter:image).
 * POST /api/resolve-shared-image   { url }
 * Auth: Bearer <firebase idToken> — same rule as the Express version in server.ts.
 * SSRF-guarded and capped at 25MB. Added 2026-09 because this endpoint existed ONLY in the
 * Express server, so on Netlify the client's fallback hit the SPA catch-all and silently failed.
 */
import type { Config } from "@netlify/functions";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const headers: Record<string, string> = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(".")) return false;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host === "::1") return false;
  return true;
}

async function isSignedIn(req: Request): Promise<boolean> {
  const key = process.env.FIREBASE_WEB_API_KEY;
  const auth = req.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!key || !token) return false;
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: token }),
    });
    if (!r.ok) return false;
    const d = (await r.json()) as { users?: unknown[] };
    return Array.isArray(d.users) && d.users.length > 0;
  } catch {
    return false;
  }
}

/**
 * يرفع إلى catbox.moe فقط — أُزيل Cloudflare R2 بالكامل (2026-09).
 * يعيد null عند الفشل (catbox يرفض مراكز البيانات غالباً) فيتولى المستدعي النقل المضمّن.
 */
async function uploadBuffer(buf: Buffer, name: string, contentType: string): Promise<string | null> {
  try {
    const fd = new FormData();
    fd.append("reqtype", "fileupload");
    fd.append("fileToUpload", new Blob([buf], { type: contentType }), name);
    const res = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: fd });
    const text = (await res.text()).trim();
    if (res.ok && /^https?:\/\//.test(text)) return text;
    console.error("[resolve-shared-image] catbox failed:", res.status, text.slice(0, 200));
  } catch (e) {
    console.error("[resolve-shared-image] catbox error:", e);
  }
  return null;
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!(await isSignedIn(req))) {
    const bearer = req.headers.get("authorization") || "";
    console.warn(
      "[resolve-shared-image] UNAUTHORIZED hasBearer=" + !!bearer + " hasKey=" + !!process.env.FIREBASE_WEB_API_KEY
    );
    return json({ error: "يلزم تسجيل الدخول لاستخراج صورة من رابط." }, 401);
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { url?: unknown };
    const url = typeof body.url === "string" ? body.url : "";
    if (!url || !isPublicHttpUrl(url)) return json({ error: "رابط غير صالح" }, 400);

    const page = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9,ar;q=0.8" },
    });
    const html = await page.text();
    const pick = (re: RegExp) => {
      const m = html.match(re);
      return m ? m[1].trim() : "";
    };
    let imageUrl =
      pick(/<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i) ||
      pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
      pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
      pick(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
    if (!imageUrl) {
      console.warn("[resolve-shared-image] NO_OGIMAGE pageStatus=" + page.status + " htmlBytes=" + html.length + " url=" + url);
      return json({ error: "لم يُعثر على صورة في الصفحة المشاركة" }, 404);
    }

    imageUrl = imageUrl.replace(/&amp;/g, "&");
    if (!isPublicHttpUrl(imageUrl)) return json({ error: "رابط الصورة غير صالح" }, 400);

    const imgRes = await fetch(imageUrl, { headers: { "User-Agent": UA, Referer: url } });
    if (!imgRes.ok) {
      console.warn("[resolve-shared-image] IMG_FETCH_FAIL " + imgRes.status + " " + imageUrl);
      return json({ error: `تعذّر تنزيل الصورة (${imgRes.status})` }, 502);
    }

    const buf = Buffer.from(await imgRes.arrayBuffer());
    if (buf.byteLength > 25 * 1024 * 1024) return json({ error: "حجم الصورة كبير جداً" }, 413);

    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    const ext = contentType.includes("png")
      ? ".png"
      : contentType.includes("webp")
        ? ".webp"
        : contentType.includes("gif")
          ? ".gif"
          : ".jpg";
    const publicUrl = await uploadBuffer(buf, `shared_link_${Date.now()}${ext}`, contentType);
    if (!publicUrl) {
      if (buf.byteLength > 3_500_000) {
        console.warn("[resolve-shared-image] UPLOAD_FAIL_INLINE_TOO_BIG bytes=" + buf.byteLength);
        return json({ error: "\u0641\u0634\u0644 \u0631\u0641\u0639 \u0627\u0644\u0635\u0648\u0631\u0629 \u0627\u0644\u0645\u0633\u062a\u062e\u0631\u062c\u0629 (\u062d\u062c\u0645 \u0643\u0628\u064a\u0631)" }, 502);
      }
      console.warn("[resolve-shared-image] UPLOAD_FAIL_INLINE bytes=" + buf.byteLength);
      return json({ dataUrl: "data:" + contentType + ";base64," + buf.toString("base64"), sourceImageUrl: imageUrl, inline: true });
    }

    console.log("[resolve-shared-image] OK " + JSON.stringify({ src: imageUrl, publicUrl, bytes: buf.byteLength, contentType }));
    return json({ publicUrl, sourceImageUrl: imageUrl });
  } catch (err) {
    console.error("[resolve-shared-image] Error:", err);
    return json({ error: "فشل جلب الصورة من الرابط" }, 500);
  }
};

export const config: Config = { path: "/api/resolve-shared-image" };
