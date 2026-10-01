const http = require("http");
const { spawn, execFile } = require("child_process");
const { URL } = require("url");
const crypto = require("crypto");

// ============================================================
// CLAUDE ↔ ROBINHOOD BRIDGE V3
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

// ============================================================
// SAFETY
// ============================================================

const ROBINHOOD_EXECUTION_ENABLED = false;
const DECISION_MODE_ENABLED = true;

const MAX_SIGNAL_AGE_MS = 3 * 60 * 1000;
const DECISION_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

// Explicitly permitted Robinhood READ tools.
//
// Nothing that places, previews, modifies, cancels,
// exercises, transfers, or otherwise changes the account
// belongs in this list.

const ROBINHOOD_READ_TOOLS = [
  "mcp__robinhood-trading__get_accounts",
  "mcp__robinhood-trading__get_portfolio",

  "mcp__robinhood-trading__get_equity_positions",
  "mcp__robinhood-trading__get_option_positions",
  "mcp__robinhood-trading__get_crypto_positions",

  "mcp__robinhood-trading__get_realized_pnl",
  "mcp__robinhood-trading__get_pnl_trade_history",

  "mcp__robinhood-trading__get_equity_orders",
  "mcp__robinhood-trading__get_option_orders",
  "mcp__robinhood-trading__get_crypto_orders",

  "mcp__robinhood-trading__get_equity_quotes",
  "mcp__robinhood-trading__get_equity_historicals",
  "mcp__robinhood-trading__get_equity_fundamentals",
  "mcp__robinhood-trading__get_equity_analyst_ratings",
  "mcp__robinhood-trading__get_equity_price_book",
  "mcp__robinhood-trading__get_equity_technical_indicators",
  "mcp__robinhood-trading__get_equity_tradability",

  "mcp__robinhood-trading__get_financials",
  "mcp__robinhood-trading__get_earnings_calendar",
  "mcp__robinhood-trading__get_earnings_results",

  "mcp__robinhood-trading__get_option_chains",
  "mcp__robinhood-trading__get_option_instruments",
  "mcp__robinhood-trading__get_option_quotes",
  "mcp__robinhood-trading__get_option_historicals",

  "mcp__robinhood-trading__get_crypto_quotes",
  "mcp__robinhood-trading__get_currency_pairs",

  "mcp__robinhood-trading__get_indexes",
  "mcp__robinhood-trading__get_index_quotes",
  "mcp__robinhood-trading__get_index_historicals",

  "mcp__robinhood-trading__get_sec_filing",
  "mcp__robinhood-trading__get_sec_filing_index",
  "mcp__robinhood-trading__get_sec_filing_facts",
  "mcp__robinhood-trading__get_sec_filing_facts_catalog",

  "mcp__robinhood-trading__get_watchlists",
  "mcp__robinhood-trading__get_watchlist_items",
  "mcp__robinhood-trading__get_popular_watchlists",
  "mcp__robinhood-trading__get_option_watchlist",

  "mcp__robinhood-trading__get_alerts",
  "mcp__robinhood-trading__get_alert_log",

  "mcp__robinhood-trading__get_scans",
  "mcp__robinhood-trading__get_scanner_datapoints",
  "mcp__robinhood-trading__get_scanner_filter_specs",
  "mcp__robinhood-trading__run_scan",

  "mcp__robinhood-trading__search"
];

// Anything matching these classes is explicitly forbidden
// from the read-only account path.

const ROBINHOOD_WRITE_TOOLS = [
  "mcp__robinhood-trading__place_*",
  "mcp__robinhood-trading__cancel_*",
  "mcp__robinhood-trading__preview_*",
  "mcp__robinhood-trading__exercise_*",
  "mcp__robinhood-trading__replace_*",
  "mcp__robinhood-trading__modify_*"
];

// ============================================================
// ADMIN AUTH
// ============================================================

const ADMIN_SESSION_TOKEN = crypto
  .createHmac("sha256", ADMIN_PASSWORD)
  .update("claude-robinhood-admin-session-v3")
  .digest("hex");

function timingSafeEqualString(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));

  if (aa.length !== bb.length) return false;

  return crypto.timingSafeEqual(aa, bb);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const result = {};

  for (const item of header.split(";")) {
    const index = item.indexOf("=");

    if (index === -1) continue;

    result[item.slice(0, index).trim()] =
      decodeURIComponent(item.slice(index + 1).trim());
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

  if (!auth.startsWith("Bearer ")) return false;

  return timingSafeEqualString(
    auth.slice(7),
    SCANNER_BRIDGE_TOKEN
  );
}

