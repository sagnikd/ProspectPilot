import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import cors from "cors";
import express from "express";
import serverless from "serverless-http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

const PORT = Number(process.env.PORT ?? 5173);
const LEAD_LIMIT = Number(process.env.LEAD_LIMIT ?? 8);
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
const GEOAPIFY_KEY = process.env.GEOAPIFY_API_KEY;

const CONTACT_PATHS = [
  "/contact",
  "/contact-us",
  "/locations",
  "/location",
  "/team",
  "/about",
  "/about-us"
];

const STAGES = [
  "Scraping",
  "Extracting Contact Info",
  "Capturing Screenshots",
  "Auditing",
  "Drafting"
];

const geoapifyCategoryMap = {
  dentist: "healthcare.dentist",
  restaurant: "catering.restaurant",
  lawyer: "service.financial,service.financial.lawyer,office",
  chiropractor: "healthcare.clinic_or_praxis",
  hvac: "service.repair,commercial.service",
  plumber: "service.plumber,commercial.service",
  electrician: "service.electronics,commercial.service",
  med_spa: "healthcare.clinic_or_praxis,commercial.health_and_beauty",
  real_estate: "commercial.real_estate,office",
  gym: "sport.fitness,commercial.health_and_beauty",
  salon: "commercial.hairdresser,commercial.beauty",
  veterinarian: "healthcare.veterinary",
  auto_repair: "service.vehicle.repair,commercial.vehicle",
  accountant: "service.financial,office",
  roofing: "service.repair,commercial.service",
  landscaping: "commercial.garden,service"
};

export const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get(["/api/health", "/health", "/.netlify/functions/api/health"], (_req, res) => {
  res.json({
    ok: true,
    service: "ProspectPilot",
    geoapifyConfigured: Boolean(GEOAPIFY_KEY),
    geminiConfigured: Boolean(GEMINI_KEY)
  });
});

app.get(["/api/leads/stream", "/leads/stream", "/.netlify/functions/api/leads/stream"], async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  const send = (event, payload) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const niche = String(req.query.niche ?? "dentist");
    const city = String(req.query.city ?? "").trim();
    const state = String(req.query.state ?? "").trim();

    if (!city || !state) {
      throw new Error("Choose a city before launching the search.");
    }

    send("stage", {
      stage: STAGES[0],
      progress: 4,
      detail: `Searching ${city}, ${state}`
    });

    const scrapedLeads = await scrapeGeoapifyLeads({ niche, city, state, limit: LEAD_LIMIT });

    if (scrapedLeads.length === 0) {
      send("done", {
        progress: 100,
        message: "No businesses with valid websites were found for this search."
      });
      res.end();
      return;
    }

    send("meta", {
      total: scrapedLeads.length,
      message: `${scrapedLeads.length} website-ready leads found`
    });

    await Promise.all(
      scrapedLeads.map(async (lead, index) => {
        if (closed) return;

        const baseProgress = (index / scrapedLeads.length) * 92 + 4;
        const progressStep = 92 / scrapedLeads.length / 4;

        send("stage", {
          stage: STAGES[1],
          progress: Math.round(baseProgress),
          detail: lead.name
        });

        const foundEmail = await extractBestEmail(lead.website);

        send("stage", {
          stage: STAGES[2],
          progress: Math.round(baseProgress + progressStep),
          detail: lead.name
        });

        const screenshotUrl = await captureScreenshot(lead.website);

        send("stage", {
          stage: STAGES[3],
          progress: Math.round(baseProgress + progressStep * 2),
          detail: lead.name
        });

        const audit = await auditLeadWithGemini({ lead, screenshotUrl });

        send("stage", {
          stage: STAGES[4],
          progress: Math.round(baseProgress + progressStep * 3),
          detail: lead.name
        });

        send("lead", {
          ...lead,
          foundEmail,
          screenshotUrl,
          score: audit.score,
          auditDetail: audit.auditDetail,
          findings: audit.findings,
          coldEmail: audit.coldEmail
        });
      })
    );

    send("done", {
      progress: 100,
      message: "Pipeline complete"
    });
  } catch (error) {
    send("error", {
      message: toPublicError(error)
    });
  } finally {
    if (!closed) {
      res.end();
    }
  }
});

