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

    loginOutput: "",
    loginRunning: false,
    loginInput: null
  }
};

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
// ROBINHOOD READ-ONLY ACCOUNT CHECK
// ============================================================

async function refreshRobinhoodAccount() {
  if (state.robinhood.accountRunning) return;

  state.robinhood.accountRunning = true;
  state.robinhood.accountOutput = "Refreshing...";

  const prompt = `
Use Robinhood