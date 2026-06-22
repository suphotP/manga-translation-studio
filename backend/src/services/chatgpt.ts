// ChatGPT API client — primary backend (g4f-style)
// Uses HAR auth method from desktop editor
// Cost: free, ~41s per image

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parseJsonText } from "../utils/json-file.js";

const HAR_PATH = join(homedir(), ".g4f", "cookies", "chatgpt.har");

interface HarConfig {
  accessToken: string;
  proofToken: string;
  cookies: Record<string, string>;
  deviceId: string;
}

interface HarSnapshot {
  log: {
    entries: Array<{
      request: {
        headers: Array<{ name: string; value: string }>;
        cookies?: Array<{ name: string; value: string }>;
      };
    }>;
  };
}

function loadHarConfig(): HarConfig | null {
  if (!existsSync(HAR_PATH)) return null;

  try {
    const har = parseJsonText<HarSnapshot>(readFileSync(HAR_PATH, "utf-8"));
    const entry = har.log.entries[0];
    if (!entry) return null;

    const headers: Record<string, string> = {};
    for (const h of entry.request.headers) {
      headers[h.name.toLowerCase()] = h.value;
    }

    const cookies: Record<string, string> = {};
    for (const c of entry.request.cookies || []) {
      cookies[c.name] = c.value;
    }

    const accessToken = (headers["authorization"] || "").replace("Bearer ", "");
    const proofToken = headers["openai-sentinel-proof-token"] || "";
    const deviceId = headers["oai-device-id"] || "";

    if (!accessToken || !proofToken) return null;

    return { accessToken, proofToken, cookies, deviceId };
  } catch {
    return null;
  }
}

export async function translateWithChatGPT(
  imageBuffer: Buffer,
  prompt: string
): Promise<Buffer> {
  const config = loadHarConfig();
  if (!config) {
    throw new Error("ChatGPT HAR file not configured. Place HAR at ~/.g4f/cookies/chatgpt.har");
  }

  const base64 = imageBuffer.toString("base64");

  // Build request body
  const body = {
    action: "next",
    messages: [
      {
        role: "system",
        content: "You are an expert manhwa/comic typesetter.",
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: `data:image/webp;base64,${base64}`,
          },
          { type: "text", text: prompt },
        ],
      },
    ],
    model: "gpt-5.5",
    timezone_offset_min: -420,
    timezone: "Asia/Bangkok",
    conversation_mode: { kind: "primary_assistant" },
    supports_buffering: true,
    supported_encodings: ["v1"],
  };

  // Build headers from HAR config
  const cookieStr = Object.entries(config.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  const headers: Record<string, string> = {
    accept: "text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${config.accessToken}`,
    "oai-device-id": config.deviceId,
    "oai-language": "th-TH",
    cookie: cookieStr,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  };

  const response = await fetch("https://chatgpt.com/backend-api/f/conversation", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`ChatGPT error ${response.status}: ${await response.text()}`);
  }

  // Parse SSE stream to find image URL
  const text = await response.text();
  const lines = text.split("\n");

  for (const line of lines) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const data = JSON.parse(line.slice(6));
      const parts = data?.v?.message?.content?.parts;
      if (parts) {
        for (const part of parts) {
          if (part.content_type === "image_asset_pointer" && part.asset_pointer) {
            // Found image — download it
            const fileMatch = part.asset_pointer.match(/file-service:\/\/(.+)/);
            if (fileMatch) {
              const fileId = fileMatch[1];
              const convId = data.conversation_id || "";
              const downloadUrl = `https://chatgpt.com/backend-api/files/download/${fileId}?conversation_id=${convId}&inline=false`;

              const imgResp = await fetch(downloadUrl, {
                headers: { authorization: `Bearer ${config.accessToken}` },
              });

              if (imgResp.ok) {
                const arrBuf = await imgResp.arrayBuffer();
                if (arrBuf.byteLength > 1000) {
                  return Buffer.from(arrBuf);
                }
              }
            }
          }
        }
      }
    } catch {
      continue;
    }
  }

  throw new Error("No image found in ChatGPT response");
}
