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

// ============================================================
// LIVE EXECUTION SAFETY LIMITS
// ============================================================

// Keep FALSE until the complete execution path passes testing.
const LIVE_ORDER_SUBMISSION_ENABLED = false;

// Only BUY_CANDIDATE decisions at or above this confidence
// can progress to the execution gate.
const MIN_EXECUTION_CONFIDENCE = 80;

// Hard dollar limits for the $500 agentic account.
const MAX_POSITION_DOLLARS = 100;
const MAX_TOTAL_EXPOSURE_DOLLARS = 300;

// Limit simultaneous exposure.
const MAX_OPEN_POSITIONS = 3;

// Reject stale signals before execution.
const MAX_EXECUTION_SIGNAL_AGE_MS = 60 * 1000;

// Liquidity protection.
const MAX_EXECUTION_SPREAD_PCT = 0.75;

// Existing bridge/decision settings.
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

const MICRO_ROBINHOOD_READ_TOOLS = [
  "mcp__robinhood-trading__get_accounts",
  "mcp__robinhood-trading__get_portfolio",
  "mcp__robinhood-trading__get_equity_positions",
  "mcp__robinhood-trading__get_equity_orders",
  "mcp__robinhood-trading__get_equity_quotes",
  "mcp__robinhood-trading__get_equity_historicals",
  "mcp__robinhood-trading__get_equity_fundamentals",
  "mcp__robinhood-trading__get_equity_price_book",
  "mcp__robinhood-trading__get_equity_technical_indicators",
  "mcp__robinhood-trading__get_equity_tradability",
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
    latestRejection: null,
    microV4: {
      received: 0,
      lastReceivedAt: null,
      latestSignal: null
    }
  },

  microResearch: {
    cacheTtlMs: 15 * 60 * 1000,
    bySymbol: {},
    running: {},
    completed: 0,
    failed: 0
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
    pendingMicro: null,
    bySymbol: {}
  },
  execution: {
    enabled: ROBINHOOD_EXECUTION_ENABLED,
    liveSubmissionEnabled: LIVE_ORDER_SUBMISSION_ENABLED,

    evaluated: 0,
    approved: 0,
    blocked: 0,
    previewed: 0,
    submitted: 0,
    failed: 0,

    running: false,

    latestProposal: null,
    latestResult: null,
    latestError: null,

    limits: {
      minConfidence: MIN_EXECUTION_CONFIDENCE,
      maxPositionDollars: MAX_POSITION_DOLLARS,
      maxTotalExposureDollars: MAX_TOTAL_EXPOSURE_DOLLARS,
      maxOpenPositions: MAX_OPEN_POSITIONS,
      maxSignalAgeMs: MAX_EXECUTION_SIGNAL_AGE_MS,
      maxSpreadPct: MAX_EXECUTION_SPREAD_PCT
    }
  },
  robinhood: {
  statusOutput: "",
  cliDiagnosticsOutput: "",
  singleToolDiagnosticsOutput: "",
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
  signal.strategy =
    String(raw.strategy || "MAIN").trim().toUpperCase();
  signal.strategy_version =
    raw.strategy_version || null;

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
    const microResearchSession =
      signal.strategy === "MICRO_V4" &&
      (
        signal.market_session === "premarket" ||
        signal.market_session === "afterhours"
      );

    if (microResearchSession) {
      cautions.push(
        "Micro V4 extended-hours research only; execution remains blocked"
      );
    } else {
      blocks.push(
        "BUY_CANDIDATE rejected outside regular session"
      );
    }
  }

  return {
    blocked: blocks.length > 0,
    blocks,
    cautions
  };
}
function executionGate(signal, decision) {
  const blocks = [];
  const cautions = [];

  state.execution.evaluated++;

  if (!signal || !decision) {
    blocks.push("Missing signal or decision");
  }

  if (decision?.decision !== "BUY_CANDIDATE") {
    blocks.push("Decision is not BUY_CANDIDATE");
  }

  const confidence = Number(decision?.confidence);

  if (
    !Number.isFinite(confidence) ||
    confidence < MIN_EXECUTION_CONFIDENCE
  ) {
    blocks.push(
      `Confidence below ${MIN_EXECUTION_CONFIDENCE}`
    );
  }

  if (signal?.market_session !== "regular") {
    blocks.push("Execution permitted only during regular session");
  }

  if (signal?.scanner_generated_at) {
    const generated =
      new Date(signal.scanner_generated_at);

    if (Number.isNaN(generated.getTime())) {
      blocks.push("Invalid scanner timestamp");
    } else {
      const age = Date.now() - generated.getTime();

      if (
        age < 0 ||
        age > MAX_EXECUTION_SIGNAL_AGE_MS
      ) {
        blocks.push("Signal too old for execution");
      }
    }
  } else {
    blocks.push("Missing scanner timestamp");
  }

  const spread =
    Number(decision?.market_context?.spread_pct);

  if (!Number.isFinite(spread)) {
    blocks.push("Live spread unavailable");
  } else if (spread > MAX_EXECUTION_SPREAD_PCT) {
    blocks.push(
      `Spread exceeds ${MAX_EXECUTION_SPREAD_PCT}%`
    );
  }

  const buyingPower =
    Number(decision?.account_context?.buying_power);

  if (!Number.isFinite(buyingPower)) {
    blocks.push("Buying power unavailable");
  } else if (buyingPower <= 0) {
    blocks.push("No buying power available");
  }

  if (decision?.account_context?.existing_position === true) {
    cautions.push("Existing position already present");
  }

  if (signal?.strategy === "MICRO_V4") {
    if (signal?.lifecycle !== "BUY_CANDIDATE") {
      blocks.push(
        "Micro lifecycle is not BUY_CANDIDATE"
      );
    }

    if (signal?.above_vwap !== true) {
      blocks.push(
        "Micro entry is not above VWAP"
      );
    }

    const relativeVolume =
      Number(signal?.relative_minute_volume);

    if (
      !Number.isFinite(relativeVolume) ||
      relativeVolume < 1.80
    ) {
      blocks.push(
        "Micro relative minute volume below 1.80x"
      );
    }

    const volumeAcceleration =
      Number(signal?.volume_acceleration);

    if (
      !Number.isFinite(volumeAcceleration) ||
      volumeAcceleration < 1.25
    ) {
      blocks.push(
        "Micro volume acceleration below 1.25x"
      );
    }

    const structureRisk =
      Number(
        signal?.risk_model?.structure_risk_pct
      );

    if (
      !Number.isFinite(structureRisk) ||
      structureRisk <= 0 ||
      structureRisk > 0.80
    ) {
      blocks.push(
        "Micro structure risk invalid or above 0.80%"
      );
    }
  }

  const approved = blocks.length === 0;

  if (approved) {
    state.execution.approved++;
  } else {
    state.execution.blocked++;
  }

  const result = {
    approved,
    symbol: signal?.symbol || null,
    decision: decision?.decision || null,
    confidence:
      Number.isFinite(confidence) ? confidence : null,

    proposedMaxPositionDollars:
      Math.min(
        MAX_POSITION_DOLLARS,
        Number.isFinite(buyingPower)
          ? Math.max(0, buyingPower)
          : 0
      ),

    limits: {
      maxPositionDollars: MAX_POSITION_DOLLARS,
      maxTotalExposureDollars:
        MAX_TOTAL_EXPOSURE_DOLLARS,
      maxOpenPositions: MAX_OPEN_POSITIONS,
      maxSignalAgeMs:
        MAX_EXECUTION_SIGNAL_AGE_MS,
      maxSpreadPct:
        MAX_EXECUTION_SPREAD_PCT,
      minConfidence:
        MIN_EXECUTION_CONFIDENCE
    },

    blocks,
    cautions,

    preview_allowed:
      approved &&
      ROBINHOOD_EXECUTION_ENABLED,

    submission_allowed:
      approved &&
      ROBINHOOD_EXECUTION_ENABLED &&
      LIVE_ORDER_SUBMISSION_ENABLED,

    evaluated_at: new Date().toISOString()
  };

  state.execution.latestResult = result;

  return result;
}
// ============================================================
// MICRO PRE-RESEARCH CACHE
// ============================================================

