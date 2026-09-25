/**
 * Shared server-side authentication helper (security fix 2026-09).
 * Verifies a Firebase ID token before ANY privileged operation runs.
 * The Firebase Web API key is a public project identifier, not a secret.
 */
const FIREBASE_WEB_API_KEY =
  process.env.FIREBASE_WEB_API_KEY || "AIzaSyCPAJ7XTjpGTxquswxDndKff4XFmH4CvE4";

export async function requireSignedInUser(req: Request): Promise<{ email: string } | null> {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: token }),
      }
    );
    const data: any = await res.json();
    const email = data?.users?.[0]?.email;
    if (!res.ok || !email) return null;
    return { email: String(email).toLowerCase() };
  } catch {
    return null;
  }
}
