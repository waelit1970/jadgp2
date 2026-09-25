import type { Config } from "@netlify/functions";

export default async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  try {
    const urlObj = new URL(req.url);
    const url = urlObj.searchParams.get("url");
    const name = urlObj.searchParams.get("name");
    const accessToken = urlObj.searchParams.get("access_token");

    if (!url) {
      return new Response("URL is required", {
        status: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    let fileName = name || "download";
    if (fileName.startsWith("horizon_")) {
      fileName = fileName.replace(/^horizon_(?:\d+_)?/, "");
    }

    console.log(`[Netlify Function Download] Downloading: ${url} with output name: ${fileName}`);

    // Handle base64 data URLs
    if (url.startsWith("data:")) {
      const matches = url.match(/^data:([^;]+);base64,(.*)$/);
      if (!matches || matches.length !== 3) {
        return new Response("Invalid data URL", {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
      const contentType = matches[1];
      const buffer = Buffer.from(matches[2], "base64");
      const asciiName = fileName.replace(/[^\x20-\x7E]/g, "_");
      return new Response(buffer, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Check if it is a Google Drive URL and extract file ID
    let isGoogleDrive = false;
    let fileId: string | null = null;
    if (url.includes("googleapis.com/drive/v3/files/")) {
      isGoogleDrive = true;
      const matches = url.match(/\/files\/([^\/?#]+)/);
      if (matches) fileId = matches[1];
    } else if (url.includes("drive.google.com") || url.includes("googleusercontent")) {
      isGoogleDrive = true;
      try {
        const u = new URL(url);
        fileId = u.searchParams.get("id");
      } catch (_) {}
    }

    // Helper function to fetch Google Drive files publicly with confirmation bypass for large files
    const fetchDrivePublic = async (fId: string): Promise<Response> => {
      const publicUrl = `https://docs.google.com/uc?export=download&id=${fId}`;
      const initialRes = await fetch(publicUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
        },
      });
      if (!initialRes.ok) {
        return initialRes;
      }

      const type = initialRes.headers.get("content-type") || "";
      if (type.includes("text/html")) {
        const cloneRes = initialRes.clone();
        const html = await cloneRes.text();

        let confirmCode = "";

        // Try from set-cookie header first
        const setCookieHeader = initialRes.headers.get("set-cookie");
        if (setCookieHeader) {
          const mCookie = setCookieHeader.match(/download_warning_[a-zA-Z0-9_-]+=(.*?)(?:;|$)/i);
          if (mCookie && mCookie[1]) {
            confirmCode = mCookie[1];
          }
        }

        // Try using getSetCookie if available
        if (!confirmCode && typeof initialRes.headers.getSetCookie === "function") {
          const cookiesArr = initialRes.headers.getSetCookie();
          for (const c of cookiesArr) {
            const mCookie = c.match(/download_warning_[a-zA-Z0-9_-]+=(.*?)(?:;|$)/i);
            if (mCookie && mCookie[1]) {
              confirmCode = mCookie[1];
              break;
            }
          }
        }

        // Parse from HTML matches as fallback
        if (!confirmCode) {
          const m1 = html.match(/confirm=([a-zA-Z0-9_-]+)/i);
          if (m1 && m1[1]) {
            confirmCode = m1[1];
          } else {
            const m2 =
              html.match(/name="confirm"\s+value="([a-zA-Z0-9_-]+)"/i) ||
              html.match(/value="([a-zA-Z0-9_-]+)"\s+name="confirm"/i) ||
              html.match(/id="confirm"\s+value="([a-zA-Z0-9_-]+)"/i);
            if (m2 && m2[1]) {
              confirmCode = m2[1];
            } else {
              const m3 =
                html.match(/id="downloadForm".*?confirm.*?value="([a-zA-Z0-9_-]+)"/s) ||
                html.match(/["']confirm["']\s*:\s*["']([a-zA-Z0-9_-]+)["']/i) ||
                html.match(/confirm\s*:\s*["']([a-zA-Z0-9_-]+)["']/i);
              if (m3 && m3[1]) {
                confirmCode = m3[1];
              } else {
                const m4 =
                  html.match(/confirm_token=([a-zA-Z0-9_-]+)/i) ||
                  html.match(/confirmToken=([a-zA-Z0-9_-]+)/i) ||
                  html.match(/&amp;confirm=([a-zA-Z0-9_-]+)/i);
                if (m4 && m4[1]) {
                  confirmCode = m4[1];
                }
              }
            }
          }
        }

        if (confirmCode) {
          console.log(`[Netlify Function Download] Found Google Drive virus warning confirm code: ${confirmCode}. Re-fetching with confirmation...`);

          let cookies = "";
          const headers: Record<string, string> = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
          };

          if (typeof initialRes.headers.getSetCookie === "function") {
            const cookiesArr = initialRes.headers.getSetCookie();
            if (cookiesArr && cookiesArr.length > 0) {
              cookies = cookiesArr.map((c) => c.split(";")[0]).join("; ");
            }
          } else {
            const rawCookies = initialRes.headers.get("set-cookie");
            if (rawCookies) {
              cookies = rawCookies
                .split(",")
                .map((c) => c.split(";")[0])
                .join("; ");
            }
          }
          if (cookies) {
            headers["Cookie"] = cookies;
          }

          const confirmUrl = `https://docs.google.com/uc?export=download&confirm=${confirmCode}&id=${fId}`;
          return fetch(confirmUrl, { headers });
        }

        // If we got HTML but expected non-HTML file
        const isExpectedHtml =
          fileName.toLowerCase().endsWith(".html") || fileName.toLowerCase().endsWith(".htm");
        if (!isExpectedHtml) {
          console.warn(`[Netlify Function Download] Public Drive fetch returned HTML but expected non-HTML file.`);
          return new Response("Google Drive permission error page or login screen.", {
            status: 403,
            headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
          });
        }
      }
      return initialRes;
    };

    let fetchRes: Response | null = null;

    // 1. Google Drive handling
    if (isGoogleDrive && fileId) {
      if (accessToken && accessToken !== "local-dummy-token") {
        try {
          console.log(`[Netlify Function Download] Trying authenticated Google Drive API download for file ID: ${fileId}...`);
          const driveApiUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
          const authRes = await fetch(driveApiUrl, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          });
          if (authRes.ok) {
            fetchRes = authRes;
          } else {
            console.warn(`[Netlify Function Download] Authenticated fetch failed with status ${authRes.status}.`);
            if (authRes.status === 401) {
              return new Response(JSON.stringify({ error: "Google Drive authentication expired or invalid." }), {
                status: 401,
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
              });
            }
          }
        } catch (authErr) {
          console.warn("[Netlify Function Download] Authenticated download error:", authErr);
        }
      }

      if (!fetchRes) {
        try {
          console.log(`[Netlify Function Download] Trying public Google Drive download for file ID: ${fileId}...`);
          const publicRes = await fetchDrivePublic(fileId);
          if (publicRes.ok) {
            fetchRes = publicRes;
          } else {
            console.warn(`[Netlify Function Download] Public download failed with status ${publicRes.status}.`);
          }
        } catch (pubErr) {
          console.warn("[Netlify Function Download] Public download error:", pubErr);
        }
      }
    } else {
      // Non-Google Drive URL handling
      if (accessToken && accessToken !== "local-dummy-token") {
        try {
          console.log(`[Netlify Function Download] Fetching non-Drive URL with token headers: ${url}`);
          const authRes = await fetch(url, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          });
          if (authRes.ok) {
            fetchRes = authRes;
          }
        } catch (authErr) {
          console.warn("[Netlify Function Download] Authenticated fetch error:", authErr);
        }
      }
    }

    // Direct fallback for non-Google Drive URLs
    if (!fetchRes && !isGoogleDrive) {
      try {
        console.log(`[Netlify Function Download] Trying direct public fetch of original URL: ${url}...`);
        const fallbackRes = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
          },
        });
        if (fallbackRes.ok) {
          fetchRes = fallbackRes;
        }
      } catch (fallbackErr) {
        console.warn("[Netlify Function Download] Direct public fetch error:", fallbackErr);
      }
    }

    if (!fetchRes || !fetchRes.ok) {
      const status = fetchRes ? fetchRes.status : 500;
      return new Response(`Failed to fetch file from source: ${status}`, {
        status: status,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    const contentType = fetchRes.headers.get("content-type") || "application/octet-stream";
    const contentLength = fetchRes.headers.get("content-length");

    const asciiName = fileName.replace(/[^\x20-\x7E]/g, "_");

    const responseHeaders = new Headers({
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Disposition, x-file-size",
    });

    if (contentLength) {
      responseHeaders.set("Content-Length", contentLength);
      responseHeaders.set("x-file-size", contentLength);
    }

    // Pass fetchRes.body directly as the response body
    return new Response(fetchRes.body, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (err: any) {
    console.error("[Netlify Function Download] Global error:", err);
    return new Response(`Server error: ${err.message}`, {
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
};

export const config: Config = {
  path: "/api/download",
};
