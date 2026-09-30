const http = require("http");
const { spawn, execFile } = require("child_process");
const { URL } = require("url");
const crypto = require("crypto");

// ============================================================
// CLAUDE ↔ ROBINHOOD BRIDGE V2
// ============================================================

const PORT = Number(process.env.PORT || 3000);

const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();
const SCANNER_BRIDGE_TOKEN = (
  process.env.SCANNER_BRIDGE_TOKEN || ""
).trim();

if (!ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD is required.");
  process.exit(1);
}

if (!SCANNER_BRIDGE_TOKEN) {
  console.error("SCANNER_BRIDGE_TOKEN is required.");
  process.exit(1);
}

// ------------------------------------------------------------
// SAFETY
// ------------------------------------------------------------

const ROBINHOOD_EXECUTION_ENABLED = false;
const DECISION_MODE_ENABLED = true;

const MAX_SIGNAL_AGE_MS = 3 * 60 * 1000;
const DECISION_COOLDOWN_MS = 5 * 60 * 1000;

const MAX_BODY_BYTES = 1024 * 1024;

// ------------------------------------------------------------
// ADMIN AUTH
// ------------------------------------------------------------

const ADMIN_SESSION_TOKEN = crypto
  .createHmac("sha256", ADMIN_PASSWORD)
  .update("claude-robinhood-admin-session-v2")
  .digest("hex");

function timingSafeEqualString(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));

  if (aa.length !== bb.length) {
    return false;
  }

  return crypto.timingSafeEqual(aa, bb);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const result = {};

  for (const item of header.split(";")) {
    const index = item.indexOf("=");

    if (index === -1) continue;

    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();

    result[key] = decodeURIComponent(value);
  }

  return result;
}

function isAdmin(req) {
  const cookies = parseCookies(req);

  return timingSafeEqualString(
    cookies.admin_session,
    ADMIN_SESSION_TOKEN
  );
}

function bridgeAuthorized(req) {
  const auth = req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return false;
  }

  const supplied = auth.slice(7);

  return timingSafeEqualString(
    supplied,
    SCANNER_BRIDGE_TOKEN
  );
}

// ============================================================
// STATE
// ============================================================

const state = {
  startedAt: new Date().toISOString(),

  bridge: {
    executionEnabled: ROBINHOOD_EXECUTION_ENABLED,
    received: 0,
    rejected: 0,
    lastReceivedAt: null,
    latestSignal: null,
    latestRejection: null,
  },

  decisions: {
    enabled: DECISION_MODE_ENABLED,
    executionEnabled: ROBINHOOD_EXECUTION_ENABLED,
    requested: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    running: false,
    latest: null,
    bySymbol: {},
  },

  robinhood: {
    loginOutput: "",
    loginRunning: false,
    loginInput: null,

    statusOutput: "",
    testOutput: "",
    testRunning: false,
  },
};

// ============================================================
// SECURITY HEADERS
// ============================================================

function securityHeaders(res) {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
  );

  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains"
  );

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate"
  );
}

function send(res, status, body, contentType = "text/plain") {
  securityHeaders(res);

  res.writeHead(status, {
    "Content-Type": `${contentType}; charset=utf-8`,
  });

  res.end(body);
}

function sendJson(res, status, payload) {
  send(
    res,
    status,
    JSON.stringify(payload, null, 2),
    "application/json"
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ============================================================
// BODY PARSING
// ============================================================

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", chunk => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }

      body += chunk.toString("utf8");
    });

    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  const result = {};

  for (const [key, value] of params.entries()) {
    result[key] = value;
  }

  return result;
}

// ============================================================
// CLAUDE EXECUTION
// ============================================================

