// OpenRouter API client — fallback backend
// Model: openai/gpt-5.4-image-2
// Cost: $0.23/image, ~224s per image

import { isIP } from "net";

// SSRF guard for model-returned result image URLs. The model can return the
// generated image as either a `data:` URI (handled inline) or a plain URL we must
// fetch server-side. A manipulated/compromised upstream (or a model steered by a
// user-controlled prompt) could otherwise return an attacker-chosen URL and make
// the backend GET it — e.g. cloud metadata (169.254.169.254) or an internal
// service. Restrict the fetch to https URLs whose host is NOT a private,
// loopback, link-local, or otherwise non-public address.
export function assertSafeResultImageUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("OpenRouter returned a malformed result image URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`OpenRouter result image URL must use https (got ${parsed.protocol})`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new Error("OpenRouter result image URL host is not allowed");
  }
  // Reject literal IPs in private/reserved ranges. A bare hostname (DNS name) is
  // allowed; we cannot resolve+pin here without an async lookup, and the https +
  // scheme/host checks already block the most direct metadata/internal targets.
  const ipVersion = isIP(host);
  if (ipVersion !== 0 && isDisallowedIpLiteral(host, ipVersion)) {
    throw new Error("OpenRouter result image URL points at a non-public address");
  }
  return parsed;
}

// Fetch a model-returned image URL while re-applying the SSRF guard to every
// redirect hop. With the default `redirect: "follow"`, fetch would transparently
// follow a 3xx from the (validated) public host to an internal target such as
// http://169.254.169.254/ — defeating the guard. So we disable automatic
// redirects, validate each `Location` ourselves, and follow it only if it passes
// `assertSafeResultImageUrl`. A bounded hop count prevents redirect loops.
const MAX_IMAGE_REDIRECTS = 5;

async function fetchWithSafeRedirects(
  initialUrl: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  let currentUrl = assertSafeResultImageUrl(initialUrl);
  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    const response = await fetchImpl(currentUrl.toString(), { redirect: "manual" });
    // A redirect status with a Location must be re-validated before following;
    // any other status (including an opaque/typeless response) is returned as-is.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`OpenRouter image redirect ${response.status} had no Location`);
      }
      // Resolve relative redirects against the current (already-validated) URL,
      // then re-run the full SSRF guard on the absolute target.
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new Error("OpenRouter image redirect Location is malformed");
      }
      currentUrl = assertSafeResultImageUrl(nextUrl);
      continue;
    }
    return response;
  }
  throw new Error("OpenRouter image download exceeded the redirect limit");
}

function isDisallowedIpLiteral(host: string, ipVersion: number): boolean {
  if (ipVersion === 4) {
    const octets = host.split(".").map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // loopback
    if (a === 0) return true; // "this" network
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  // IPv6: block loopback, unspecified, unique-local (fc00::/7), link-local
  // (fe80::/10), and IPv4-mapped addresses that could smuggle a private v4 host.
  const normalized = host.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique-local
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true; // link-local
  if (normalized.startsWith("::ffff:")) return true; // IPv4-mapped — disallow rather than re-parse
  return false;
}

// HTTP failures carry the upstream status so callers (e.g. the official-provider
// OpenRouter adapter) can derive a retryable flag instead of guessing from a
// plain Error string.
export class OpenRouterHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OpenRouterHttpError";
  }
}

export async function translateWithOpenRouter(
  imageBuffer: Buffer,
  prompt: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<Buffer> {
  return translateWithOpenRouterModel(imageBuffer, prompt, apiKey, "openai/gpt-5.4-image-2", fetchImpl);
}

export async function translateWithOpenRouterModel(
  imageBuffer: Buffer,
  prompt: string,
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch = fetch
): Promise<Buffer> {
  const base64 = imageBuffer.toString("base64");

  const response = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${base64}` },
            },
          ],
        },
      ],
      modalities: ["image", "text"],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new OpenRouterHttpError(`OpenRouter error ${response.status}: ${text}`, response.status);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
  };

  // Extract image from response
  const images = data.choices?.[0]?.message?.images;
  if (images && images.length > 0) {
    const imageUrl = images[0]?.image_url?.url;
    if (imageUrl) {
      if (imageUrl.startsWith("data:")) {
        // base64 data URL — reject malformed URLs that lack a payload rather
        // than silently returning a zero-length Buffer (blank/invalid image).
        const commaIndex = imageUrl.indexOf(",");
        const base64Data = commaIndex >= 0 ? imageUrl.slice(commaIndex + 1) : "";
        if (base64Data.length === 0) {
          throw new Error("OpenRouter returned a malformed data URL with no base64 payload");
        }
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length === 0) {
          throw new Error("OpenRouter returned an empty image payload");
        }
        return buffer;
      }
      // Regular URL — download, but only after the SSRF guard confirms it is a
      // public https endpoint (not metadata/internal/private). The guard must be
      // re-applied to every redirect hop: validating only the first URL lets a
      // 302 from the allowed host to http://169.254.169.254/ (or any internal
      // address) bypass it, so follow redirects manually and re-validate each hop.
      const imgResp = await fetchWithSafeRedirects(imageUrl, fetchImpl);
      if (!imgResp.ok) throw new Error(`Failed to download image: ${imgResp.status}`);
      return Buffer.from(await imgResp.arrayBuffer());
    }
  }

  throw new Error("No image in OpenRouter response");
}
