import { createHash, randomBytes } from "node:crypto";
import {
  PROVIDER,
  SDK,
  bootstrapProtocols,
  bootstrapProvider,
  buildModels,
  configModels,
  parseProtocolDocs,
} from "./models.mjs";
import { collapseResponse } from "./stream.mjs";
import { guardToolResponse } from "./tool-response.mjs";

const DEFAULT_BASE = "https://opencode.ai/inference";
const LEGACY_V1_BASE = "https://opencode.ai/inference/v1";
const LEGACY_ZEN_BASE = "https://opencode.ai/zen/v1";
const CATALOG = "https://models.opencode.ai/api.json";
const DOCS =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/models.mdx";

const PATHS = {
  chat: "/openai/v1/chat/completions",
  responses: "/openai/v1/responses",
  anthropic: "/anthropic/v1/messages",
};

const CORE_TOOLS = ["bash", "edit", "glob", "grep", "read"];
const CORE_PARAMETER = {
  bash: "command",
  edit: "filePath",
  glob: "pattern",
  grep: "pattern",
  read: "filePath",
};

// Aligned with latest OpenCode v2 release (2.2.0)
const OPENCODE_VERSION = "2.2.0";
export function userAgent() {
  return `opencode/latest/${OPENCODE_VERSION}/cli`;
}

const RELIST_AFTER = 60_000;

