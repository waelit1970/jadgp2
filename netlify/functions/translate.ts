import type { Config } from "@netlify/functions";

// Realistic browser User-Agent pool for rotation
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.3; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
];

function getRandomUserAgent(): string {
  const index = Math.floor(Math.random() * USER_AGENTS.length);
  return USER_AGENTS[index];
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
}

/**
 * Multi-layer Google & Open Proxy Translator:
 * Layer 1: Google POST translate_a/single (clients: gtx, dict-chrome-ex, webapp)
 * Layer 2: clients5.google.com Chrome extension official endpoint
 * Layer 3: Google Mobile Web Translator (translate.google.com/m) - completely immune to IP blocks
 * Layer 4: Lingva open-source mirror instances
 */
async function translateViaGoogleProxy(text: string, sl: string, tl: string): Promise<string> {
  const source = sl || "auto";

  // --- Layer 1: Google translate_a/single with client rotation ---
  const clients = ["gtx", "dict-chrome-ex", "webapp"];
  for (const client of clients) {
    const userAgent = getRandomUserAgent();
    const headers = {
      "User-Agent": userAgent,
      "Accept": "*/*",
      "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      "Referer": "https://translate.google.com/",
      "Origin": "https://translate.google.com",
    };

    try {
      const params = new URLSearchParams();
      params.append("client", client);
      params.append("sl", source);
      params.append("tl", tl);
      params.append("dt", "t");
      params.append("q", text);

      const postRes = await fetch("https://translate.googleapis.com/translate_a/single", {
        method: "POST",
        headers,
        body: params.toString(),
      });

      if (postRes.ok) {
        const data = await postRes.json();
        if (data && Array.isArray(data[0])) {
          const result = data[0]
            .map((item: any) => (item && typeof item[0] === "string" ? item[0] : ""))
            .filter(Boolean)
            .join("");
          if (result && result.trim()) {
            return result;
          }
        }
      }
    } catch {}
  }

  // --- Layer 2: clients5.google.com Chrome Extension endpoint ---
  try {
    const c5Url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`;
    const c5Res = await fetch(c5Url, {
      headers: { "User-Agent": getRandomUserAgent() },
    });
    if (c5Res.ok) {
      const c5Data = await c5Res.json();
      if (Array.isArray(c5Data)) {
        const parsed = typeof c5Data[0] === "string" ? c5Data[0] : Array.isArray(c5Data[0]) ? c5Data[0][0] : "";
        if (parsed && typeof parsed === "string" && parsed.trim()) {
          return parsed;
        }
      }
    }
  } catch {}

  // --- Layer 3: Google Mobile Web (Never blocks serverless or datacenter IPs) ---
  try {
    const mUrl = `https://translate.google.com/m?sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`;
    const mRes = await fetch(mUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (mRes.ok) {
      const html = await mRes.text();
      const match = html.match(/<div[^>]*class=["']result-container["'][^>]*>([\s\S]*?)<\/div>/i);
      if (match && match[1]) {
        const decoded = decodeHtmlEntities(match[1].trim());
        if (decoded) return decoded;
      }
    }
  } catch {}

  // --- Layer 4: Lingva Open Mirror Fallback ---
  const lingvaHosts = [
    "https://lingva.ml",
    "https://translate.plausibility.cloud",
    "https://lingva.garudalinux.org",
  ];
  for (const host of lingvaHosts) {
    try {
      const lUrl = `${host}/api/v1/${encodeURIComponent(source)}/${encodeURIComponent(tl)}/${encodeURIComponent(text)}`;
      const lRes = await fetch(lUrl, {
        headers: { "User-Agent": getRandomUserAgent() },
      });
      if (lRes.ok) {
        const lData = await lRes.json();
        if (lData?.translation && typeof lData.translation === "string") {
          return lData.translation;
        }
      }
    } catch {}
  }

  throw new Error("All translation proxy layers were exhausted.");
}

export default async (req: Request) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const body = await req.json().catch(() => ({}));
    const { text, sourceLang = "auto", targetLang = "en", provider = "google" } = body;

    const trimmedText = typeof text === "string" ? text.trim() : "";
    if (!trimmedText) {
      return new Response(
        JSON.stringify({ success: true, text: "", provider }),
        { status: 200, headers: corsHeaders }
      );
    }

    const sl = (sourceLang || "auto").toLowerCase();
    const tl = (targetLang || "en").toLowerCase();

    // ==========================================
    // 1. DeepL AI
    // ==========================================
    if (provider === "deepl") {
      const deeplApiKey = process.env.DEEPL_API_KEY || process.env.DEEPL_AUTH_KEY;
      if (!deeplApiKey) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "DEEPL_API_KEY_MISSING",
            message: "يرجى إضافة DEEPL_API_KEY في إعدادات البيئة (Environment Variables) في Netlify.",
            provider: "deepl",
          }),
          { status: 200, headers: corsHeaders }
        );
      }

      const isFreeApi = deeplApiKey.trim().endsWith(":fx");
      const deeplBaseUrl = isFreeApi
        ? "https://api-free.deepl.com/v2/translate"
        : "https://api.deepl.com/v2/translate";

      let deeplTarget = tl.toUpperCase();
      if (deeplTarget === "EN") deeplTarget = "EN-US";
      if (deeplTarget === "PT") deeplTarget = "PT-PT";

      const deeplParams = new URLSearchParams();
      deeplParams.append("text", trimmedText);
      deeplParams.append("target_lang", deeplTarget);
      if (sl !== "auto") {
        deeplParams.append("source_lang", sl.toUpperCase());
      }

      const deeplRes = await fetch(deeplBaseUrl, {
        method: "POST",
        headers: {
          Authorization: `DeepL-Auth-Key ${deeplApiKey.trim()}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: deeplParams.toString(),
      });

      if (!deeplRes.ok) {
        const errText = await deeplRes.text();
        console.error("[Netlify Translate] DeepL API Error:", deeplRes.status, errText);
        return new Response(
          JSON.stringify({
            success: false,
            error: `DeepL API Error (${deeplRes.status}): ${errText}`,
            provider: "deepl",
          }),
          { status: 200, headers: corsHeaders }
        );
      }

      const deeplData = await deeplRes.json();
      if (deeplData?.translations?.[0]?.text) {
        return new Response(
          JSON.stringify({
            success: true,
            text: deeplData.translations[0].text,
            provider: "deepl",
          }),
          { status: 200, headers: corsHeaders }
        );
      }
    }

    // ==========================================
    // 2. Cloudflare AI (LLaMA 3.1 8B Instruct)
    // ==========================================
    if (provider === "cloudflare") {
      const cfToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_WORKERS_AI_TOKEN || process.env.CF_API_TOKEN;
      const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || "34f9463075323fcc24465815b79199f4";

      if (!cfToken) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "CLOUDFLARE_API_TOKEN_MISSING",
            message: "يرجى إضافة CLOUDFLARE_API_TOKEN في إعدادات البيئة (Environment Variables) في Netlify.",
            provider: "cloudflare",
          }),
          { status: 200, headers: corsHeaders }
        );
      }

      const langNames: Record<string, string> = {
        ar: "Arabic",
        en: "English",
        fr: "French",
        es: "Spanish",
        de: "German",
        it: "Italian",
        tr: "Turkish",
        ru: "Russian",
        zh: "Chinese (Simplified)",
        ja: "Japanese",
      };

      const targetLangName = langNames[tl] || tl;
      const sourceLangName = sl !== "auto" ? (langNames[sl] || sl) : "the source language";

      const translateWithLLM = async (modelName: string): Promise<string> => {
        const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/${modelName}`;
        const response = await fetch(cfUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cfToken.trim()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: [
              {
                role: "system",
                content: `You are an expert, fluent multilingual translator. Translate the text into ${targetLangName}. Output ONLY the raw translated text with NO commentary, NO quotes, NO conversational markdown. Preserve formatting and line breaks.`,
              },
              {
                role: "user",
                content: `Translate the following text from ${sourceLangName} to ${targetLangName}:\n\n${trimmedText}`,
              },
            ],
            temperature: 0.1,
            max_tokens: 2500,
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Cloudflare AI ${modelName} error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        let resultText = data?.result?.response || data?.result?.translated_text || "";
        if (typeof resultText === "string") {
          resultText = resultText.trim();
          if ((resultText.startsWith('"') && resultText.endsWith('"')) || (resultText.startsWith('“') && resultText.endsWith('”'))) {
            resultText = resultText.slice(1, -1).trim();
          }
          return resultText;
        }
        throw new Error(`Invalid response format from Cloudflare AI ${modelName}`);
      };

      try {
        const translated = await translateWithLLM("@cf/meta/llama-3.1-8b-instruct");
        if (translated && translated.trim()) {
          return new Response(
            JSON.stringify({ success: true, text: translated, provider: "cloudflare" }),
            { status: 200, headers: corsHeaders }
          );
        }
      } catch (cfErr: any) {
        console.warn("[Netlify Translate] Cloudflare LLaMA 3.1 failed, trying fallback:", cfErr.message || cfErr);
        try {
          const fallbackTranslated = await translateWithLLM("@cf/meta/llama-3-8b-instruct");
          if (fallbackTranslated && fallbackTranslated.trim()) {
            return new Response(
              JSON.stringify({ success: true, text: fallbackTranslated, provider: "cloudflare" }),
              { status: 200, headers: corsHeaders }
            );
          }
        } catch (fbErr: any) {
          console.error("[Netlify Translate] Cloudflare fallback failed:", fbErr);
        }
      }
    }

    // ==========================================
    // 3. Multi-Layer Google & Open Proxy Engine
    // ==========================================
    try {
      const translatedText = await translateViaGoogleProxy(trimmedText, sl, tl);
      if (translatedText && translatedText.trim()) {
        return new Response(
          JSON.stringify({ success: true, text: translatedText, provider: "google" }),
          { status: 200, headers: corsHeaders }
        );
      }
    } catch (googleProxyErr: any) {
      console.warn("[Netlify Translate] Google proxy error:", googleProxyErr.message || googleProxyErr);
    }

    return new Response(
      JSON.stringify({ success: false, error: "Translation proxy failed", provider }),
      { status: 500, headers: corsHeaders }
    );
  } catch (error: any) {
    console.error("[Netlify Translate] Fatal error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || "Translation failed", provider: "unknown" }),
      { status: 500, headers: corsHeaders }
    );
  }
};

export const config: Config = {
  path: "/api/translate",
};