async function scrapeGeoapifyLeads({ niche, city, state, limit }) {
  if (!GEOAPIFY_KEY) {
    throw new Error("Missing GEOAPIFY_API_KEY. Add it to .env and restart the dev server.");
  }

  const categories = geoapifyCategoryMap[niche] ?? geoapifyCategoryMap.dentist;
  const geocode = await axios.get("https://api.geoapify.com/v1/geocode/search", {
    params: {
      text: `${city}, ${state}, United States`,
      format: "json",
      limit: 1,
      apiKey: GEOAPIFY_KEY
    },
    timeout: 12000
  });

  const place = geocode.data?.results?.[0];
  if (!place?.place_id || typeof place.lon !== "number" || typeof place.lat !== "number") {
    throw new Error(`Geoapify could not resolve ${city}, ${state}.`);
  }

  const placeFilter = `place:${place.place_id}`;
  let places = await fetchGeoapifyPlaces({ categories, filter: placeFilter, limit });

  if (places.length === 0) {
    const circleFilter = `circle:${place.lon},${place.lat},15000`;
    places = await fetchGeoapifyPlaces({
      categories,
      filter: circleFilter,
      bias: `proximity:${place.lon},${place.lat}`,
      limit
    });
  }

  return places
    .map((feature) => feature.properties ?? {})
    .filter((properties) => typeof properties.website === "string" && properties.website.startsWith("http"))
    .map((properties) => ({
      id: properties.place_id ?? `${properties.name}-${properties.website}`,
      name: properties.name ?? "Unnamed business",
      website: normalizeWebsite(properties.website),
      location: properties.formatted ?? [properties.address_line1, properties.address_line2].filter(Boolean).join(", "),
      city,
      state,
      categories: properties.categories ?? []
    }))
    .filter((lead, index, all) => all.findIndex((candidate) => candidate.website === lead.website) === index)
    .slice(0, limit);
}

async function fetchGeoapifyPlaces({ categories, filter, bias, limit }) {
  const response = await axios.get("https://api.geoapify.com/v2/places", {
    params: {
      categories,
      filter,
      bias,
      limit: Math.max(limit * 3, 20),
      apiKey: GEOAPIFY_KEY
    },
    timeout: 14000
  });

  return response.data?.features ?? [];
}

async function extractBestEmail(website) {
  const candidates = contactCandidateUrls(website);
  const found = new Set();

  const pages = await Promise.allSettled(
    candidates.map((url) =>
      axios.get(url, {
        headers: {
          "User-Agent": "ProspectPilot/1.0 (+https://prospectpilot.local)"
        },
        maxRedirects: 3,
        timeout: 4500,
        validateStatus: (status) => status < 500,
        responseType: "text"
      })
    )
  );

  for (const page of pages) {
    if (page.status !== "fulfilled") continue;
    const response = page.value;
    if (response.status >= 400 || typeof response.data !== "string") continue;

    for (const email of extractEmails(response.data)) {
      found.add(email);
    }
  }

  return sortEmails([...found])[0] ?? "";
}

function contactCandidateUrls(website) {
  const base = new URL(normalizeWebsite(website));
  const urls = CONTACT_PATHS.map((candidatePath) => new URL(candidatePath, base.origin).toString());
  urls.push(base.origin);
  return [...new Set(urls)];
}

function extractEmails(markup) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@\s*[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = markup.match(emailRegex) ?? [];

  return matches
    .map((email) => email.replace(/\s+/g, "").toLowerCase())
    .filter((email) => !isJunkEmail(email));
}

function isJunkEmail(email) {
  const forbidden = [
    "noreply",
    "no-reply",
    "sentry",
    "wix",
    "godaddy",
    "example.com",
    "domain.com",
    "yourname@"
  ];
  const assetFragments = [
    "@2x",
    ".2x",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".avif",
    ".css",
    ".js"
  ];
  const lower = email.toLowerCase();
  const domain = lower.split("@")[1] ?? "";

  return (
    forbidden.some((fragment) => lower.includes(fragment)) ||
    assetFragments.some((fragment) => lower.includes(fragment)) ||
    domain.split(".").some((part) => part.length > 63)
  );
}