// ============================================================
// STATE
// ============================================================

const state = {
  startedAt: new Date().toISOString(),

  bridge: {
    executionEnabled: false,
    received: 0,
    rejected: 0,
    lastReceivedAt: null,
    latestSignal: null,
    latestRejection: null
  },

  decisions: {
    enabled: DECISION_MODE_ENABLED,
    executionEnabled: false,
    requested: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    running: false,
    latest: null,
    bySymbol: {}
  },

  robinhood: {
  statusOutput: "",
  accountOutput: "",
  accountRunning: false,
  accountLastUpdated: null,

  authRunning: false,
  authOutput: "",
  authUrls: [],
  authStartedAt: null,
  authFinishedAt: null,
  authExitCode: null
}
};

let robinhoodAuthProcess = null;

// ============================================================
// HTTP HELPERS
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
  res.setHeader("Cache-Control", "no-store");
}

function send(res, status, body, type = "text/plain") {
  securityHeaders(res);

  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`
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
  return Object.fromEntries(
    new URLSearchParams(body).entries()
  );
}

// ============================================================
// CLAUDE
// ============================================================

function runClaude(args, prompt, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env
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
          stderr: stderr || ""
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
  return typeof value === "number" &&
    Number.isFinite(value);
}

function cleanStringArray(value, maxItems = 50) {
  if (!Array.isArray(value)) return [];

  return value
    .filter(x => typeof x === "string")
    .slice(0, maxItems)
    .map(x => x.slice(0, 500));
}

function validateSignal(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
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

  const allowedSessions = new Set([
    "premarket",
    "regular",
    "afterhours",
    "overnight",
    "closed"
  ]);

  const allowedLifecycle = new Set([
    "WATCH",
    "DEVELOPING",
    "QUALIFIED",
    "BUY_CANDIDATE",
    "PASS",
    "EXPIRED"
  ]);

  const marketSession =
    String(raw.market_session || "");

  const lifecycle =
    String(raw.lifecycle || "");

  if (
    marketSession &&
    !allowedSessions.has(marketSession)
  ) {
    throw new Error("Invalid market_session");
  }

  if (
    lifecycle &&
    !allowedLifecycle.has(lifecycle)
  ) {
    throw new Error("Invalid lifecycle");
  }

  if (raw.scanner_generated_at) {
    const generated =
      new Date(raw.scanner_generated_at);

    if (Number.isNaN(generated.getTime())) {
      throw new Error("Invalid scanner_generated_at");
    }

    const age = Date.now() - generated.getTime();

    if (age > MAX_SIGNAL_AGE_MS) {
      throw new Error("Stale signal");
    }

    if (age < -60000) {
      throw new Error("Signal timestamp is in the future");
    }
  }

  const signal =
    JSON.parse(JSON.stringify(raw));

  signal.symbol = symbol;
  signal.price = raw.price;
  signal.score = raw.score;
  signal.lifecycle = lifecycle || null;
  signal.market_session = marketSession || null;

  signal.reasons =
    cleanStringArray(raw.reasons);

  signal.risk_factors =
    cleanStringArray(raw.risk_factors);

  signal.warnings =
    cleanStringArray(raw.warnings);

  signal.bridge_received_at =
    new Date().toISOString();

  // Bridge remains authoritative.
  signal.execution_enabled = false;

  return signal;
}
// ============================================================
// SAFETY ASSESSMENT
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
    cautions.push("Extremely extended from VWAP");
  }

  if (
    finiteNumber(signal.change_pct) &&
    Math.abs(signal.change_pct) >= 30
  ) {
    cautions.push("Extreme move versus previous close");
  }

  if (
    signal.lifecycle === "BUY_CANDIDATE" &&
    signal.market_session !== "regular"
  ) {
    blocks.push(
      "BUY_CANDIDATE rejected outside regular session"
    );
  }

  return {
    blocked: blocks.length > 0,
    blocks,
    cautions
  };
}

// ============================================================
// DRY-RUN DECISION ENGINE
// ============================================================

function decisionCooldownAllows(signal) {
  const previous =
    state.decisions.bySymbol[signal.symbol];

  if (!previous) return true;

  if (
    Date.now() - previous.requestedAt >=
    DECISION_COOLDOWN_MS
  ) {
    return true;
  }

  return (
    finiteNumber(signal.score) &&
    finiteNumber(previous.score) &&
    signal.score >= previous.score + 2
  );
}

function extractJsonObject(text) {
  const value = String(text || "").trim();

  try {
    return JSON.parse(value);
  } catch (_) {}

  const first = value.indexOf("{");
  const last = value.lastIndexOf("}");

  if (first === -1 || last <= first) {
    throw new Error("Claude returned invalid JSON");
  }

  return JSON.parse(
    value.slice(first, last + 1)
  );
}

async function runDryDecision(signal) {
  if (!DECISION_MODE_ENABLED) return;

  if (
    state.decisions.running ||
    !decisionCooldownAllows(signal)
  ) {
    state.decisions.skipped++;
    return;
  }

  const safety =
    signalSafetyAssessment(signal);

  if (safety.blocked) {
    state.decisions.latest = {
      decision: "PASS",
      confidence: 100,
      symbol: signal.symbol,
      summary:
        "Blocked by deterministic safety gate.",
      risk_factors: safety.blocks,
      created_at: new Date().toISOString(),
      execution_enabled: false
    };

    state.decisions.completed++;
    return;
  }

  state.decisions.running = true;
  state.decisions.requested++;

  state.decisions.bySymbol[signal.symbol] = {
    requestedAt: Date.now(),
    score: signal.score
  };

  const prompt = `
Analyze this intraday scanner signal.

DRY RUN ONLY.

Do not use Robinhood or any MCP tool.
Do not place, preview, prepare, modify, or cancel orders.

Return ONLY JSON:

{
  "decision":"WATCH|PASS|BUY_CANDIDATE",
  "confidence":0,
  "summary":"",
  "positive_factors":[],
  "risk_factors":[],
  "missing_information":[],
  "invalidation_conditions":[]
}

Signal:
${JSON.stringify(signal, null, 2)}
`;

  try {
    const result = await runClaude(
      [
        "-p",
        "--disallowedTools",
        "mcp__robinhood-trading__*"
      ],
      prompt
    );

    const parsed =
      extractJsonObject(result.stdout);

    let decision =
      String(parsed.decision || "PASS").toUpperCase();

    if (
      !["WATCH", "PASS", "BUY_CANDIDATE"]
        .includes(decision)
    ) {
      decision = "PASS";
    }

    if (
      decision === "BUY_CANDIDATE" &&
      signal.market_session !== "regular"
    ) {
      decision = "WATCH";
    }

    state.decisions.latest = {
      ...parsed,
      decision,
      symbol: signal.symbol,
      scanner_score: signal.score,
      scanner_lifecycle: signal.lifecycle,
      market_session: signal.market_session,
      created_at: new Date().toISOString(),
      execution_enabled: false
    };

    state.decisions.completed++;
  } catch (error) {
    state.decisions.failed++;

    state.decisions.latest = {
      decision: "PASS",
      confidence: 0,
      symbol: signal.symbol,
      summary: "Decision engine error.",
      error: String(error.message || error),
      created_at: new Date().toISOString(),
      execution_enabled: false
    };
  } finally {
    state.decisions.running = false;
  }
}

// ============================================================
// SIGNAL ACCEPTANCE
// ============================================================

function acceptBridgeSignal(raw) {
  const signal = validateSignal(raw);

  signal.bridge_safety =
    signalSafetyAssessment(signal);

  state.bridge.received++;
  state.bridge.lastReceivedAt =
    new Date().toISOString();

  state.bridge.latestSignal = signal;

  setImmediate(() => {
    runDryDecision(signal).catch(console.error);
  });

  return signal;
}

// ============================================================
// CLAUDE / ROBINHOOD STATUS
// ============================================================

async function refreshClaudeStatus() {
  state.robinhood.statusOutput = "Checking Claude MCP status...";

  try {
    const result = await runClaude(
      [
        "-p",
        "--disallowedTools",
        "mcp__robinhood-trading__*"
      ],
      `
Do not use any MCP tools.

Return a short plain-text status confirming that the Claude
runtime is responding.

Do not perform any account action.
Do not place, preview, modify, or cancel any order.
`
    );

    state.robinhood.statusOutput =
      result.stdout.trim() || "Claude runtime responded.";
  } catch (error) {
    state.robinhood.statusOutput =
      `Claude status error:\n${String(error.message || error)}`;
  }
}

// ============================================================
// ROBINHOOD READ-ONLY ACCOUNT CHECK
// ============================================================

async function refreshRobinhoodAccount() {
  if (state.robinhood.accountRunning) return;

  state.robinhood.accountRunning = true;
  state.robinhood.accountOutput = "Refreshing...";

  const prompt = `
Use Robinhood READ-ONLY tools to inspect the connected account.

You may retrieve:
- account information
- portfolio information
- equity positions
- option positions
- crypto positions
- recent equity orders
- recent option orders
- recent crypto orders

Do NOT:
- place an order
- preview an order
- cancel an order
- modify or replace an order
- exercise an option
- transfer funds or assets
- make any account change

This is an account connectivity/status check only.

Return a concise plain-text report containing:
1. Whether Robinhood appears connected.
2. Account/portfolio value if available.
3. Buying power or cash if available.
4. Current positions if available.
5. Any authentication or connection error encountered.

Do not recommend or execute any trade.
`;

  try {
    const args = [
      "-p",
      "--allowedTools",
      ROBINHOOD_READ_TOOLS.join(","),
      "--disallowedTools",
      ROBINHOOD_WRITE_TOOLS.join(",")
    ];

    const result = await runClaude(
      args,
      prompt,
      180000
    );

    state.robinhood.accountOutput =
      result.stdout.trim() ||
      "Robinhood check completed with no output.";

    state.robinhood.accountLastUpdated =
      new Date().toISOString();
  } catch (error) {
    state.robinhood.accountOutput =
      `Robinhood account check failed:\n${
        String(error.message || error)
      }`;

    state.robinhood.accountLastUpdated =
      new Date().toISOString();
  } finally {
    state.robinhood.accountRunning = false;
  }
}
// ============================================================
// ROBINHOOD MCP AUTHENTICATION
// ============================================================

function extractHttpsUrls(text) {
  const matches =
    String(text || "")
      .match(/https:\/\/[^\s\x1b\x07"'<>]+/g) || [];

  return [...new Set(matches)]
    .filter(url => {
      try {
        return new URL(url).protocol === "https:";
      } catch (_) {
        return false;
      }
    });
}

function appendRobinhoodAuthOutput(chunk) {
  const value = String(chunk || "");

  state.robinhood.authOutput += value;

  if (state.robinhood.authOutput.length > 50000) {
    state.robinhood.authOutput =
      state.robinhood.authOutput.slice(-50000);
  }

  const urls =
    extractHttpsUrls(state.robinhood.authOutput);

  state.robinhood.authUrls = urls;
}

function startRobinhoodAuthentication() {
  if (state.robinhood.authRunning) {
    return false;
  }

  state.robinhood.authRunning = true;
  state.robinhood.authOutput =
    "Starting Robinhood MCP authentication through PTY...\n";
  state.robinhood.authUrls = [];
  state.robinhood.authStartedAt =
    new Date().toISOString();
  state.robinhood.authFinishedAt = null;
  state.robinhood.authExitCode = null;

  // `script` gives Claude a real pseudo-terminal (PTY).
  robinhoodAuthProcess = spawn(
    "script",
    [
      "-q",
      "-c",
      "claude mcp login robinhood-trading --no-browser",
      "/dev/null"
    ],
    {
      env: {
        ...process.env,
        TERM: process.env.TERM || "xterm-256color"
      },
      stdio: [
        "pipe",
        "pipe",
        "pipe"
      ]
    }
  );

  robinhoodAuthProcess.stdout.on(
    "data",
    chunk => {
      appendRobinhoodAuthOutput(chunk);
    }
  );

  robinhoodAuthProcess.stderr.on(
    "data",
    chunk => {
      appendRobinhoodAuthOutput(chunk);
    }
  );

  robinhoodAuthProcess.on(
    "error",
    error => {
      appendRobinhoodAuthOutput(
        `\nPTY launch failed:\n${
          String(error.message || error)
        }\n\nIf the error says spawn script ENOENT, ` +
        "`script` is not installed in the Railway container."
      );

      state.robinhood.authRunning = false;
      state.robinhood.authFinishedAt =
        new Date().toISOString();

      robinhoodAuthProcess = null;
    }
  );

  robinhoodAuthProcess.on(
    "close",
    code => {
      state.robinhood.authRunning = false;
      state.robinhood.authFinishedAt =
        new Date().toISOString();
      state.robinhood.authExitCode = code;

      appendRobinhoodAuthOutput(
        `\nAuthentication process finished with code ${code}.\n`
      );

      robinhoodAuthProcess = null;
    }
  );

  return true;
}

function submitRobinhoodCallback(callbackUrl) {
  if (
    !state.robinhood.authRunning ||
    !robinhoodAuthProcess ||
    !robinhoodAuthProcess.stdin
  ) {
    throw new Error(
      "No Robinhood authentication process is waiting."
    );
  }

  const value =
    String(callbackUrl || "").trim();

  if (!value) {
    throw new Error(
      "Callback URL is required."
    );
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch (_) {
    throw new Error(
      "Callback URL is invalid."
    );
  }

  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    throw new Error(
      "Callback URL must use http or https."
    );
  }

  robinhoodAuthProcess.stdin.write(
    value + "\n"
  );

  appendRobinhoodAuthOutput(
    "\nCallback URL submitted.\n"
  );
}
// ============================================================
// ADMIN HTML
// ============================================================

function renderLoginPage(message = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>
<title>Bridge Admin Login</title>
<style>
  body {
    font-family: system-ui, -apple-system, sans-serif;
    background: #111;
    color: #eee;
    margin: 0;
    padding: 32px 18px;
  }

  .card {
    max-width: 520px;
    margin: 40px auto;
    background: #1b1b1b;
    border: 1px solid #333;
    border-radius: 14px;
    padding: 24px;
  }

  h1 {
    margin-top: 0;
    font-size: 24px;
  }

  input {
    box-sizing: border-box;
    width: 100%;
    padding: 12px;
    margin: 10px 0 16px;
    border-radius: 8px;
    border: 1px solid #444;
    background: #0d0d0d;
    color: #fff;
  }

  button {
    padding: 11px 16px;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 700;
  }

  .error {
    color: #ff8d8d;
    white-space: pre-wrap;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>Claude ↔ Robinhood Bridge</h1>
    <p>Administrator login</p>

    ${
      message
        ? `<p class="error">${escapeHtml(message)}</p>`
        : ""
    }

    <form method="post" action="/admin/login">
      <label for="password">Admin password</label>
      <input
        id="password"
        name="password"
        type="password"
        autocomplete="current-password"
        required
      >
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}

function renderAdminPage() {
  const latestSignal = state.bridge.latestSignal
    ? JSON.stringify(state.bridge.latestSignal, null, 2)
    : "No signal received yet.";

  const latestDecision = state.decisions.latest
    ? JSON.stringify(state.decisions.latest, null, 2)
    : "No decision produced yet.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>
<title>Claude ↔ Robinhood Bridge</title>
<style>
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0;
    background: #101010;
    color: #ededed;
  }

  main {
    max-width: 1050px;
    margin: 0 auto;
    padding: 24px 16px 60px;
  }

  h1, h2 {
    margin-bottom: 10px;
  }

  .status {
    display: inline-block;
    padding: 5px 9px;
    border: 1px solid #444;
    border-radius: 999px;
    margin-right: 8px;
    margin-bottom: 8px;
  }

  .card {
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 12px;
    padding: 18px;
    margin: 16px 0;
  }

  pre {
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    background: #0b0b0b;
    border: 1px solid #303030;
    border-radius: 8px;
    padding: 14px;
  }

  button {
    padding: 10px 14px;
    margin: 4px 6px 4px 0;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 700;
  }

  a {
    color: #b9d8ff;
  }

  .warning {
    color: #ffd27d;
  }
</style>
</head>
<body>
<main>
  <h1>Claude ↔ Robinhood Bridge V3</h1>

  <div>
    <span class="status">
      Execution:
      ${ROBINHOOD_EXECUTION_ENABLED ? "ENABLED" : "DISABLED"}
    </span>

    <span class="status">
      Decision mode:
      ${DECISION_MODE_ENABLED ? "ENABLED" : "DISABLED"}
    </span>

    <span class="status">
      Signals received:
      ${state.bridge.received}
    </span>
  </div>

  <p class="warning">
    Robinhood execution is disabled. This service does not
    intentionally permit Robinhood write/order tools.
  </p>

  <div class="card">
    <h2>Runtime</h2>

    <p>
      Started:
      ${escapeHtml(state.startedAt)}
    </p>

    <form
      method="post"
      action="/admin/claude-status"
    >
      <button type="submit">
        Check Claude Runtime
      </button>
    </form>

    <pre>${
      escapeHtml(
        state.robinhood.statusOutput ||
        "Claude status has not been checked."
      )
    }</pre>
  </div>
  <div class="card">
    <h2>Robinhood Authentication</h2>

    <p>
      Status:
      ${
        state.robinhood.authRunning
          ? "Authentication in progress"
          : "Not running"
      }
    </p>

    <form
      method="post"
      action="/admin/robinhood-auth-start"
    >
      <button
        type="submit"
        ${
          state.robinhood.authRunning
            ? "disabled"
            : ""
        }
      >
        Start Robinhood Authentication
      </button>
    </form>

    ${
      state.robinhood.authUrls.length
        ? `
          <p><strong>Authentication links:</strong></p>

          ${state.robinhood.authUrls
            .map(
              url => `
                <p>
                  <a
                    href="${escapeHtml(url)}"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Robinhood Authentication
                  </a>
                </p>
              `
            )
            .join("")}
        `
        : ""
    }

    ${
      state.robinhood.authRunning
        ? `
          <form
            method="post"
            action="/admin/robinhood-auth-callback"
          >
            <p>
              After Robinhood finishes,
              copy the full URL from your browser's
              address bar and paste it below.
            </p>

            <input
              name="callback_url"
              type="text"
              placeholder="Paste callback URL here"
              required
              style="
                box-sizing:border-box;
                width:100%;
                padding:12px;
                margin:8px 0 12px;
                border-radius:8px;
                border:1px solid #444;
                background:#0d0d0d;
                color:#fff;
              "
            >

            <button type="submit">
              Submit Callback URL
            </button>
          </form>
        `
        : ""
    }

    <pre>${
      escapeHtml(
        state.robinhood.authOutput ||
        "Authentication has not been started."
      )
    }</pre>
  </div>
  <div class="card">
    <h2>Robinhood Read-Only Check</h2>

    <p>
      Last updated:
      ${
        escapeHtml(
          state.robinhood.accountLastUpdated ||
          "Never"
        )
      }
    </p>

    <form
      method="post"
      action="/admin/robinhood-refresh"
    >
      <button
        type="submit"
        ${
          state.robinhood.accountRunning
            ? "disabled"
            : ""
        }
      >
        ${
          state.robinhood.accountRunning
            ? "Refreshing..."
            : "Refresh Robinhood Account"
        }
      </button>
    </form>

    <pre>${
      escapeHtml(
        state.robinhood.accountOutput ||
        "Robinhood has not been checked."
      )
    }</pre>
  </div>

  <div class="card">
    <h2>Latest Scanner Signal</h2>
    <pre>${escapeHtml(latestSignal)}</pre>
  </div>

  <div class="card">
    <h2>Latest Dry-Run Decision</h2>
    <pre>${escapeHtml(latestDecision)}</pre>
  </div>

  <div class="card">
    <h2>Bridge Statistics</h2>
    <pre>${escapeHtml(
      JSON.stringify(
        {
          bridge: {
            executionEnabled:
              state.bridge.executionEnabled,
            received:
              state.bridge.received,
            rejected:
              state.bridge.rejected,
            lastReceivedAt:
              state.bridge.lastReceivedAt,
            latestRejection:
              state.bridge.latestRejection
          },

          decisions: {
            enabled:
              state.decisions.enabled,
            executionEnabled:
              state.decisions.executionEnabled,
            requested:
              state.decisions.requested,
            completed:
              state.decisions.completed,
            failed:
              state.decisions.failed,
            skipped:
              state.decisions.skipped,
            running:
              state.decisions.running
          }
        },
        null,
        2
      )
    )}</pre>
  </div>

  <p>
    <a href="/admin/logout">Sign out</a>
  </p>
</main>
</body>
</html>`;
}
// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    // --------------------------------------------------------
    // HEALTH
    // --------------------------------------------------------

    if (req.method === "GET" && url.pathname === "/") {
      return sendJson(res, 200, {
        service: "claude-robinhood-bridge",
        version: "3.0.0",
        status: "ok",
        execution_enabled: ROBINHOOD_EXECUTION_ENABLED,
        decision_mode_enabled: DECISION_MODE_ENABLED,
        started_at: state.startedAt
      });
    }

    if (
      req.method === "GET" &&
      url.pathname === "/health"
    ) {
      return sendJson(res, 200, {
        ok: true,
        service: "claude-robinhood-bridge",
        execution_enabled: false,
        uptime_seconds: Math.floor(process.uptime())
      });
    }

    // --------------------------------------------------------
    // BRIDGE STATUS
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      url.pathname === "/bridge/status"
    ) {
      if (!bridgeAuthorized(req)) {
        return sendJson(res, 401, {
          error: "Unauthorized"
        });
      }

      return sendJson(res, 200, {
        execution_enabled: false,

        bridge: {
          received: state.bridge.received,
          rejected: state.bridge.rejected,
          last_received_at:
            state.bridge.lastReceivedAt,
          latest_signal:
            state.bridge.latestSignal,
          latest_rejection:
            state.bridge.latestRejection
        },

        decisions: {
          enabled:
            state.decisions.enabled,
          execution_enabled: false,
          requested:
            state.decisions.requested,
          completed:
            state.decisions.completed,
          failed:
            state.decisions.failed,
          skipped:
            state.decisions.skipped,
          running:
            state.decisions.running,
          latest:
            state.decisions.latest
        }
      });
    }

    // --------------------------------------------------------
    // RECEIVE SCANNER SIGNAL
    // --------------------------------------------------------

    if (
      req.method === "POST" &&
      url.pathname === "/bridge/signal"
    ) {
      if (!bridgeAuthorized(req)) {
        state.bridge.rejected++;

        state.bridge.latestRejection = {
          reason: "Unauthorized",
          at: new Date().toISOString()
        };

        return sendJson(res, 401, {
          accepted: false,
          error: "Unauthorized"
        });
      }

      let body;

      try {
        body = await readBody(req);
      } catch (error) {
        state.bridge.rejected++;

        state.bridge.latestRejection = {
          reason: String(error.message || error),
          at: new Date().toISOString()
        };

        return sendJson(res, 413, {
          accepted: false,
          error: "Request body rejected"
        });
      }

      let raw;

      try {
        raw = JSON.parse(body);
      } catch (_) {
        state.bridge.rejected++;

        state.bridge.latestRejection = {
          reason: "Invalid JSON",
          at: new Date().toISOString()
        };

        return sendJson(res, 400, {
          accepted: false,
          error: "Invalid JSON"
        });
      }

      try {
        const signal = acceptBridgeSignal(raw);

        return sendJson(res, 202, {
          accepted: true,
          execution_enabled: false,
          symbol: signal.symbol,
          lifecycle: signal.lifecycle,
          score: signal.score,
          received_at:
            signal.bridge_received_at
        });
      } catch (error) {
        state.bridge.rejected++;

        state.bridge.latestRejection = {
          reason: String(error.message || error),
          at: new Date().toISOString()
        };

        return sendJson(res, 400, {
          accepted: false,
          error: String(error.message || error)
        });
      }
    }

    // --------------------------------------------------------
    // ADMIN LOGIN PAGE
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      url.pathname === "/admin/login"
    ) {
      if (isAdmin(req)) {
        res.writeHead(302, {
          Location: "/admin"
        });

        return res.end();
      }

      return send(
        res,
        200,
        renderLoginPage(),
        "text/html"
      );
    }

    // --------------------------------------------------------
    // ADMIN LOGIN
    // --------------------------------------------------------

    if (
      req.method === "POST" &&
      url.pathname === "/admin/login"
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
          renderLoginPage("Incorrect password."),
          "text/html"
        );
      }

      securityHeaders(res);

      res.writeHead(302, {
        Location: "/admin",

        "Set-Cookie":
          `admin_session=${encodeURIComponent(
            ADMIN_SESSION_TOKEN
          )}; Path=/; HttpOnly; Secure; SameSite=Strict`
      });

      return res.end();
    }

    // --------------------------------------------------------
    // ADMIN LOGOUT
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      url.pathname === "/admin/logout"
    ) {
      securityHeaders(res);

      res.writeHead(302, {
        Location: "/admin/login",

        "Set-Cookie":
          "admin_session=; Path=/; HttpOnly; Secure; " +
          "SameSite=Strict; Max-Age=0"
      });

      return res.end();
    }

    // --------------------------------------------------------
    // ADMIN HOME
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      url.pathname === "/admin"
    ) {
      if (!isAdmin(req)) {
        res.writeHead(302, {
          Location: "/admin/login"
        });

        return res.end();
      }

      return send(
        res,
        200,
        renderAdminPage(),
        "text/html"
      );
    }

    // --------------------------------------------------------
    // CHECK CLAUDE RUNTIME
    // --------------------------------------------------------

    if (
      req.method === "POST" &&
      url.pathname === "/admin/claude-status"
    ) {
      if (!isAdmin(req)) {
        return sendJson(res, 401, {
          error: "Unauthorized"
        });
      }

      await refreshClaudeStatus();

      res.writeHead(303, {
        Location: "/admin"
      });

      return res.end();
    }

    // --------------------------------------------------------
    // REFRESH ROBINHOOD ACCOUNT
    // --------------------------------------------------------

    if (
      req.method === "POST" &&
      url.pathname === "/admin/robinhood-refresh"
    ) {
      if (!isAdmin(req)) {
        return sendJson(res, 401, {
          error: "Unauthorized"
        });
      }

      if (!state.robinhood.accountRunning) {
        setImmediate(() => {
          refreshRobinhoodAccount()
            .catch(error => {
              console.error(
                "Robinhood refresh error:",
                error
              );
            });
        });
      }

      res.writeHead(303, {
        Location: "/admin"
      });

      return res.end();
    }

    // --------------------------------------------------------
    // ADMIN JSON STATUS
    // --------------------------------------------------------

    if (
      req.method === "GET" &&
      url.pathname === "/admin/status.json"
    ) {
      if (!isAdmin(req)) {
        return sendJson(res, 401, {
          error: "Unauthorized"
        });
      }

      return sendJson(res, 200, {
        started_at: state.startedAt,

        execution_enabled:
          ROBINHOOD_EXECUTION_ENABLED,

        decision_mode_enabled:
          DECISION_MODE_ENABLED,

        bridge: {
          received:
            state.bridge.received,

          rejected:
            state.bridge.rejected,

          last_received_at:
            state.bridge.lastReceivedAt,

          latest_signal:
            state.bridge.latestSignal,

          latest_rejection:
            state.bridge.latestRejection
        },

        decisions: {
          requested:
            state.decisions.requested,

          completed:
            state.decisions.completed,

          failed:
            state.decisions.failed,

          skipped:
            state.decisions.skipped,

          running:
            state.decisions.running,

          latest:
            state.decisions.latest
        },

        robinhood: {
          account_running:
            state.robinhood.accountRunning,

          account_last_updated:
            state.robinhood.accountLastUpdated,

          account_output:
            state.robinhood.accountOutput,

          claude_status:
            state.robinhood.statusOutput
        }
      });
    }
    // --------------------------------------------------------
    // START ROBINHOOD AUTH
    // --------------------------------------------------------

    if (
      req.method === "POST" &&
      url.pathname === "/admin/robinhood-auth-start"
    ) {
      if (!isAdmin(req)) {
        return sendJson(res, 401, {
          error: "Unauthorized"
        });
      }

      startRobinhoodAuthentication();

      res.writeHead(303, {
        Location: "/admin"
      });

      return res.end();
    }

    // --------------------------------------------------------
    // SUBMIT ROBINHOOD CALLBACK
    // --------------------------------------------------------

    if (
      req.method === "POST" &&
      url.pathname === "/admin/robinhood-auth-callback"
    ) {
      if (!isAdmin(req)) {
        return sendJson(res, 401, {
          error: "Unauthorized"
        });
      }

      try {
        const body = await readBody(req);
        const form = parseForm(body);

        submitRobinhoodCallback(
          form.callback_url
        );

        res.writeHead(303, {
          Location: "/admin"
        });

        return res.end();
      } catch (error) {
        return send(
          res,
          400,
          `Robinhood authentication error:\n${
            String(error.message || error)
          }`
        );
      }
    }
    // --------------------------------------------------------
    // NOT FOUND
    // --------------------------------------------------------

    return sendJson(res, 404, {
      error: "Not found"
    });
  } catch (error) {
    console.error("HTTP request error:", error);

    if (!res.headersSent) {
      return sendJson(res, 500, {
        error: "Internal server error"
      });
    }

    try {
      res.end();
    } catch (_) {}
  }
});

// ============================================================
// SERVER ERRORS
// ============================================================

server.on("clientError", (error, socket) => {
  console.error("Client error:", error.message);

  if (socket.writable) {
    socket.end(
      "HTTP/1.1 400 Bad Request\r\n" +
      "Connection: close\r\n" +
      "\r\n"
    );
  }
});

server.on("error", error => {
  console.error("Server error:", error);
  process.exitCode = 1;
});

// ============================================================
// START
// ============================================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Claude ↔ Robinhood Bridge V3 listening on port ${PORT}`
  );

  console.log(
    "Robinhood execution enabled:",
    ROBINHOOD_EXECUTION_ENABLED
  );

  console.log(
    "Decision mode enabled:",
    DECISION_MODE_ENABLED
  );

  console.log(
    "Admin:",
    "/admin"
  );

  console.log(
    "Signal endpoint:",
    "/bridge/signal"
  );
});