function getCachedMicroResearch(symbol) {
  const row = state.microResearch.bySymbol[symbol];
  if (!row) return null;
  const ageMs = Date.now() - new Date(row.researched_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs > state.microResearch.cacheTtlMs) {
    return null;
  }
  return { ...row, age_ms: ageMs };
}

async function preResearchMicro(signal) {
  if (!signal || signal.strategy !== "MICRO_V4") return;
  const symbol = signal.symbol;
  if (!symbol || state.microResearch.running[symbol]) return;
  if (getCachedMicroResearch(symbol)) return;

  state.microResearch.running[symbol] = true;
  const prompt = `
Research ${symbol} for a potential MICRO_V4 momentum setup using READ-ONLY
Robinhood tools only. This is background research, not an entry decision.
Prioritize float, shares outstanding, market cap, average volume, earnings
context, available catalyst/company context, supply/dilution risk, and
tradability. Never authorize an entry or use a write/order tool.

Return ONLY valid JSON:
{"symbol":"${symbol}","background_verdict":"CLEAR|CAUTION|UNKNOWN",
"float":null,"shares_outstanding":null,"market_cap":null,
"average_volume":null,"catalyst_context":"","supply_risks":[],
"tradability_context":"","missing_information":[]}
`;

  try {
    const args = [
      "-p", "--allowedTools",
      "mcp__robinhood-trading__get_equity_fundamentals",
      "mcp__robinhood-trading__get_equity_tradability",
      "mcp__robinhood-trading__get_equity_historicals",
      "mcp__robinhood-trading__get_earnings_results",
      "mcp__robinhood-trading__get_sec_filing_index",
      "mcp__robinhood-trading__search"
    ];
    const result = await runClaude(args, prompt, 30000);
    const parsed = extractJsonObject(result.stdout);
    state.microResearch.bySymbol[symbol] = {
      ...parsed, symbol,
      researched_at: new Date().toISOString(),
      research_only: true,
      can_authorize_execution: false
    };
    state.microResearch.completed++;
  } catch (error) {
    state.microResearch.failed++;
    state.microResearch.bySymbol[symbol] = {
      symbol, background_verdict: "UNKNOWN",
      error: String(error.message || error),
      researched_at: new Date().toISOString(),
      research_only: true,
      can_authorize_execution: false
    };
  } finally {
    delete state.microResearch.running[symbol];
  }
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

  if (state.decisions.running) {
    if (signal?.strategy === "MICRO_V4") {
      state.decisions.pendingMicro = signal;
    } else {
      state.decisions.skipped++;
    }
    return;
  }

  if (!decisionCooldownAllows(signal)) {
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
    
        const gateResult = executionGate(
      signal,
      state.decisions.latest
    );

    state.execution.latestProposal = {
      symbol: signal.symbol,
      decision,
      confidence,
      max_position_dollars:
        gateResult.proposedMaxPositionDollars,
      approved: gateResult.approved,
      preview_allowed:
        gateResult.preview_allowed,
      submission_allowed:
        gateResult.submission_allowed,
      created_at: new Date().toISOString()
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

  if (
    signal.test_signal === true &&
    signal.strategy === "MICRO_V4"
  ) {
    try {
      const decision = "BUY_CANDIDATE";
      const confidence = 95;

      state.decisions.latest = {
        decision,
        confidence,
        symbol: signal.symbol,
        summary:
          "Deterministic synthetic Micro V4 validation.",
        positive_factors: [
          "Synthetic test satisfies Micro bridge inputs"
        ],
        risk_factors: [],
        missing_information: [],
        invalidation_conditions: [
          "Synthetic structural invalidation"
        ],
        market_context: {
          current_price: signal.price,
          bid: signal.price - 0.01,
          ask: signal.price,
          spread_pct: signal.spread_pct,
          trend: "synthetic",
          vwap_context: "above_vwap",
          technical_context: "synthetic_test"
        },
        account_context: {
          cash_available: 500,
          buying_power: 500,
          existing_position: false
        },
        research_performed: [
          "deterministic_synthetic_test"
        ],
        scanner_score: signal.score,
        scanner_lifecycle: signal.lifecycle,
        market_session: signal.market_session,
        robinhood_research_enabled: false,
        created_at: new Date().toISOString(),
        execution_enabled: false
      };

      const gateResult = executionGate(
        signal,
        state.decisions.latest
      );

      const currentPrice = Number(signal.price);
      const invalidation =
        Number(signal?.risk_model?.invalidation);

      let proposal = {
        strategy: "MICRO_V4",
        symbol: signal.symbol,
        synthetic_test: true,
        approved: gateResult.approved,
        blocks: gateResult.blocks,
        cautions: gateResult.cautions,
        proposed_quantity: null,
        proposed_limit_price: null,
        structural_invalidation:
          Number.isFinite(invalidation)
            ? invalidation
            : null,
        proposed_notional: null,
        proposed_risk_dollars: null,
        preview_allowed: false,
        submission_allowed: false,
        execution_enabled: false,
        robinhood_tools_used: false,
        created_at: new Date().toISOString()
      };

      if (
        gateResult.approved &&
        Number.isFinite(currentPrice) &&
        currentPrice > 0 &&
        Number.isFinite(invalidation) &&
        invalidation > 0 &&
        invalidation < currentPrice
      ) {
        const limitPrice =
          Math.ceil(currentPrice * 1.001 * 100) / 100;
        const riskPerShare =
          limitPrice - invalidation;
        const byNotional =
          Math.floor(100 / limitPrice);
        const byRisk =
          riskPerShare > 0
            ? Math.floor(3 / riskPerShare)
            : 0;
        const quantity =
          Math.max(
            0,
            Math.min(100, byNotional, byRisk)
          );

        if (quantity > 0) {
          proposal = {
            ...proposal,
            proposed_quantity: quantity,
            proposed_limit_price: limitPrice,
            proposed_notional:
              Math.round(quantity * limitPrice * 100) / 100,
            proposed_risk_dollars:
              Math.round(quantity * riskPerShare * 100) / 100
          };
        }
      }

      state.execution.latestProposal = proposal;
      state.decisions.completed++;
    } catch (error) {
      state.decisions.failed++;
      state.decisions.latest = {
        decision: "PASS",
        confidence: 0,
        symbol: signal.symbol,
        summary: "Synthetic Micro decision error.",
        error: String(error.message || error),
        execution_enabled: false,
        created_at: new Date().toISOString()
      };
    } finally {
      state.decisions.running = false;
    }
    return;
  }

  const cachedMicroResearch =
    signal.strategy === "MICRO_V4"
      ? getCachedMicroResearch(signal.symbol)
      : null;

  const enrichedSignal = cachedMicroResearch
    ? { ...signal, cached_micro_background_research: cachedMicroResearch }
    : signal;

  const prompt = `
Analyze this scanner signal using Robinhood READ-ONLY market
and account data where useful.

IMPORTANT:
THIS IS ANALYSIS ONLY.
DO NOT PLACE OR PREVIEW AN ORDER.
DO NOT CANCEL, MODIFY, REPLACE, OR EXERCISE ANY ORDER.
DO NOT TRANSFER FUNDS OR ASSETS.
DO NOT CHANGE THE ROBINHOOD ACCOUNT IN ANY WAY.

You may use available Robinhood READ-ONLY tools to investigate
the signal's symbol.

Where useful, inspect:

For a MICRO_V4 signal, first inspect the supplied
market_intelligence_snapshot. It is computed from the scanner's live Alpaca
SIP feed and should be treated as the primary high-speed tape/momentum
snapshot. Do not repeat research already present there unless Robinhood data
is needed to confirm a material discrepancy.

For a MICRO_V4 signal, prioritize these READ-ONLY checks before
returning BUY_CANDIDATE:
- current equity quote and spread
- equity Level 2 / price book
- equity tradability and any halt/session restriction
- current position in the symbol
- available cash or buying power
- recent price history / immediate momentum
- current catalyst or news context when an available read-only
  Robinhood tool can provide it

For MICRO_V4, treat Level 2 as confirmation rather than a complete
representation of all market liquidity. If required live information
is missing, stale, contradictory, or materially weaker than the
scanner snapshot, do not upgrade the signal to BUY_CANDIDATE.

- current equity quote
- recent price history
- technical indicators
- price book / bid-ask information
- tradability
- fundamentals
- financials
- analyst ratings
- earnings calendar
- recent earnings results
- SEC filing information
- portfolio/account information
- available cash or buying power
- current equity positions
- recent equity orders

Do not assume every tool is necessary.

If this is a synthetic TEST signal, do not attempt to research
the symbol through Robinhood. Evaluate only the supplied test data.

Your job is to independently determine whether this signal should
currently be classified as:

WATCH
PASS
BUY_CANDIDATE

A BUY_CANDIDATE means the setup deserves further consideration.
It DOES NOT authorize an order.

Consider:

- scanner score and lifecycle
- current market session
- spread and liquidity
- price versus VWAP
- momentum and trend
- recent volatility
- intraday price structure
- technical confirmation
- relevant fundamentals
- earnings or event risk
- tradability
- available account capital
- whether the move appears overextended
- whether evidence confirms or contradicts the scanner signal
- any important missing information

Be skeptical of stale, incomplete, or contradictory data.

Return ONLY valid JSON in this exact general structure:

{
  "decision": "WATCH|PASS|BUY_CANDIDATE",
  "confidence": 0,
  "symbol": "",
  "summary": "",
  "positive_factors": [],
  "risk_factors": [],
  "missing_information": [],
  "invalidation_conditions": [],
  "market_context": {
    "current_price": null,
    "bid": null,
    "ask": null,
    "spread_pct": null,
    "trend": "",
    "vwap_context": "",
    "technical_context": ""
  },
  "account_context": {
    "cash_available": null,
    "buying_power": null,
    "existing_position": false
  },
  "research_performed": []
}

Signal:

${JSON.stringify(enrichedSignal, null, 2)}
`;

  try {
    let args;

    if (signal.test_signal === true) {
      args = [
        "-p",
        "--disallowedTools",
        "mcp__robinhood-trading__*"
      ];
    } else {
      const allowedReadTools =
        signal.strategy === "MICRO_V4"
          ? MICRO_ROBINHOOD_READ_TOOLS
          : ROBINHOOD_READ_TOOLS;

      args = [
        "-p",
        "--allowedTools",
        ...allowedReadTools
      ];
    }

    const claudeTimeoutMs =
      signal.strategy === "MICRO_V4"
        ? 20000
        : 180000;

    const result = await runClaude(
      args,
      prompt,
      claudeTimeoutMs
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

    const confidence =
      Number.isFinite(Number(parsed.confidence))
        ? Math.max(
            0,
            Math.min(100, Number(parsed.confidence))
          )
        : 0;

    state.decisions.latest = {
      ...parsed,
      decision,
      confidence,
      symbol: signal.symbol,
      scanner_score: signal.score,
      scanner_lifecycle: signal.lifecycle,
      market_session: signal.market_session,
      robinhood_research_enabled:
        signal.test_signal !== true,
      created_at: new Date().toISOString(),
      execution_enabled: false
    };

    if (signal.strategy === "MICRO_V4") {
      const gateResult = executionGate(
        signal,
        state.decisions.latest
      );

      const currentPrice =
        Number(
          state.decisions.latest?.market_context?.current_price
        );

      const invalidation =
        Number(signal?.risk_model?.invalidation);

      let proposal = {
        strategy: "MICRO_V4",
        symbol: signal.symbol,
        approved: gateResult.approved,
        blocks: gateResult.blocks,
        cautions: gateResult.cautions,
        proposed_quantity: null,
        proposed_limit_price: null,
        structural_invalidation:
          Number.isFinite(invalidation)
            ? invalidation
            : null,
        proposed_notional: null,
        proposed_risk_dollars: null,
        preview_allowed: false,
        submission_allowed: false,
        execution_enabled: false,
        created_at: new Date().toISOString()
      };

      if (
        gateResult.approved &&
        Number.isFinite(currentPrice) &&
        currentPrice > 0 &&
        Number.isFinite(invalidation) &&
        invalidation > 0 &&
        invalidation < currentPrice
      ) {
        const limitPrice =
          Math.ceil(currentPrice * 1.001 * 100) / 100;

        const riskPerShare =
          limitPrice - invalidation;

        const byNotional =
          Math.floor(100 / limitPrice);

        const byRisk =
          riskPerShare > 0
            ? Math.floor(3 / riskPerShare)
            : 0;

        const quantity =
          Math.max(
            0,
            Math.min(
              100,
              byNotional,
              byRisk
            )
          );

        if (quantity > 0) {
          proposal = {
            ...proposal,
            proposed_quantity: quantity,
            proposed_limit_price: limitPrice,
            proposed_notional:
              Math.round(
                quantity * limitPrice * 100
              ) / 100,
            proposed_risk_dollars:
              Math.round(
                quantity *
                riskPerShare *
                100
              ) / 100
          };
        }
      }

      state.execution.latestProposal =
        proposal;
    }

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

    const pendingMicro =
      state.decisions.pendingMicro;
    state.decisions.pendingMicro = null;

    if (pendingMicro) {
      setImmediate(() => {
        runDryDecision(pendingMicro)
          .catch(console.error);
      });
    }
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

  if (signal.strategy === "MICRO_V4") {
    state.bridge.microV4.received++;
    state.bridge.microV4.lastReceivedAt =
      state.bridge.lastReceivedAt;
    state.bridge.microV4.latestSignal = signal;
  }

  if (
    signal.strategy === "MICRO_V4" &&
    signal.research_only === true
  ) {
    setImmediate(() => {
      preResearchMicro(signal).catch(console.error);
    });
    return signal;
  }

  setImmediate(() => {
    runDryDecision(signal).catch(console.error);
  });

  return signal;
}
function sendAdminTestSignal() {
  const now = new Date().toISOString();

  return acceptBridgeSignal({
    symbol: "TEST",
    price: 10.00,
    score: 7,
    market_session: "regular",
    lifecycle: "WATCH",
    scanner_generated_at: now,

    spread_pct: 0.25,
    vwap_distance_pct: 1.2,
    change_pct: 3.5,

    reasons: [
      "Administrative end-to-end test signal"
    ],

    risk_factors: [
      "Synthetic test data - not a real trading opportunity"
    ],

    warnings: [
      "TEST SIGNAL ONLY"
    ],

    test_signal: true
  });
}
function sendRobinhoodResearchTest() {
  const now = new Date().toISOString();

  return acceptBridgeSignal({
    strategy: "MICRO_V4",
    strategy_version: "4.0.0",

    symbol: "AAPL",
    price: 1,
    score: 9.5,

    market_session: "regular",
    lifecycle: "BUY_CANDIDATE",
    setup: "MICRO_V4_ROBINHOOD_READ_TEST",

    scanner_generated_at: now,

    spread_pct: 0.20,
    above_vwap: true,
    relative_minute_volume: 2.50,
    volume_acceleration: 1.60,

    risk_model: {
      invalidation: 0.995,
      structure_risk_pct: 0.50
    },

    reasons: [
      "Administrative Micro V4 Robinhood read-only validation"
    ],

    risk_factors: [
      "Synthetic scanner values; Robinhood live data must verify AAPL"
    ],

    warnings: [
      "READ-ONLY RESEARCH TEST",
      "NO ORDER PREVIEW OR EXECUTION"
    ],

    research_test: true,
    test_signal: false,
    execution_enabled: false
  });
}
// ============================================================
// CLAUDE / ROBINHOOD STATUS
// ============================================================

async function refreshClaudeSingleToolDiagnostics() {
  state.robinhood.singleToolDiagnosticsOutput =
    "Testing one read-only Robinhood tool permission...";

  const args = [
    "-p",
    "--allowedTools",
    "mcp__robinhood-trading__get_equity_quotes"
  ];

  const prompt = [
    "Do not call any tool.",
    "Reply with exactly: READ_ONLY_PERMISSION_TEST"
  ].join("\n");

  const result = await new Promise(resolve => {
    execFile(
      "claude",
      args,
      {
        timeout: 60000,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env
      },
      (error, stdout, stderr) => {
        resolve({
          args,
          exit_error:
            error ? String(error.message || error) : null,
          exit_code:
            error && Number.isInteger(error.code)
              ? error.code
              : 0,
          stdout: stdout || "",
          stderr: stderr || ""
        });
      }
    ).stdin.end(prompt);
  });

  state.robinhood.singleToolDiagnosticsOutput =
    JSON.stringify(result, null, 2);
}

async function refreshClaudeCliDiagnostics() {
  state.robinhood.cliDiagnosticsOutput =
    "Checking Claude CLI version/help...";

  const runRaw = args =>
    new Promise(resolve => {
      execFile(
        "claude",
        args,
        {
          timeout: 30000,
          maxBuffer: 2 * 1024 * 1024,
          env: process.env
        },
        (error, stdout, stderr) => {
          resolve({
            args,
            exit_error: error ? String(error.message || error) : null,
            stdout: stdout || "",
            stderr: stderr || ""
          });
        }
      );
    });

  const version = await runRaw(["--version"]);
  const help = await runRaw(["--help"]);

  state.robinhood.cliDiagnosticsOutput =
    JSON.stringify(
      { version, help },
      null,
      2
    );
}

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

  const latestMicroSignal = state.bridge.microV4.latestSignal
    ? JSON.stringify(state.bridge.microV4.latestSignal, null, 2)
    : "No Micro V4 signal received yet.";

  const latestMicroProposal =
    state.execution.latestProposal &&
    state.execution.latestProposal.strategy === "MICRO_V4"
      ? JSON.stringify(state.execution.latestProposal, null, 2)
      : "No Micro V4 execution proposal produced yet.";

  const microSignal = state.bridge.microV4.latestSignal;
  const microDecision =
    state.decisions.latest &&
    state.decisions.latest.symbol === microSignal?.symbol
      ? state.decisions.latest
      : null;
  const microProposal =
    state.execution.latestProposal &&
    state.execution.latestProposal.strategy === "MICRO_V4" &&
    state.execution.latestProposal.symbol === microSignal?.symbol
      ? state.execution.latestProposal
      : null;

  const extendedHoursMonitor = microSignal
    ? JSON.stringify(
        {
          mode:
            microSignal.market_session === "regular"
              ? "REGULAR SESSION"
              : "EXTENDED-HOURS RESEARCH ONLY",
          symbol: microSignal.symbol,
          strategy: microSignal.strategy,
          session: microSignal.market_session,
          scanner_score: microSignal.score,
          lifecycle: microSignal.lifecycle,
          scanner_price: microSignal.price,
          received_at: state.bridge.microV4.lastReceivedAt,
          robinhood_verdict: microDecision
            ? {
                decision: microDecision.decision,
                confidence: microDecision.confidence,
                summary: microDecision.summary,
                market_context: microDecision.market_context,
                risk_factors: microDecision.risk_factors,
                missing_information: microDecision.missing_information,
                research_performed: microDecision.research_performed
              }
            : null,
          locked_proposal: microProposal,
          live_trading_enabled: false,
          order_submission_enabled: false
        },
        null,
        2
      )
    : "No Micro V4 market candidate received yet.";

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

    <form
      method="post"
      action="/admin/claude-cli-diagnostics"
    >
      <button type="submit">
        Check Claude CLI Options
      </button>
    </form>

    <pre>${
      escapeHtml(
        state.robinhood.cliDiagnosticsOutput ||
        "CLI diagnostics have not been run."
      )
    }</pre>

    <form
      method="post"
      action="/admin/claude-single-tool-diagnostics"
    >
      <button type="submit">
        Test One Read-Only Tool Permission
      </button>
    </form>

    <pre>${
      escapeHtml(
        state.robinhood.singleToolDiagnosticsOutput ||
        "Single-tool diagnostics have not been run."
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
    <h2>Bridge Test</h2>

    <p>
      Sends one synthetic signal through the bridge and
      dry-run decision engine. No Robinhood order is submitted.
    </p>

    <form
      method="post"
      action="/admin/test-signal"
    >
      <button type="submit">
        Send Test Signal
      </button>
    </form>
  </div>
    <div class="card">
    <h2>Robinhood Research Test</h2>

    <p>
      Runs a real-symbol AAPL research test using authenticated
      Robinhood READ-ONLY tools. No order can be submitted.
    </p>

    <form
      method="post"
      action="/admin/robinhood-research-test"
    >
      <button type="submit">
        Run Robinhood Research Test
      </button>
    </form>
  </div>
  <div class="card">
    <h2>Extended-Hours Micro Monitor</h2>
    <p class="warning">
      Extended-hours candidates are research only.
      Execution remains restricted to the regular session,
      and live order submission is disabled.
    </p>
    <pre>${escapeHtml(extendedHoursMonitor)}</pre>
  </div>

  <div class="card">
    <h2>Micro V4 Status</h2>
    <p>
      Live trading: DISABLED<br>
      Order submission: DISABLED<br>
      Micro signals received:
      ${state.bridge.microV4.received}
    </p>
    <h3>Latest Micro Signal</h3>
    <pre>${escapeHtml(latestMicroSignal)}</pre>
    <h3>Latest Locked Execution Proposal</h3>
    <pre>${escapeHtml(latestMicroProposal)}</pre>
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
            state.bridge.latestRejection,
          micro_v4: {
            received:
              state.bridge.microV4.received,
            last_received_at:
              state.bridge.microV4.lastReceivedAt,
            latest_signal:
              state.bridge.microV4.latestSignal,
            latest_execution_proposal:
              state.execution.latestProposal &&
              state.execution.latestProposal.strategy === "MICRO_V4"
                ? state.execution.latestProposal
                : null,
            live_trading_enabled: false,
            order_submission_enabled: false
          }
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
      url.pathname === "/admin/claude-single-tool-diagnostics"
    ) {
      if (!isAdmin(req)) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }

      await refreshClaudeSingleToolDiagnostics();

      res.writeHead(303, { Location: "/admin" });
      return res.end();
    }

    if (
      req.method === "POST" &&
      url.pathname === "/admin/claude-cli-diagnostics"
    ) {
      if (!isAdmin(req)) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }

      await refreshClaudeCliDiagnostics();

      res.writeHead(303, { Location: "/admin" });
      return res.end();
    }

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
    // ROBINHOOD RESEARCH TEST
    // --------------------------------------------------------

    if (
      req.method === "POST" &&
      url.pathname === "/admin/robinhood-research-test"
    ) {
      if (!isAdmin(req)) {
        return sendJson(res, 401, {
          error: "Unauthorized"
        });
      }

      try {
        sendRobinhoodResearchTest();

        res.writeHead(303, {
          Location: "/admin"
        });

        return res.end();
      } catch (error) {
        return sendJson(res, 500, {
          error: String(error.message || error)
        });
      }
    }
        // --------------------------------------------------------
    // ADMIN TEST SIGNAL
    // --------------------------------------------------------

    if (
      req.method === "POST" &&
      url.pathname === "/admin/test-signal"
    ) {
      if (!isAdmin(req)) {
        return sendJson(res, 401, {
          error: "Unauthorized"
        });
      }

      try {
        sendAdminTestSignal();

        res.writeHead(303, {
          Location: "/admin"
        });

        return res.end();
      } catch (error) {
        return sendJson(res, 500, {
          error: String(error.message || error)
        });
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