function sortEmails(emails) {
  const genericUseful = new Set(["info", "contact", "hello", "support", "office", "admin"]);

  return emails.sort((left, right) => scoreEmail(left, genericUseful) - scoreEmail(right, genericUseful));
}

function scoreEmail(email, genericUseful) {
  const localPart = email.split("@")[0] ?? "";
  const hasPersonalDot = localPart.includes(".") && !genericUseful.has(localPart.split(".")[0]);
  if (hasPersonalDot) return 0;
  if (genericUseful.has(localPart)) return 1;
  return 2;
}

async function captureScreenshot(website) {
  return microlinkEmbedUrl(website);
}

function microlinkEmbedUrl(website) {
  return `https://api.microlink.io/?url=${encodeURIComponent(website)}&screenshot=true&embed=screenshot.url`;
}

async function auditLeadWithGemini({ lead, screenshotUrl }) {
  if (!GEMINI_KEY) {
    return fallbackAudit(lead);
  }

  const parts = [
    {
      text: [
        "You are ProspectPilot, a blunt website conversion auditor and cold outreach copywriter.",
        "Analyze the provided website screenshot and return JSON only.",
        "Use the Observation -> Insight -> Gap framework.",
        "No flattery. Do not say 'I hope you're well'. Do not say 'I noticed your website'.",
        "Subject must be 2-4 lowercase words and specific.",
        "Body must sound like a helpful peer and end with the signature 'Animesh, ProspectPilot'.",
        "",
        `Business: ${lead.name}`,
        `Website: ${lead.website}`,
        "",
        "Return this exact JSON shape:",
        JSON.stringify({
          score: 62,
          findings: ["specific visual issue", "conversion consequence", "fix direction"],
          auditDetail: "2-4 concise sentences explaining the observation, insight, and gap.",
          coldEmail: {
            subject: "your hero section",
            body: "I was looking at your site and the [specific detail] is [problem]. Usually, this makes it harder for customers to [action]. I recorded a 2-min video on how to fix this. Worth a look?\\n\\nAnimesh, ProspectPilot"
          }
        })
      ].join("\n")
    }
  ];

  const imagePart = await imagePartFromUrl(screenshotUrl);
  if (imagePart) {
    parts.push(imagePart);
  }

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        contents: [
          {
            role: "user",
            parts
          }
        ],
        generationConfig: {
          temperature: 0.55,
          maxOutputTokens: 800
        }
      },
      {
        params: {
          key: GEMINI_KEY
        },
        timeout: 25000
      }
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    const parsed = parseJsonFromModel(text);
    return normalizeAudit(parsed, lead);
  } catch (error) {
    return {
      ...fallbackAudit(lead),
      auditDetail: `Gemini audit failed: ${toPublicError(error)}`
    };
  }
}

async function imagePartFromUrl(screenshotUrl) {
  if (!screenshotUrl) return null;

  try {
    const response = await axios.get(screenshotUrl, {
      responseType: "arraybuffer",
      timeout: 16000,
      validateStatus: (status) => status < 500
    });

    if (response.status >= 400) return null;

    const mimeType = response.headers["content-type"]?.split(";")[0] ?? "image/png";

    return {
      inline_data: {
        mime_type: mimeType,
        data: Buffer.from(response.data).toString("base64")
      }
    };
  } catch {
    return null;
  }
}

function parseJsonFromModel(text) {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const jsonText = start >= 0 && end >= start ? trimmed.slice(start, end + 1) : trimmed;

  try {
    return JSON.parse(jsonText);
  } catch {
    const repaired = repairModelJson(jsonText);
    try {
      return JSON.parse(repaired);
    } catch {
      return salvageAuditFields(jsonText);
    }
  }
}

function repairModelJson(raw) {
  let repaired = raw.replace(/[\u0000-\u0019]+/g, " ");
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");
  repaired = repaired.replace(/\r?\n/g, "\\n");
  repaired = repaired.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
  return repaired;
}

function salvageAuditFields(raw) {
  return {
    score: extractNumberField(raw, "score"),
    findings: extractStringArrayField(raw, "findings"),
    auditDetail: extractStringField(raw, "auditDetail"),
    coldEmail: {
      subject: extractStringField(raw, "subject"),
      body: extractStringField(raw, "body")
    }
  };
}