function runClaude(args, prompt, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${error.message}\n${stderr || ""}`.trim()
            )
          );
          return;
        }

        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );

    if (child.stdin) {
      child.stdin.write(prompt || "");
      child.stdin.end();
    }
  });
}

// ============================================================
// SIGNAL VALIDATION
// ============================================================

function finiteNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function cleanStringArray(value, maxItems = 50) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(x => typeof x === "string")
    .slice(0, maxItems)
    .map(x => x.slice(0, 500));
}

function deepCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateV2Signal(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    throw new Error("Signal must be a JSON object");
  }

  const symbol = String(raw.symbol || "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9.\-]{1,15}$/.test(symbol)) {
    throw new Error("Invalid symbol");
  }

  if (!finiteNumber(raw.price) || raw.price <= 0) {
    throw new Error("Invalid price");
  }

  if (!finiteNumber(raw.score)) {
    throw new Error("Invalid score");
  }

  if (raw.score < -100 || raw.score > 100) {
    throw new Error("Score outside allowed range");
  }

  const allowedSessions = new Set([
    "premarket",
    "regular",
    "afterhours",
    "overnight",
    "closed",
  ]);

  const allowedLifecycle = new Set([
    "WATCH",
    "DEVELOPING",
    "QUALIFIED",
    "BUY_CANDIDATE",
    "PASS",
    "EXPIRED",
  ]);

  const marketSession = String(
    raw.market_session || ""
  );

  if (
    marketSession &&
    !allowedSessions.has(marketSession)
  ) {
    throw new Error("Invalid market_session");
  }

  const lifecycle = String(
    raw.lifecycle || ""
  );

  if (
    lifecycle &&
    !allowedLifecycle.has(lifecycle)
  ) {
    throw new Error("Invalid lifecycle");
  }

  const generatedAt = raw.scanner_generated_at
    ? new Date(raw.scanner_generated_at)
    : null;

  if (
    generatedAt &&
    Number.isNaN(generatedAt.getTime())
  ) {
    throw new Error("Invalid scanner_generated_at");
  }

  if (generatedAt) {
    const ageMs = Date.now() - generatedAt.getTime();

    if (ageMs > MAX_SIGNAL_AGE_MS) {
      throw new Error(
        `Stale signal: ${Math.round(ageMs / 1000)} seconds old`
      );
    }

    if (ageMs < -60 * 1000) {
      throw new Error("Signal timestamp is in the future");
    }
  }

  // Preserve the complete V2 structure.
  const signal = deepCloneJson(raw);

  // Normalize important top-level fields.
  signal.symbol = symbol;
  signal.price = raw.price;
  signal.score = raw.score;

  signal.lifecycle = lifecycle || null;
  signal.setup = raw.setup
    ? String(raw.setup).slice(0, 100)
    : null;

  signal.market_session = marketSession || null;

  signal.market_time_et = raw.market_time_et
    ? String(raw.market_time_et).slice(0, 100)
    : null;

  signal.reasons = cleanStringArray(raw.reasons);
  signal.risk_factors = cleanStringArray(
    raw.risk_factors
  );
  signal.warnings = cleanStringArray(raw.warnings);

  signal.scanner_generated_at =
    raw.scanner_generated_at || null;

  signal.bridge_received_at =
    new Date().toISOString();

  // The bridge is authoritative about execution state.
  signal.execution_enabled = false;

  return signal;
}

// ============================================================
// ADDITIONAL BRIDGE SAFETY GATES
// ============================================================

function signalSafetyAssessment(signal) {
  const blocks = [];
  const cautions = [];

  if (
    signal.market_session &&
    signal.market_session !== "regular"
  ) {
    cautions.push(
      `Signal arrived during ${signal.market_session}`
    );
  }

  if (
    finiteNumber(signal.spread_pct) &&
    signal.spread_pct > 1
  ) {
    blocks.push("Spread exceeds 1%");
  }

  if (
    finiteNumber(signal.vwap_distance_pct) &&
    Math.abs(signal.vwap_distance_pct) >= 8
  ) {
    cautions.push(
      "Price is extremely extended from VWAP"
    );
  }

  if (
    finiteNumber(signal.change_pct) &&
    Math.abs(signal.change_pct) >= 30
  ) {
    cautions.push(
      "Extreme move versus previous close"
    );
  }

  if (
    signal.lifecycle === "BUY_CANDIDATE" &&
    signal.market_session !== "regular"
  ) {
    blocks.push(
      "BUY_CANDIDATE is not accepted outside regular session"
    );
  }

  if (
    signal.quote &&
    finiteNumber(signal.quote.bid) &&
    finiteNumber(signal.quote.ask) &&
    signal.quote.ask < signal.quote.bid
  ) {
    blocks.push("Crossed/invalid quote");
  }

  return {
    blocked: blocks.length > 0,
    blocks,
    cautions,
  };
}

// ============================================================
// DRY-RUN DECISION ENGINE
// ============================================================

function decisionCooldownAllows(signal) {
  const previous =
    state.decisions.bySymbol[signal.symbol];

  if (!previous) {
    return true;
  }

  const elapsed =
    Date.now() - previous.requestedAt;

  if (elapsed >= DECISION_COOLDOWN_MS) {
    return true;
  }

  if (
    finiteNumber(signal.score) &&
    finiteNumber(previous.score) &&
    signal.score >= previous.score + 2
  ) {
    return true;
  }

  return false;
}

function extractJsonObject(text) {
  const trimmed = String(text || "").trim();

  try {
    return JSON.parse(trimmed);
  } catch (_) {}

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");

  if (first === -1 || last === -1 || last <= first) {
    throw new Error(
      "Claude did not return a JSON object"
    );
  }

  return JSON.parse(
    trimmed.slice(first, last + 1)
  );
}

function normalizeDecision(result, signal) {
  const allowed = new Set([
    "WATCH",
    "PASS",
    "BUY_CANDIDATE",
  ]);

  let decision = String(
    result.decision || "PASS"
  ).toUpperCase();

  if (!allowed.has(decision)) {
    decision = "PASS";
  }

  // Automated bridge cannot promote an off-hours
  // signal into BUY_CANDIDATE.
  if (
    decision === "BUY_CANDIDATE" &&
    signal.market_session !== "regular"
  ) {
    decision = "WATCH";
  }

  let confidence = Number(result.confidence);

  if (!Number.isFinite(confidence)) {
    confidence = 0;
  }

  confidence = Math.max(
    0,
    Math.min(100, confidence)
  );

  return {
    decision,
    confidence,
    symbol: signal.symbol,

    setup:
      typeof result.setup === "string"
        ? result.setup.slice(0, 150)
        : signal.setup,

    summary:
      typeof result.summary === "string"
        ? result.summary.slice(0, 2000)
        : "",

    positive_factors: cleanStringArray(
      result.positive_factors
    ),

    risk_factors: cleanStringArray(
      result.risk_factors
    ),

    missing_information: cleanStringArray(
      result.missing_information
    ),

    invalidation_conditions: cleanStringArray(
      result.invalidation_conditions
    ),

    scanner_score: signal.score,
    scanner_lifecycle: signal.lifecycle,
    market_session: signal.market_session,

    created_at: new Date().toISOString(),

    execution_enabled: false,
  };
}

async function runDryDecision(signal) {
  if (!DECISION_MODE_ENABLED) {
    return;
  }

  if (state.decisions.running) {
    state.decisions.skipped += 1;
    return;
  }

  if (!decisionCooldownAllows(signal)) {
    state.decisions.skipped += 1;
    return;
  }

  const safety =
    signalSafetyAssessment(signal);

  if (safety.blocked) {
    const decision = {
      decision: "PASS",
      confidence: 100,
      symbol: signal.symbol,
      setup: signal.setup,
      summary:
        "Signal blocked by deterministic bridge safety gate.",
      positive_factors: [],
      risk_factors: safety.blocks,
      missing_information: [],
      invalidation_conditions: [],
      scanner_score: signal.score,
      scanner_lifecycle: signal.lifecycle,
      market_session: signal.market_session,
      created_at: new Date().toISOString(),
      execution_enabled: false,
    };

    state.decisions.latest = decision;

    state.decisions.bySymbol[signal.symbol] = {
      requestedAt: Date.now(),
      score: signal.score,
      decision,
    };

    state.decisions.completed += 1;
    return;
  }

  state.decisions.running = true;
  state.decisions.requested += 1;

  state.decisions.bySymbol[signal.symbol] = {
    requestedAt: Date.now(),
    score: signal.score,
    decision: null,
  };

  const prompt = `
You are evaluating an intraday market scanner signal.

THIS IS A DRY-RUN ANALYSIS ONLY.

STRICT RULES:
- Do not use Robinhood.
- Do not use any MCP tool.
- Do not place, preview, prepare, modify, or cancel an order.
- Do not claim that a trade has been executed.
- Use only the structured scanner evidence supplied below.
- Treat scanner score as one input, not as proof that the setup is good.
- Give negative evidence equal weight.
- Premarket and after-hours conditions require extra caution.
- Extreme percentage moves can indicate elevated volatility and chasing risk.
- A BUY_CANDIDATE result means only that the setup merits further review.
- It does NOT authorize an order.

Return ONLY valid JSON using this schema:

{
  "decision": "WATCH" | "PASS" | "BUY_CANDIDATE",
  "confidence": 0-100,
  "setup": "short setup description",
  "summary": "concise assessment",
  "positive_factors": ["..."],
  "risk_factors": ["..."],
  "missing_information": ["..."],
  "invalidation_conditions": ["..."]
}

DETERMINISTIC BRIDGE CAUTIONS:
${JSON.stringify(safety.cautions, null, 2)}

COMPLETE V2 SCANNER SIGNAL:
${JSON.stringify(signal, null, 2)}
`;

  try {
    const result = await runClaude(
      [
        "-p",
        "--disallowedTools",
        "mcp__robinhood-trading__*",
      ],
      prompt
    );

    const parsed =
      extractJsonObject(result.stdout);

    const decision =
      normalizeDecision(parsed, signal);

    state.decisions.latest = decision;

    state.decisions.bySymbol[signal.symbol] = {
      requestedAt: Date.now(),
      score: signal.score,
      decision,
    };

    state.decisions.completed += 1;
  } catch (error) {
    state.decisions.failed += 1;

    state.decisions.latest = {
      decision: "PASS",
      confidence: 0,
      symbol: signal.symbol,
      summary:
        "Decision engine error; no action permitted.",
      error: String(error.message || error),
      created_at: new Date().toISOString(),
      execution_enabled: false,
    };
  } finally {
    state.decisions.running = false;
  }
}

// ============================================================
// BRIDGE SIGNAL ACCEPTANCE
// ============================================================

function acceptBridgeSignal(raw) {
  const signal = validateV2Signal(raw);

  const safety =
    signalSafetyAssessment(signal);

  signal.bridge_safety = safety;

  state.bridge.received += 1;
  state.bridge.lastReceivedAt =
    new Date().toISOString();

  state.bridge.latestSignal = signal;

  // Analysis is asynchronous.
  setImmediate(() => {
    runDryDecision(signal).catch(error => {
      console.error(
        "Decision engine error:",
        error.message
      );
    });
  });

  return signal;
}

// ============================================================
// ROBINHOOD MCP LOGIN
// ============================================================

function sanitizeLoginOutput(text) {
  let value = String(text || "");

  // Redact common OAuth secret-bearing query values.
  value = value.replace(
    /([?&](?:code|state|code_verifier|code_challenge)=)[^&\s]+/gi,
    "$1[REDACTED]"
  );

  return value.slice(-20000);
}

function startRobinhoodLogin() {
  if (state.robinhood.loginRunning) {
    return;
  }

  state.robinhood.loginRunning = true;
  state.robinhood.loginOutput = "";

  const child = spawn(
    "script",
    [
      "-qfec",
      "claude mcp login robinhood-trading --no-browser",
      "/dev/null",
    ],
    {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  state.robinhood.loginInput = child.stdin;

  const consume = data => {
    const safe =
      sanitizeLoginOutput(data.toString());

    state.robinhood.loginOutput =
      sanitizeLoginOutput(
        state.robinhood.loginOutput + safe
      );
  };

  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  child.on("close", code => {
    state.robinhood.loginRunning = false;
    state.robinhood.loginInput = null;

    state.robinhood.loginOutput =
      sanitizeLoginOutput(
        state.robinhood.loginOutput +
          `\nProcess exited with code ${code}\n`
      );
  });
}

// ============================================================
// ROBINHOOD STATUS / READ-ONLY TEST
// ============================================================

function runRobinhoodStatus() {
  execFile(
    "claude",
    ["mcp", "get", "robinhood-trading"],
    {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: process.env,
    },
    (error, stdout, stderr) => {
      state.robinhood.statusOutput =
        sanitizeLoginOutput(
          `${stdout || ""}\n${stderr || ""}\n${
            error ? error.message : ""
          }`
        );
    }
  );
}

async function runReadOnlyTest() {
  if (state.robinhood.testRunning) {
    return;
  }

  state.robinhood.testRunning = true;
  state.robinhood.testOutput = "Running...";

  const prompt = `
READ-ONLY ROBINHOOD CONNECTION TEST.

You may inspect account information using the Robinhood MCP.

STRICTLY PROHIBITED:
- placing orders
- previewing orders
- preparing orders
- modifying orders
- cancelling orders
- transfers
- any write action

Return a concise summary confirming whether account data can be read.
`;

  try {
    const result = await runClaude(
      [
        "-p",
        "--allowedTools",
        "mcp__robinhood-trading__*",
      ],
      prompt
    );

    state.robinhood.testOutput =
      result.stdout || "No output";
  } catch (error) {
    state.robinhood.testOutput =
      String(error.message || error);
  } finally {
    state.robinhood.testRunning = false;
  }
}

// ============================================================
// HTML
// ============================================================

function page(title, body) {
  return `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>
<title>${escapeHtml(title)}</title>
<style>
body {
  background: #0b0b0b;
  color: #f4f4f4;
  font-family: -apple-system, BlinkMacSystemFont,
    "Segoe UI", sans-serif;
  margin: 0;
  padding: 24px;
}
main {
  max-width: 900px;
  margin: auto;
}
.card {
  background: #181818;
  border-radius: 18px;
  padding: 22px;
  margin: 18px 0;
}
pre {
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}
a, button {
  color: #4da3ff;
}
button {
  font-size: 18px;
  padding: 12px 18px;
}
input {
  font-size: 18px;
  padding: 12px;
  width: 90%;
}
.good { color: #73e28b; }
.warn { color: #ffd166; }
.bad { color: #ff7373; }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function loginPage(message = "") {
  return page(
    "Login",
    `
<h1>Claude ↔ Robinhood</h1>
<div class="card">
  <h2>Admin Login</h2>
  ${
    message
      ? `<p class="bad">${escapeHtml(message)}</p>`
      : ""
  }
  <form method="POST" action="/login">
    <input
      type="password"
      name="password"
      placeholder="Admin password"
      autocomplete="current-password"
      required
    >
    <br><br>
    <button type="submit">Login</button>
  </form>
</div>
`
  );
}

function homePage() {
  return page(
    "Claude ↔ Robinhood",
    `
<h1>Claude ↔ Robinhood</h1>

<div class="card">
  <h2>Safety</h2>
  <p>
    Robinhood execution:
    <strong class="good">DISABLED</strong>
  </p>
  <p>
    Decision engine:
    <strong>${
      DECISION_MODE_ENABLED
        ? "ENABLED"
        : "DISABLED"
    }</strong>
  </p>
</div>

<div class="card">
  <h2>Scanner Bridge V2</h2>
  <p>
    Signals received:
    <strong>${state.bridge.received}</strong>
  </p>
  <p>
    Rejected:
    <strong>${state.bridge.rejected}</strong>
  </p>
  <p>
    <a href="/bridge">Open Bridge</a>
  </p>
  <p>
    <a href="/decisions">Decision Engine</a>
  </p>
</div>

<div class="card">
  <h2>Robinhood MCP</h2>
  <p><a href="/status">MCP Status</a></p>
  <p><a href="/auth">Authentication</a></p>
  <p><a href="/test-read">Read-only Test</a></p>
</div>

<div class="card">
  <form method="POST" action="/logout">
    <button type="submit">Logout</button>
  </form>
</div>
`
  );
}

function bridgePage() {
  const signal = state.bridge.latestSignal;

  return page(
    "Scanner Bridge V2",
    `
<h1>Claude ↔ Robinhood</h1>

<div class="card">
  <h2>Scanner Bridge V2</h2>

  <p>
    Execution:
    <strong class="good">DISABLED</strong>
  </p>

  <p>
    Signals received:
    <strong>${state.bridge.received}</strong>
  </p>

  <p>
    Rejected:
    <strong>${state.bridge.rejected}</strong>
  </p>

  <p>
    Last received:
    ${escapeHtml(
      state.bridge.lastReceivedAt || "None"
    )}
  </p>
</div>

<div class="card">
  <h2>Latest Complete V2 Signal</h2>

  <pre>${escapeHtml(
    signal
      ? JSON.stringify(signal, null, 2)
      : "No signal received yet."
  )}</pre>
</div>

<div class="card">
  <p><a href="/decisions">Decision Engine</a></p>
</div>

<div class="card">
  <p><a href="/">Home</a></p>
</div>
`
  );
}

function decisionsPage() {
  return page(
    "Decision Engine",
    `
<h1>Dry-Run Decision Engine</h1>

<div class="card">
  <p>
    Decision mode:
    <strong>${
      state.decisions.enabled
        ? "ENABLED"
        : "DISABLED"
    }</strong>
  </p>

  <p>
    Robinhood execution:
    <strong class="good">DISABLED</strong>
  </p>

  <p>
    Running:
    <strong>${
      state.decisions.running
        ? "YES"
        : "NO"
    }</strong>
  </p>

  <p>Requested: ${state.decisions.requested}</p>
  <p>Completed: ${state.decisions.completed}</p>
  <p>Skipped: ${state.decisions.skipped}</p>
  <p>Failed: ${state.decisions.failed}</p>
</div>

<div class="card">
  <h2>Latest Decision</h2>

  <pre>${escapeHtml(
    state.decisions.latest
      ? JSON.stringify(
          state.decisions.latest,
          null,
          2
        )
      : "No decision yet."
  )}</pre>
</div>

<div class="card">
  <p><a href="/bridge">Scanner Bridge</a></p>
  <p><a href="/">Home</a></p>
</div>
`
  );
}

function authPage() {
  return page(
    "Robinhood Authentication",
    `
<h1>Robinhood Authentication</h1>

<div class="card">
  <p>
    Login running:
    <strong>${
      state.robinhood.loginRunning
        ? "YES"
        : "NO"
    }</strong>
  </p>

  <form method="POST" action="/auth/start">
    <button type="submit">
      Start Robinhood Login
    </button>
  </form>
</div>

<div class="card">
  <h2>Login Output</h2>
  <pre>${escapeHtml(
    state.robinhood.loginOutput ||
      "No login session started."
  )}</pre>
</div>

<div class="card">
  <form method="POST" action="/auth/callback">
    <input
      type="password"
      name="callback"
      placeholder="Paste localhost callback URL here"
      autocomplete="off"
    >
    <br><br>
    <button type="submit">
      Submit Callback
    </button>
  </form>
</div>

<div class="card">
  <p><a href="/">Home</a></p>
</div>
`
  );
}

function statusPage() {
  return page(
    "MCP Status",
    `
<h1>Robinhood MCP Status</h1>

<div class="card">
  <form method="POST" action="/status/run">
    <button type="submit">
      Refresh Status
    </button>
  </form>
</div>

<div class="card">
  <pre>${escapeHtml(
    state.robinhood.statusOutput ||
      "Status has not been refreshed."
  )}</pre>
</div>

<div class="card">
  <p><a href="/">Home</a></p>
</div>
`
  );
}

function testReadPage() {
  return page(
    "Read-only Test",
    `
<h1>Robinhood Read-only Test</h1>

<div class="card">
  <p>
    This test is intended only to verify
    that Robinhood account data can be read.
  </p>

  <form method="POST" action="/test-read/run">
    <button type="submit">
      Run Read-only Test
    </button>
  </form>
</div>

<div class="card">
  <pre>${escapeHtml(
    state.robinhood.testOutput ||
      "No test run yet."
  )}</pre>
</div>

<div class="card">
  <p><a href="/">Home</a></p>
</div>
`
  );
}

// ============================================================
// ROUTER
// ============================================================

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    const path = url.pathname;

    // --------------------------------------------------------
    // PUBLIC HEALTH
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      path === "/health"
    ) {
      return sendJson(res, 200, {
        status: "ok",
        service: "claude-robinhood-bridge",
        version: "2.0.0",
        execution_enabled: false,
      });
    }

    // --------------------------------------------------------
    // MACHINE BRIDGE
    // --------------------------------------------------------

    if (
      req.method === "POST" &&
      path === "/bridge/signal"
    ) {
      if (!bridgeAuthorized(req)) {
        state.bridge.rejected += 1;

        state.bridge.latestRejection = {
          at: new Date().toISOString(),
          reason: "Unauthorized bridge request",
        };

        return sendJson(res, 401, {
          error: "unauthorized",
        });
      }

      try {
        const body = await readBody(req);
        const raw = JSON.parse(body);

        const signal =
          acceptBridgeSignal(raw);

        return sendJson(res, 202, {
          accepted: true,
          symbol: signal.symbol,
          lifecycle: signal.lifecycle,
          setup: signal.setup,
          execution_enabled: false,
        });
      } catch (error) {
        state.bridge.rejected += 1;

        state.bridge.latestRejection = {
          at: new Date().toISOString(),
          reason: String(
            error.message || error
          ),
        };

        return sendJson(res, 400, {
          accepted: false,
          error: String(
            error.message || error
          ),
          execution_enabled: false,
        });
      }
    }

    // --------------------------------------------------------
    // LOGIN
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      path === "/login"
    ) {
      if (isAdmin(req)) {
        res.writeHead(302, {
          Location: "/",
        });
        return res.end();
      }

      return send(
        res,
        200,
        loginPage(),
        "text/html"
      );
    }

    if (
      req.method === "POST" &&
      path === "/login"
    ) {
      const body = await readBody(req);
      const form = parseForm(body);

      if (
        !timingSafeEqualString(
          form.password,
          ADMIN_PASSWORD
        )
      ) {
        return send(
          res,
          401,
          loginPage("Invalid password."),
          "text/html"
        );
      }

      securityHeaders(res);

      res.writeHead(302, {
        Location: "/",
        "Set-Cookie":
          `admin_session=${encodeURIComponent(
            ADMIN_SESSION_TOKEN
          )}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,
      });

      return res.end();
    }

    // Everything below requires admin auth.

    if (!isAdmin(req)) {
      res.writeHead(302, {
        Location: "/login",
      });
      return res.end();
    }

    // --------------------------------------------------------
    // HOME
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      path === "/"
    ) {
      return send(
        res,
        200,
        homePage(),
        "text/html"
      );
    }

    // --------------------------------------------------------
    // BRIDGE
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      path === "/bridge"
    ) {
      return send(
        res,
        200,
        bridgePage(),
        "text/html"
      );
    }

    // --------------------------------------------------------
    // DECISIONS
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      path === "/decisions"
    ) {
      return send(
        res,
        200,
        decisionsPage(),
        "text/html"
      );
    }

    // --------------------------------------------------------
    // AUTH
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      path === "/auth"
    ) {
      return send(
        res,
        200,
        authPage(),
        "text/html"
      );
    }

    if (
      req.method === "POST" &&
      path === "/auth/start"
    ) {
      startRobinhoodLogin();

      res.writeHead(303, {
        Location: "/auth",
      });

      return res.end();
    }

    if (
      req.method === "POST" &&
      path === "/auth/callback"
    ) {
      const body = await readBody(req);
      const form = parseForm(body);

      if (
        !state.robinhood.loginRunning ||
        !state.robinhood.loginInput
      ) {
        return send(
          res,
          400,
          "No Robinhood login process is waiting for input."
        );
      }

      const callback =
        String(form.callback || "").trim();

      if (
        !callback.startsWith(
          "http://localhost"
        ) &&
        !callback.startsWith(
          "https://localhost"
        )
      ) {
        return send(
          res,
          400,
          "Expected a localhost callback URL."
        );
      }

      state.robinhood.loginInput.write(
        callback + "\n"
      );

      res.writeHead(303, {
        Location: "/auth",
      });

      return res.end();
    }

    // --------------------------------------------------------
    // MCP STATUS
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      path === "/status"
    ) {
      return send(
        res,
        200,
        statusPage(),
        "text/html"
      );
    }

    if (
      req.method === "POST" &&
      path === "/status/run"
    ) {
      runRobinhoodStatus();

      res.writeHead(303, {
        Location: "/status",
      });

      return res.end();
    }

    // --------------------------------------------------------
    // READ ONLY TEST
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      path === "/test-read"
    ) {
      return send(
        res,
        200,
        testReadPage(),
        "text/html"
      );
    }

    if (
      req.method === "POST" &&
      path === "/test-read/run"
    ) {
      setImmediate(() => {
        runReadOnlyTest().catch(error => {
          state.robinhood.testRunning = false;
          state.robinhood.testOutput =
            String(error.message || error);
        });
      });

      res.writeHead(303, {
        Location: "/test-read",
      });

      return res.end();
    }

    // --------------------------------------------------------
    // LOGOUT
    // --------------------------------------------------------

    if (
      req.method === "POST" &&
      path === "/logout"
    ) {
      securityHeaders(res);

      res.writeHead(303, {
        Location: "/login",
        "Set-Cookie":
          "admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
      });

      return res.end();
    }

    return send(
      res,
      404,
      "Not found"
    );
  } catch (error) {
    console.error(
      "Request error:",
      error.message
    );

    return sendJson(res, 500, {
      error: "internal server error",
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Claude ↔ Robinhood Bridge V2 listening on ${PORT}`
  );

  console.log(
    "ROBINHOOD EXECUTION: DISABLED"
  );

  console.log(
    "V2 FULL SIGNAL PASSTHROUGH: ENABLED"
  );

  console.log(
    "DRY-RUN DECISION ENGINE: ENABLED"
  );
});