function httpURL(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Expected an HTTP(S) URL without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

function requirePublic(auth) {
  if (auth?.type !== "api" || auth.key !== "public") {
    throw new Error(
      "OpenCode Zen Free uses the public credential. Enable its free access login method.",
    );
  }
}

async function readRemote(url, json, headers, callerSignal) {
  const timeout = AbortSignal.timeout(15000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Model discovery returned HTTP ${response.status}`);
  }
  return json ? response.json() : response.text();
}

function normalizeTools(body, protocol) {
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new Error("tools must be an array");
  }
  body.tools ??= [];
  const present = new Set(
    body.tools.map((tool) => (protocol === "chat" ? tool?.function?.name : tool?.name)),
  );
  const declared = new Set([...present].filter((name) => typeof name === "string"));
  if (protocol === "chat" && Array.isArray(body.functions)) {
    for (const tool of body.functions) if (typeof tool?.name === "string") declared.add(tool.name);
  }
  for (const name of CORE_TOOLS) {
    if (present.has(name)) continue;
    const parameters = {
      type: "object",
      properties: { [CORE_PARAMETER[name]]: { type: "string" } },
      additionalProperties: false,
    };
    const definition = { name, description: "Not available. Never call this tool." };
    body.tools.push(
      protocol === "chat"
        ? { type: "function", function: { ...definition, parameters } }
        : protocol === "anthropic"
          ? { ...definition, input_schema: parameters }
          : { type: "function", ...definition, parameters },
    );
  }
  return { declared };
}

const ENVIRONMENT = "<env>\n  Working directory: unknown\n</env>";
const HAS_ENVIRONMENT = /<env>[\s\S]*Working directory:[\s\S]*<\/env>/;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

function withEnvironment(content) {
  if (typeof content === "string") return content ? `${content}\n\n${ENVIRONMENT}` : ENVIRONMENT;
  if (Array.isArray(content)) return [...content, { type: "text", text: ENVIRONMENT }];
  return ENVIRONMENT;
}

const SYSTEM_ROLES = ["system", "developer"];

export function addEnvironment(body, protocol) {
  if (protocol === "anthropic") {
    if (!HAS_ENVIRONMENT.test(textOf(body.system))) body.system = withEnvironment(body.system);
    return;
  }
  const messages = protocol === "chat" ? body.messages : body.input;
  const system = Array.isArray(messages)
    ? messages.filter((message) => SYSTEM_ROLES.includes(message?.role))
    : [];
  if (system.some((message) => HAS_ENVIRONMENT.test(textOf(message.content)))) return;
  if (protocol === "responses") {
    if (!HAS_ENVIRONMENT.test(textOf(body.instructions)))
      body.instructions = withEnvironment(body.instructions);
    return;
  }
  const first = system.find((message) => message.role === "system");
  if (first) first.content = withEnvironment(first.content);
  else if (Array.isArray(messages)) messages.unshift({ role: "system", content: ENVIRONMENT });
  else body.messages = [{ role: "system", content: ENVIRONMENT }];
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastStamp = 0;
let counter = 0;

export function opencodeID(prefix, descending, now = Date.now()) {
  if (now !== lastStamp) {
    lastStamp = now;
    counter = 0;
  }
  counter++;
  const current = BigInt(now) * 0x1000n + BigInt(counter);
  const value = (descending ? ~current : current) & 0xffffffffffffn;
  const random = randomBytes(14);
  let tail = "";
  for (const byte of random) tail += ALPHABET[byte % 62];
  return `${prefix}_${value.toString(16).padStart(12, "0")}${tail}`;
}

export function realSessionID(value) {
  const match = /^ses_[0-9a-f]{9}([0-9a-f]{3})[0-9A-Za-z]{14}$/.exec(value ?? "");
  return !!match && 0xfff - Number.parseInt(match[1], 16) < 16;
}

const SESSIONS = new Map();
const KEEP_SESSIONS = 1000;

export function sessionID(headers, body) {
  let signal;
  for (const name of [
    "x-opencode-session",
    "x-opencode-session-id",
    "x-session-affinity",
    "x-session-id",
    "conversation-id",
  ]) {
    if (headers.get(name)) {
      signal = headers.get(name);
      break;
    }
  }
  if (!signal && typeof body.metadata?.session_id === "string") signal = body.metadata.session_id;
  if (realSessionID(signal)) return signal;
  if (!signal) {
    const messages = body.messages ?? body.input;
    const first = Array.isArray(messages)
      ? messages.find((message) => message.role === "user")?.content
      : messages;
    if (!first) return opencodeID("ses", true);
    signal = JSON.stringify(first);
  }
  const key = createHash("sha256").update(`ses\0${signal}`).digest("hex");
  let session = SESSIONS.get(key);
  if (session) {
    SESSIONS.delete(key);
  } else {
    session = opencodeID("ses", true);
    if (SESSIONS.size >= KEEP_SESSIONS) SESSIONS.delete(SESSIONS.keys().next().value);
  }
  SESSIONS.set(key, session);
  return session;
}

export function sanitizeErrorResponse(response) {
  const headers = new Headers(response.headers);
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    // Clamping excessive Retry-After (e.g. 36000s to UTC 00:00) down to 10s prevents
    // magpie gateway's in-memory restingUntil circuit breaker from locking out the
    // provider for 12+ hours when the user switches egress IPs or proxies.
    if (!Number.isNaN(seconds) && seconds > 10) {
      headers.set("retry-after", "10");
    } else if (Number.isNaN(seconds)) {
      headers.set("retry-after", "10");
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function resolveProtocol(url, baseURL) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  let base;
  try {
    base = new URL(baseURL);
  } catch {
    base = new URL(DEFAULT_BASE);
  }

  const isAllowedHost =
    u.host === base.host ||
    (base.host === "opencode.ai" && ["opencode.ai", "models.opencode.ai"].includes(u.host));
  if (!isAllowedHost) return undefined;

  const path = u.pathname;
  if (path.endsWith("/chat/completions")) return "chat";
  if (path.endsWith("/responses")) return "responses";
  if (path.endsWith("/messages")) return "anthropic";
  return undefined;
}

function targetEndpoint(baseURL, protocol) {
  const isCustomBase =
    baseURL !== DEFAULT_BASE &&
    baseURL !== LEGACY_V1_BASE &&
    !baseURL.startsWith("https://opencode.ai");

  if (isCustomBase) {
    const customMap = {
      chat: "/chat/completions",
      responses: "/responses",
      anthropic: "/messages",
    };
    return `${baseURL}${customMap[protocol]}`;
  }

  // Modern upstream paths aligned with OpenCode console catalog
  const modernMap = {
    chat: "https://opencode.ai/inference/openai/v1/chat/completions",
    responses: "https://opencode.ai/inference/openai/v1/responses",
    anthropic: "https://opencode.ai/inference/anthropic/v1/messages",
  };
  return modernMap[protocol];
}

async function server(_input, options = {}) {
  const baseURL = httpURL(options.baseURL ?? DEFAULT_BASE);
  const catalogURL = httpURL(options.catalogURL ?? CATALOG);
  const docsURL = httpURL(options.docsURL ?? DOCS);
  let known = buildModels(
    Object.keys(bootstrapProvider.models),
    bootstrapProvider,
    bootstrapProtocols,
    baseURL,
  );
  let metadata = bootstrapProvider;
  let protocols = { ...bootstrapProtocols };
  let listed = false;
  let listedAt = 0;

  async function discover(signal) {
    const headers = { authorization: "Bearer public", "x-opencode-client": "cli" };
    const modelsURL =
      baseURL === DEFAULT_BASE || baseURL === LEGACY_V1_BASE
        ? "https://opencode.ai/inference/v1/models"
        : `${baseURL}/models`;
    const [listing, catalog, docs] = await Promise.allSettled([
      readRemote(modelsURL, true, headers, signal),
      readRemote(catalogURL, true, undefined, signal),
      readRemote(docsURL, false, undefined, signal),
    ]);
    signal?.throwIfAborted();
    let partial = false;
    if (catalog.status === "fulfilled" && catalog.value?.opencode?.models) {
      metadata = catalog.value.opencode;
    } else {
      partial = true;
    }
    if (docs.status === "fulfilled" && Object.keys(parseProtocolDocs(docs.value)).length) {
      protocols = { ...bootstrapProtocols, ...parseProtocolDocs(docs.value) };
    } else {
      partial = true;
    }
    if (listing.status !== "fulfilled" || !Array.isArray(listing.value?.data)) {
      const fallback = { ...known };
      fallback[Symbol.for("magpie.fellBack")] = true;
      return fallback;
    }
    const ids = listing.value.data.map((item) => item.id);
    const discovered = buildModels(ids, metadata, protocols, baseURL);
    if (partial) {
      for (const id of ids) {
        if (!discovered[id] && !metadata.models?.[id] && !protocols[id] && known[id]) {
          discovered[id] = known[id];
        }
      }
    }
    known = discovered;
    listed = true;
    listedAt = Date.now();
    return discovered;
  }

  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "OpenCode Zen Free",
        npm: SDK.chat,
        api: baseURL === DEFAULT_BASE ? "https://opencode.ai/inference/openai/v1" : baseURL,
        models: configModels(known),
      };
    },
    auth: {
      provider: PROVIDER,
      single: true,
      icon: "https://opencode.ai/favicon-v3.ico",
      maxConcurrency: 2,
      methods: [
        {
          type: "api",
          keyless: true,
          label: "Zen 免费访问（密钥填 public；自己的 OpenCode Key 请加到内置的 OpenCode Zen）",
          placeholder: "public",
          async authorize() {
            return { type: "success", key: "public" };
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        requirePublic(auth);
        return {
          baseURL,
          apiKey: "public",
          async fetch(input, init) {
            requirePublic(await getAuth());
            const request = new Request(input, init);
            const protocol = resolveProtocol(request.url, baseURL);
            if (!protocol || request.method !== "POST")
              throw new Error("Unsupported Zen endpoint or method");
            request.signal.throwIfAborted();
            const body = await request.json();
            if (!body || typeof body !== "object" || Array.isArray(body))
              throw new Error("Expected a JSON request object");
            if (
              !Object.hasOwn(known, body.model) &&
              (!listed || Date.now() - listedAt >= RELIST_AFTER)
            ) {
              await discover(request.signal);
            }
            const model = Object.hasOwn(known, body.model) ? known[body.model] : undefined;
            if (!model) {
              const free = Object.keys(known).sort().join(", ");
              const name = typeof body.model === "string" ? body.model : "";
              return new Response(
                JSON.stringify({
                  type: "error",
                  error: {
                    type: "not_found_error",
                    message: `Model ${name} is not available as an OpenCode Zen free model now. Free models: ${free || "none"}.`,
                  },
                }),
                { status: 404, headers: { "content-type": "application/json" } },
              );
            }
            if (model.api.npm !== SDK[protocol]) {
              throw new Error(
                "Model is not an available free model for this protocol. Refresh the model list.",
              );
            }
            const streaming = body.stream === true;
            body.stream = true;
            const toolPolicy = normalizeTools(body, protocol);
            addEnvironment(body, protocol);
            if (protocol === "chat")
              body.stream_options = { ...body.stream_options, include_usage: true };
            const given = request.headers;
            const session = sessionID(given, body);
            const project = _input?.project;
            const headers = new Headers({
              "content-type": "application/json",
              accept: "*/*",
              "user-agent": userAgent(),
              "x-opencode-project":
                given.get("x-opencode-project") ||
                (project?.vcs === "git" && project.id ? project.id : "global"),
              "x-opencode-session": session,
              "x-opencode-client": "cli",
              "x-opencode-session-id": session,
              "x-session-affinity": session,
              "x-session-id": session,
            });
            const parentSession =
              given.get("x-opencode-parent-session-id") || given.get("x-parent-session-id");
            if (parentSession) {
              headers.set("x-opencode-parent-session-id", parentSession);
              headers.set("x-parent-session-id", parentSession);
            }
            if (protocol === "anthropic") {
              headers.set("x-api-key", "public");
              headers.set("anthropic-version", given.get("anthropic-version") || "2023-06-01");
              if (given.get("anthropic-beta")) headers.set("anthropic-beta", given.get("anthropic-beta"));
            } else {
              headers.set("authorization", "Bearer public");
            }
            const upstreamURL = targetEndpoint(baseURL, protocol);
            const response = await fetch(upstreamURL, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: request.signal,
              redirect: "error",
            });
            if (!response.ok) {
              return sanitizeErrorResponse(response);
            }
            const guarded = await guardToolResponse(response, protocol, toolPolicy, {
              endCutShort: streaming,
            });
            return streaming ? guarded : collapseResponse(guarded, protocol);
          },
        };
      },
      async usage() {
        return { plan: "OpenCode Zen Free", windows: [] };
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        requirePublic(auth);
        return discover();
      },
    },
    async "chat.headers"(input, output) {
      if (![PROVIDER, `${PROVIDER}-plugin`].includes(input.model?.providerID) || !input.sessionID)
        return;
      output.headers["x-session-id"] = input.sessionID;
      output.headers["x-opencode-session"] = input.sessionID;
      output.headers["x-session-affinity"] = input.sessionID;
      output.headers["X-Session-Id"] = input.sessionID;
    },
  };
}

export default { id: PROVIDER, server };