function extractNumberField(raw, key) {
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
  return match ? Number(match[1]) : undefined;
}

function extractStringArrayField(raw, key) {
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*\\[(.*?)\\]`, "s"));
  if (!match) return undefined;

  const values = [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((entry) =>
    decodeModelString(entry[1])
  );

  return values.length > 0 ? values : undefined;
}

function extractStringField(raw, key) {
  const keyIndex = raw.indexOf(`"${key}"`);
  if (keyIndex === -1) return undefined;

  const colonIndex = raw.indexOf(":", keyIndex);
  if (colonIndex === -1) return undefined;

  const openingQuoteIndex = raw.indexOf("\"", colonIndex);
  if (openingQuoteIndex === -1) return undefined;

  let value = "";
  let escaped = false;

  for (let index = openingQuoteIndex + 1; index < raw.length; index += 1) {
    const char = raw[index];

    if (escaped) {
      value += `\\${char}`;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      return decodeModelString(value);
    }

    if (char === "\n" || char === "\r") {
      break;
    }

    value += char;
  }

  return decodeModelString(value);
}

function decodeModelString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\")
      .trim();
  }
}

function normalizeAudit(parsed, lead) {
  const score = clamp(Number(parsed?.score ?? 52), 0, 100);
  const findings = Array.isArray(parsed?.findings)
    ? parsed.findings.map(String).filter(Boolean).slice(0, 4)
    : fallbackAudit(lead).findings;
  const auditDetail =
    typeof parsed?.auditDetail === "string" && parsed.auditDetail.trim()
      ? parsed.auditDetail.trim()
      : fallbackAudit(lead).auditDetail;

  return {
    score,
    findings,
    auditDetail,
    coldEmail: sanitizeColdEmail(parsed?.coldEmail, lead)
  };
}

function sanitizeColdEmail(coldEmail, lead) {
  const fallback = fallbackAudit(lead).coldEmail;
  const rawSubject = typeof coldEmail?.subject === "string" ? coldEmail.subject : fallback.subject;
  const rawBody = typeof coldEmail?.body === "string" ? coldEmail.body : fallback.body;
  const subject = rawSubject
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");

  let body = rawBody
    .replace(/i hope (you'?re|you are) well[.!]?\s*/gi, "")
    .replace(/i noticed your website\s*/gi, "I was looking at your site ")
    .trim();

  if (!body.includes("Animesh, ProspectPilot")) {
    body = `${body}\n\nAnimesh, ProspectPilot`;
  }

  return {
    subject: subject || fallback.subject,
    body
  };
}

function fallbackAudit(lead) {
  return {
    score: 52,
    findings: [
      "Above-the-fold message needs a sharper conversion target.",
      "Primary call-to-action is easy to miss during a quick scan.",
      "The offer can be made more concrete for local search visitors."
    ],
    auditDetail:
      "The first screen does not create a clean path from visitor intent to action. That usually means qualified local traffic has to work harder before calling, booking, or requesting a quote.",
    coldEmail: {
      subject: "your homepage flow",
      body: `I was looking at your site and the first screen is doing too many jobs at once. Usually, this makes it harder for customers to know whether to call, book, or request a quote. I recorded a 2-min video on how to fix this. Worth a look?\n\nAnimesh, ProspectPilot`
    }
  };
}

function normalizeWebsite(website) {
  const trimmed = String(website ?? "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toPublicError(error) {
  const apiMessage = error?.response?.data?.error?.message ?? error?.response?.data?.message;
  return apiMessage ?? error?.message ?? "Something went wrong.";
}

async function attachFrontend() {
  if (process.env.NODE_ENV === "production") {
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get("*", (_req, res) => {
        res.sendFile(path.join(distDir, "index.html"));
      });
    }
    return;
  }

  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: rootDir,
    server: {
      middlewareMode: true
    },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

const isServerless =
  Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
  Boolean(process.env.VERCEL) ||
  Boolean(process.env.NETLIFY) ||
  Boolean(process.env.SERVERLESS);

if (!isServerless) {
  await attachFrontend();
  app.listen(PORT, () => {
    console.log(`ProspectPilot running at http://localhost:${PORT}`);
  });
}

export const handler = serverless(app);
export default handler;
