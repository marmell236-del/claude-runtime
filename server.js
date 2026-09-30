const http = require("http");
const { spawn, execFile } = require("child_process");
const { URL } = require("url");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "";

const SCANNER_BRIDGE_TOKEN =
  process.env.SCANNER_BRIDGE_TOKEN || "";

if (!ADMIN_PASSWORD) {
  console.error(
    "FATAL: ADMIN_PASSWORD is not configured."
  );
  process.exit(1);
}

if (!SCANNER_BRIDGE_TOKEN) {
  console.error(
    "FATAL: SCANNER_BRIDGE_TOKEN is not configured."
  );
  process.exit(1);
}

const SESSION_TOKEN = crypto
  .createHmac("sha256", ADMIN_PASSWORD)
  .update(
    "claude-robinhood-admin-session-v1"
  )
  .digest("hex");


/*
 * ============================================================
 * SAFETY
 * ============================================================
 */

const BRIDGE_EXECUTION_ENABLED = false;

const DECISION_MODE_ENABLED = true;

/*
 * Same symbol normally gets analyzed no more than
 * once every 5 minutes.
 */
const DECISION_COOLDOWN_MS =
  5 * 60 * 1000;


/*
 * ============================================================
 * AUTHENTICATION STATE
 * ============================================================
 */

let loginProcess = null;

let loginOutput = "";

let authorizationUrl = "";

let loginState = "idle";

let loginError = "";


/*
 * ============================================================
 * BRIDGE STATE
 * ============================================================
 */

let bridgeState = {
  received_count: 0,

  last_received_at: null,

  last_signal: null,

  last_error: null,
};


/*
 * ============================================================
 * DECISION STATE
 * ============================================================
 */

let decisionState = {
  requested_count: 0,

  completed_count: 0,

  failed_count: 0,

  skipped_count: 0,

  running: false,

  last_started_at: null,

  last_completed_at: null,

  last_symbol: null,

  last_error: null,

  latest_decision: null,

  by_symbol: {},
};


/*
 * ============================================================
 * HELPERS
 * ============================================================
 */

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function html(body) {
  return `<!doctype html>

<html>
<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
Claude Robinhood Runtime
</title>

<style>

body {
  font-family:
    -apple-system,
    BlinkMacSystemFont,
    sans-serif;

  max-width: 800px;

  margin: 40px auto;

  padding: 0 20px;

  background: #111;

  color: #eee;
}

.box {
  background: #1c1c1e;

  padding: 20px;

  border-radius: 14px;

  margin: 18px 0;
}

button {
  font-size: 17px;

  padding: 12px 18px;

  border: 0;

  border-radius: 10px;

  cursor: pointer;
}

input {
  width: 100%;

  box-sizing: border-box;

  font-size: 16px;

  padding: 12px;

  margin: 10px 0;
}

a {
  color: #64a8ff;

  word-break: break-all;
}

pre {
  white-space: pre-wrap;

  word-break: break-word;

  font-size: 13px;
}

.good {
  color: #70d67b;
}

.error {
  color: #ff6961;
}

.warning {
  color: #f5c542;
}

</style>

</head>

<body>

<h1>
Claude ↔ Robinhood
</h1>

${body}

</body>

</html>`;
}


function parseCookies(req) {
  const cookies = {};

  const header =
    req.headers.cookie || "";

  header
    .split(";")
    .forEach(part => {
      const index =
        part.indexOf("=");

      if (index === -1) {
        return;
      }

      const key =
        part
          .slice(0, index)
          .trim();

      const value =
        part
          .slice(index + 1)
          .trim();

      if (key) {
        cookies[key] = value;
      }
    });

  return cookies;
}


function safeEqual(a, b) {
  const aBuffer =
    Buffer.from(String(a));

  const bBuffer =
    Buffer.from(String(b));

  if (
    aBuffer.length !==
    bBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    aBuffer,
    bBuffer
  );
}


function isAuthenticated(req) {
  const cookies =
    parseCookies(req);

  const supplied =
    cookies.admin_session || "";

  return safeEqual(
    supplied,
    SESSION_TOKEN
  );
}


function isBridgeAuthenticated(req) {
  const authorization =
    req.headers.authorization || "";

  const prefix =
    "Bearer ";

  if (
    !authorization.startsWith(
      prefix
    )
  ) {
    return false;
  }

  const supplied =
    authorization.slice(
      prefix.length
    );

  return safeEqual(
    supplied,
    SCANNER_BRIDGE_TOKEN
  );
}


function setSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",

    `admin_session=${SESSION_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`
  );
}


function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",

    "admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
  );
}


function redirect(
  res,
  location
) {
  res.writeHead(
    302,
    {
      Location: location,

      "Cache-Control":
        "no-store",
    }
  );

  res.end();
}


function requireAuth(
  req,
  res
) {
  if (
    isAuthenticated(req)
  ) {
    return true;
  }

  redirect(
    res,
    "/login"
  );

  return false;
}


function sendJson(
  res,
  status,
  payload
) {
  const body =
    JSON.stringify(
      payload,
      null,
      2
    );

  res.writeHead(
    status,
    {
      "Content-Type":
        "application/json",

      "Cache-Control":
        "no-store",

      "Content-Length":
        Buffer.byteLength(
          body
        ),
    }
  );

  res.end(body);
}


function normalizeClaudeOutput(
  text
) {
  return String(
    text || ""
  )
    .replace(
      /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
      ""
    )
    .replace(/\r/g, "");
}


/*
 * ============================================================
 * ROBINHOOD AUTH
 * ============================================================
 */

function extractAuthorizationUrl(
  text
) {
  const normalized =
    normalizeClaudeOutput(
      text
    )
      .replace(/\n/g, "");

  const matches =
    normalized.match(
      /https?:\/\/[^\s"'<>]+/g
    ) || [];

  for (
    const raw of matches
  ) {
    const candidate =
      raw.replace(
        /[),.;]+$/,
        ""
      );

    if (
      candidate.includes(
        "robinhood.com"
      ) &&
      (
        candidate.includes(
          "oauth"
        ) ||
        candidate.includes(
          "authorize"
        ) ||
        candidate.includes(
          "response_type=code"
        )
      )
    ) {
      return candidate;
    }
  }

  return "";
}


function inspectLoginOutput() {
  const normalized =
    normalizeClaudeOutput(
      loginOutput
    );

  const found =
    extractAuthorizationUrl(
      loginOutput
    );

  if (found) {
    authorizationUrl = found;
  }

  if (
    authorizationUrl ||
    normalized.includes(
      "Waiting for authorization"
    ) ||
    normalized.includes(
      "paste the redirect URL"
    )
  ) {
    loginState =
      "waiting_for_authorization";
  }
}


function startLogin() {
  if (loginProcess) {
    inspectLoginOutput();

    return;
  }

  loginOutput = "";

  authorizationUrl = "";

  loginError = "";

  loginState =
    "starting";

  const command =
    "claude mcp login robinhood-trading --no-browser";

  loginProcess =
    spawn(
      "script",

      [
        "-qfec",

        command,

        "/dev/null",
      ],

      {
        env: process.env,

        stdio: [
          "pipe",
          "pipe",
          "pipe",
        ],
      }
    );

  function consume(data) {
    const raw =
      data.toString();

    /*
     * Redact sensitive URLs before
     * storing or logging them.
     */
    const safeText =
      raw
        .replace(
          /https?:\/\/[^\s"'<>]+/gi,
          match => {
            if (
              match.includes(
                "robinhood.com"
              ) &&
              (
                match.includes(
                  "authorize"
                ) ||
                match.includes(
                  "oauth"
                )
              )
            ) {
              return match;
            }

            return "[URL REDACTED]";
          }
        )
        .replace(
          /([?&]code=)[^&\s]+/gi,
          "$1[REDACTED]"
        )
        .replace(
          /([?&]state=)[^&\s]+/gi,
          "$1[REDACTED]"
        );

    loginOutput +=
      safeText;

    if (
      loginOutput.length >
      100000
    ) {
      loginOutput =
        loginOutput.slice(
          -100000
        );
    }

    inspectLoginOutput();

    process.stdout.write(
      `[CLAUDE LOGIN] ${
        safeText
          .replace(
            /https?:\/\/[^\s"'<>]+/gi,
            "[URL REDACTED]"
          )
      }`
    );
  }

  loginProcess.stdout.on(
    "data",
    consume
  );

  loginProcess.stderr.on(
    "data",
    consume
  );

  loginProcess.on(
    "error",
    err => {
      loginError =
        err.message;

      loginState =
        "error";

      loginProcess =
        null;
    }
  );

  loginProcess.on(
    "close",
    code => {
      inspectLoginOutput();

      if (code === 0) {
        loginState =
          "completed";
      }

      else if (
        loginState !==
          "error" &&
        loginState !==
          "completed"
      ) {
        loginState =
          "failed";

        loginError =
          `Claude exited with code ${code}.`;
      }

      loginProcess =
        null;
    }
  );
}


function submitRedirect(
  redirectUrl
) {
  if (
    !loginProcess ||
    !loginProcess.stdin
  ) {
    return false;
  }

  loginState =
    "submitting_redirect";

  loginProcess.stdin.write(
    redirectUrl.trim() +
    "\n"
  );

  return true;
}


/*
 * ============================================================
 * MCP STATUS
 * ============================================================
 */

function checkMcp(
  callback
) {
  execFile(
    "claude",

    [
      "mcp",
      "get",
      "robinhood-trading",
    ],

    {
      env: process.env,

      timeout: 30000,
    },

    (
      error,
      stdout,
      stderr
    ) => {
      callback(
        error,

        `${
          stdout || ""
        }${
          stderr || ""
        }`
      );
    }
  );
}


/*
 * ============================================================
 * MANUAL READ-ONLY ROBINHOOD TEST
 * ============================================================
 */

function runReadOnlyTest(
  callback
) {
  const prompt = `
Use the connected robinhood-trading MCP server.

READ-ONLY TEST ONLY.

Retrieve basic information about the connected
Robinhood account and its current holdings or
positions.

Do not place any order.
Do not prepare or preview any order.
Do not modify any order.
Do not cancel any order.
Do not transfer funds.
Do not modify the account.
Do not perform any write action.

Return a concise plain-text summary showing:

1. Whether Robinhood account data was successfully retrieved.
2. Current holdings or positions, if available.
3. Cash or buying-power information, if available.

Do not return full account numbers or unnecessary identifiers.
`;

  execFile(
    "claude",

    [
      "-p",

      prompt,

      "--allowedTools",

      "mcp__robinhood-trading__*",
    ],

    {
      env: process.env,

      timeout: 60000,

      maxBuffer:
        1024 * 1024,
    },

    (
      error,
      stdout,
      stderr
    ) => {
      callback(
        error,

        `${
          stdout || ""
        }${
          stderr || ""
        }`
      );
    }
  );
}


/*
 * ============================================================
 * SIGNAL VALIDATION
 * ============================================================
 */

function acceptBridgeSignal(
  payload
) {
  if (
    !payload ||
    typeof payload !==
      "object" ||
    Array.isArray(
      payload
    )
  ) {
    throw new Error(
      "Payload must be a JSON object."
    );
  }

  const symbol =
    String(
      payload.symbol || ""
    )
      .trim()
      .toUpperCase();

  const price =
    Number(
      payload.price
    );

  const score =
    Number(
      payload.score
    );

  if (
    !/^[A-Z][A-Z0-9.-]{0,9}$/.test(
      symbol
    )
  ) {
    throw new Error(
      "Invalid symbol."
    );
  }

  if (
    !Number.isFinite(
      price
    ) ||
    price <= 0
  ) {
    throw new Error(
      "Invalid price."
    );
  }

  if (
    !Number.isFinite(
      score
    )
  ) {
    throw new Error(
      "Invalid score."
    );
  }

  const signal = {
    symbol,

    price,

    score,

    change_pct:
      payload.change_pct ??
      null,

    relative_volume:
      payload.relative_volume ??
      null,

    spread_pct:
      payload.spread_pct ??
      null,

    position_in_range:
      payload.position_in_range ??
      null,

    minute_volume:
      payload.minute_volume ??
      null,

    day_volume:
      payload.day_volume ??
      null,

    day_open:
      payload.day_open ??
      null,

    day_high:
      payload.day_high ??
      null,

    day_low:
      payload.day_low ??
      null,

    bid:
      payload.bid ??
      null,

    ask:
      payload.ask ??
      null,

    reasons:
      Array.isArray(
        payload.reasons
      )
        ? payload.reasons
            .slice(0, 20)
            .map(
              item =>
                String(item)
                  .slice(
                    0,
                    300
                  )
            )
        : [],

    scanner_generated_at:
      payload.generated_at ||
      null,

    bridge_received_at:
      new Date()
        .toISOString(),
  };

  bridgeState.received_count +=
    1;

  bridgeState.last_received_at =
    signal.bridge_received_at;

  bridgeState.last_signal =
    signal;

  bridgeState.last_error =
    null;

  console.log(
    `BRIDGE SIGNAL RECEIVED | ` +
    `${signal.symbol} | ` +
    `$${signal.price} | ` +
    `SCORE ${signal.score} | ` +
    `EXECUTION DISABLED`
  );

  return signal;
}


/*
 * ============================================================
 * DECISION ENGINE
 * ============================================================
 */

function shouldAnalyzeSignal(
  signal
) {
  if (
    !DECISION_MODE_ENABLED
  ) {
    return {
      run: false,
      reason:
        "decision mode disabled",
    };
  }

  if (
    decisionState.running
  ) {
    return {
      run: false,
      reason:
        "another decision is running",
    };
  }

  const prior =
    decisionState.by_symbol[
      signal.symbol
    ];

  if (!prior) {
    return {
      run: true,
      reason:
        "first signal for symbol",
    };
  }

  const elapsed =
    Date.now() -
    prior.timestamp;

  /*
   * Re-analyze immediately if the
   * scanner score improves materially.
   */
  if (
    Number(signal.score) >=
    Number(prior.score) + 2
  ) {
    return {
      run: true,
      reason:
        "score improved materially",
    };
  }

  if (
    elapsed >=
    DECISION_COOLDOWN_MS
  ) {
    return {
      run: true,
      reason:
        "cooldown expired",
    };
  }

  return {
    run: false,
    reason:
      "same-symbol cooldown active",
  };
}


function buildDecisionPrompt(
  signal
) {
  return `
You are evaluating a market-scanner signal.

THIS IS A DRY-RUN DECISION ONLY.

You must NOT use Robinhood.
You must NOT use any MCP tool.
You must NOT place, preview, prepare, modify, or cancel an order.
You must NOT perform any account action.

Evaluate only the scanner data supplied below.

The trading account is small, so avoid assuming that
a high-priced stock can be purchased as a full share.
Fractional-share support may exist, but you are not
being asked to create an order.

Signal:

${JSON.stringify(
  signal,
  null,
  2
)}

Return ONLY valid JSON.

Required structure:

{
  "decision": "BUY" or "PASS",
  "confidence": integer from 0 through 100,
  "symbol": "${signal.symbol}",
  "summary": "short explanation",
  "positive_factors": [
    "factor"
  ],
  "risk_factors": [
    "factor"
  ],
  "missing_information": [
    "important missing data"
  ]
}

Rules:

- BUY means only that the setup merits further review.
- BUY does NOT authorize an order.
- PASS means the setup does not currently merit further review.
- Do not invent data.
- Treat this scanner as incomplete.
- Consider spread, momentum, volume, range position,
  signal score, and data quality.
- Be skeptical of weak or stale signals.
- Keep the output concise.
`;
}


function extractJsonObject(
  text
) {
  const cleaned =
    normalizeClaudeOutput(
      text
    )
      .replace(
        /```json/gi,
        ""
      )
      .replace(
        /```/g,
        ""
      )
      .trim();

  try {
    return JSON.parse(
      cleaned
    );
  }

  catch (_) {
    const start =
      cleaned.indexOf("{");

    const end =
      cleaned.lastIndexOf("}");

    if (
      start !== -1 &&
      end !== -1 &&
      end > start
    ) {
      return JSON.parse(
        cleaned.slice(
          start,
          end + 1
        )
      );
    }

    throw new Error(
      "Claude did not return valid JSON."
    );
  }
}


function runSignalDecision(
  signal
) {
  const gate =
    shouldAnalyzeSignal(
      signal
    );

  if (!gate.run) {
    decisionState.skipped_count +=
      1;

    console.log(
      `DECISION SKIPPED | ` +
      `${signal.symbol} | ` +
      `${gate.reason}`
    );

    return;
  }

  decisionState.running =
    true;

  decisionState.requested_count +=
    1;

  decisionState.last_started_at =
    new Date()
      .toISOString();

  decisionState.last_symbol =
    signal.symbol;

  decisionState.last_error =
    null;

  decisionState.by_symbol[
    signal.symbol
  ] = {
    timestamp:
      Date.now(),

    score:
      signal.score,
  };

  const prompt =
    buildDecisionPrompt(
      signal
    );

  console.log(
    `DECISION STARTED | ` +
    `${signal.symbol} | ` +
    `SCORE ${signal.score} | ` +
    `NO ROBINHOOD TOOLS`
  );

  execFile(
    "claude",

    [
      "-p",

      prompt,

      /*
       * Automated signal analysis is
       * explicitly blocked from using
       * Robinhood MCP.
       */
      "--disallowedTools",

      "mcp__robinhood-trading__*",
    ],

    {
      env: process.env,

      timeout:
        90000,

      maxBuffer:
        1024 * 1024,
    },

    (
      error,
      stdout,
      stderr
    ) => {
      decisionState.running =
        false;

      if (error) {
        decisionState.failed_count +=
          1;

        decisionState.last_error =
          error.message;

        console.error(
          `DECISION ERROR | ` +
          `${signal.symbol} | ` +
          `${error.message}`
        );

        return;
      }

      try {
        const decision =
          extractJsonObject(
            `${stdout || ""}${stderr || ""}`
          );

        const allowed =
          [
            "BUY",
            "PASS",
          ];

        if (
          !allowed.includes(
            decision.decision
          )
        ) {
          throw new Error(
            "Invalid decision value."
          );
        }

        decisionState.completed_count +=
          1;

        decisionState.last_completed_at =
          new Date()
            .toISOString();

        decisionState.latest_decision = {
          ...decision,

          analyzed_signal: {
            symbol:
              signal.symbol,

            price:
              signal.price,

            score:
              signal.score,

            scanner_generated_at:
              signal
                .scanner_generated_at,
          },

          decided_at:
            decisionState
              .last_completed_at,

          execution_enabled:
            false,
        };

        decisionState.last_error =
          null;

        console.log(
          `DECISION COMPLETE | ` +
          `${signal.symbol} | ` +
          `${decision.decision} | ` +
          `CONFIDENCE ${
            decision.confidence
          } | ` +
          `EXECUTION DISABLED`
        );
      }

      catch (parseError) {
        decisionState.failed_count +=
          1;

        decisionState.last_error =
          parseError.message;

        console.error(
          `DECISION PARSE ERROR | ` +
          `${signal.symbol} | ` +
          `${parseError.message}`
        );
      }
    }
  );
}


/*
 * ============================================================
 * SERVER
 * ============================================================
 */

const server =
  http.createServer(
    (
      req,
      res
    ) => {
      const url =
        new URL(
          req.url,

          `http://${req.headers.host}`
        );


      /*
       * PUBLIC HEALTH
       */
      if (
        url.pathname ===
        "/health"
      ) {
        sendJson(
          res,
          200,
          {
            status:
              "ok",

            service:
              "claude-robinhood-runtime",
          }
        );

        return;
      }


      /*
       * SCANNER SIGNAL INPUT
       */
      if (
        url.pathname ===
          "/bridge/signal" &&
        req.method ===
          "POST"
      ) {
        if (
          !isBridgeAuthenticated(
            req
          )
        ) {
          sendJson(
            res,
            401,
            {
              ok: false,

              error:
                "unauthorized",
            }
          );

          return;
        }

        let body = "";

        req.on(
          "data",
          chunk => {
            body +=
              chunk.toString();

            if (
              body.length >
              50000
            ) {
              req.destroy();
            }
          }
        );

        req.on(
          "end",
          () => {
            try {
              const payload =
                JSON.parse(
                  body
                );

              const signal =
                acceptBridgeSignal(
                  payload
                );

              /*
               * Decision analysis is
               * asynchronous.
               */
              setImmediate(
                () => {
                  runSignalDecision(
                    signal
                  );
                }
              );

              sendJson(
                res,
                200,
                {
                  ok: true,

                  accepted:
                    true,

                  decision_mode_enabled:
                    DECISION_MODE_ENABLED,

                  execution_enabled:
                    BRIDGE_EXECUTION_ENABLED,

                  message:
                    "Signal received. Dry-run analysis queued. Trading execution is disabled.",

                  signal,
                }
              );
            }

            catch (error) {
              bridgeState.last_error =
                error.message;

              sendJson(
                res,
                400,
                {
                  ok: false,

                  error:
                    error.message,
                }
              );
            }
          }
        );

        return;
      }


      /*
       * LOGIN PAGE
       */
      if (
        url.pathname ===
          "/login" &&
        req.method ===
          "GET"
      ) {
        if (
          isAuthenticated(
            req
          )
        ) {
          redirect(
            res,
            "/"
          );

          return;
        }

        res.writeHead(
          200,
          {
            "Content-Type":
              "text/html",

            "Cache-Control":
              "no-store",
          }
        );

        res.end(
          html(`
            <div class="box">

              <h2>
                Administrator Login
              </h2>

              <form
                method="POST"
                action="/login"
              >

                <input
                  name="password"
                  type="password"
                  autocomplete="current-password"
                  placeholder="Admin password"
                  required
                >

                <button
                  type="submit"
                >
                  Sign In
                </button>

              </form>

            </div>
          `)
        );

        return;
      }


      /*
       * LOGIN SUBMISSION
       */
      if (
        url.pathname ===
          "/login" &&
        req.method ===
          "POST"
      ) {
        let body = "";

        req.on(
          "data",
          chunk => {
            body +=
              chunk.toString();

            if (
              body.length >
              10000
            ) {
              req.destroy();
            }
          }
        );

        req.on(
          "end",
          () => {
            const params =
              new URLSearchParams(
                body
              );

            const password =
              params.get(
                "password"
              ) || "";

            if (
              safeEqual(
                password,
                ADMIN_PASSWORD
              )
            ) {
              setSessionCookie(
                res
              );

              redirect(
                res,
                "/"
              );

              return;
            }

            res.writeHead(
              401,
              {
                "Content-Type":
                  "text/html",

                "Cache-Control":
                  "no-store",
              }
            );

            res.end(
              html(`
                <div class="box">

                  <h2>
                    Administrator Login
                  </h2>

                  <p class="error">
                    Incorrect password.
                  </p>

                  <form
                    method="POST"
                    action="/login"
                  >

                    <input
                      name="password"
                      type="password"
                      autocomplete="current-password"
                      placeholder="Admin password"
                      required
                    >

                    <button
                      type="submit"
                    >
                      Sign In
                    </button>

                  </form>

                </div>
              `)
            );
          }
        );

        return;
      }


      if (
        url.pathname ===
        "/logout"
      ) {
        clearSessionCookie(
          res
        );

        redirect(
          res,
          "/login"
        );

        return;
      }


      /*
       * EVERYTHING BELOW REQUIRES LOGIN
       */
      if (
        !requireAuth(
          req,
          res
        )
      ) {
        return;
      }


      /*
       * BRIDGE PAGE
       */
      if (
        url.pathname ===
        "/bridge"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "text/html",

            "Cache-Control":
              "no-store",
          }
        );

        res.end(
          html(`
            <div class="box">

              <h2>
                Scanner Bridge
              </h2>

              <p>
                <strong>
                  Execution:
                </strong>

                DISABLED
              </p>

              <p>
                <strong>
                  Signals received:
                </strong>

                ${
                  bridgeState
                    .received_count
                }
              </p>

              <p>
                <strong>
                  Last received:
                </strong>

                ${escapeHtml(
                  bridgeState
                    .last_received_at ||
                  "None"
                )}
              </p>

            </div>


            <div class="box">

              <h2>
                Latest Signal
              </h2>

              <pre>${escapeHtml(
                bridgeState.last_signal
                  ? JSON.stringify(
                      bridgeState
                        .last_signal,
                      null,
                      2
                    )
                  : "No signal received yet."
              )}</pre>

            </div>


            <div class="box">

              <a href="/decisions">
                <button>
                  Decision Engine
                </button>
              </a>

            </div>


            <div class="box">

              <a href="/">
                Home
              </a>

            </div>
          `)
        );

        return;
      }


      /*
       * DECISION PAGE
       */
      if (
        url.pathname ===
        "/decisions"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "text/html",

            "Cache-Control":
              "no-store",
          }
        );

        res.end(
          html(`
            <div class="box">

              <h2>
                Dry-Run Decision Engine
              </h2>

              <p>
                <strong>
                  Decision mode:
                </strong>

                ${
                  DECISION_MODE_ENABLED
                    ? "ENABLED"
                    : "DISABLED"
                }
              </p>

              <p>
                <strong>
                  Robinhood execution:
                </strong>

                DISABLED
              </p>

              <p>
                <strong>
                  Decision currently running:
                </strong>

                ${
                  decisionState.running
                    ? "YES"
                    : "NO"
                }
              </p>

              <p>
                Requested:
                ${
                  decisionState
                    .requested_count
                }
              </p>

              <p>
                Completed:
                ${
                  decisionState
                    .completed_count
                }
              </p>

              <p>
                Skipped by cooldown:
                ${
                  decisionState
                    .skipped_count
                }
              </p>

              <p>
                Failed:
                ${
                  decisionState
                    .failed_count
                }
              </p>

            </div>


            <div class="box">

              <h2>
                Latest Decision
              </h2>

              <pre>${escapeHtml(
                decisionState
                  .latest_decision
                  ? JSON.stringify(
                      decisionState
                        .latest_decision,
                      null,
                      2
                    )
                  : "No decision completed yet."
              )}</pre>

            </div>


            ${
              decisionState.last_error
                ? `
                  <div class="box">

                    <strong>
                      Last error:
                    </strong>

                    <pre>${escapeHtml(
                      decisionState
                        .last_error
                    )}</pre>

                  </div>
                `
                : ""
            }


            <div class="box">

              <a href="/bridge">
                Scanner Bridge
              </a>

            </div>


            <div class="box">

              <a href="/">
                Home
              </a>

            </div>
          `)
        );

        return;
      }


      /*
       * ROBINHOOD AUTH START
       */
      if (
        url.pathname ===
        "/auth/start"
      ) {
        startLogin();

        redirect(
          res,
          "/auth"
        );

        return;
      }


      /*
       * ROBINHOOD CALLBACK
       */
      if (
        url.pathname ===
          "/auth/submit" &&
        req.method ===
          "POST"
      ) {
        let body = "";

        req.on(
          "data",
          chunk => {
            body +=
              chunk.toString();

            if (
              body.length >
              20000
            ) {
              req.destroy();
            }
          }
        );

        req.on(
          "end",
          () => {
            const params =
              new URLSearchParams(
                body
              );

            const redirectUrl =
              params.get(
                "redirect_url"
              ) || "";

            if (
              !redirectUrl.startsWith(
                "http://localhost"
              ) &&
              !redirectUrl.startsWith(
                "http://127.0.0.1"
              ) &&
              !redirectUrl.startsWith(
                "https://localhost"
              )
            ) {
              res.writeHead(
                400,
                {
                  "Content-Type":
                    "text/html",

                  "Cache-Control":
                    "no-store",
                }
              );

              res.end(
                html(`
                  <div class="box">
                    Invalid redirect URL.
                  </div>

                  <a href="/auth">
                    Back
                  </a>
                `)
              );

              return;
            }

            const accepted =
              submitRedirect(
                redirectUrl
              );

            body = "";

            if (!accepted) {
              res.writeHead(
                409,
                {
                  "Content-Type":
                    "text/html",

                  "Cache-Control":
                    "no-store",
                }
              );

              res.end(
                html(`
                  <div class="box">

                    No active Claude
                    login process.

                  </div>

                  <a href="/auth/start">
                    Start again
                  </a>
                `)
              );

              return;
            }

            redirect(
              res,
              "/auth"
            );
          }
        );

        return;
      }


      /*
       * ROBINHOOD AUTH PAGE
       */
      if (
        url.pathname ===
        "/auth"
      ) {
        inspectLoginOutput();

        let authorizationBlock =
          "";

        if (
          authorizationUrl
        ) {
          authorizationBlock = `
            <div class="box">

              <h2>
                Step 1
              </h2>

              <p>
                Claude generated the
                Robinhood authorization
                request.
              </p>

              <p>

                <a
                  href="${escapeHtml(
                    authorizationUrl
                  )}"
                  target="_blank"
                  rel="noopener noreferrer"
                >

                  <button>
                    Open Robinhood Authorization
                  </button>

                </a>

              </p>

            </div>


            <div class="box">

              <h2>
                Step 2
              </h2>

              <p>
                Complete authorization
                with Robinhood.
              </p>

              <p>
                When Robinhood redirects
                your browser to localhost,
                copy the complete URL and
                paste it below.
              </p>

              <form
                method="POST"
                action="/auth/submit"
              >

                <input
                  name="redirect_url"
                  type="password"
                  autocomplete="off"
                  placeholder="localhost callback URL"
                  required
                >

                <button type="submit">
                  Complete Authentication
                </button>

              </form>

            </div>
          `;
        }

        let stateBlock =
          "";

        if (
          loginState ===
            "idle" ||
          loginState ===
            "failed" ||
          loginState ===
            "error"
        ) {
          stateBlock = `
            <div class="box">

              <a href="/auth/start">

                <button>

                  ${
                    loginState ===
                    "idle"
                      ? "Start Robinhood Login"
                      : "Retry Robinhood Login"
                  }

                </button>

              </a>

            </div>
          `;
        }

        if (
          loginState ===
            "starting" &&
          !authorizationUrl
        ) {
          stateBlock += `
            <div class="box">

              Claude is starting
              the Robinhood
              authentication flow.

            </div>
          `;
        }

        if (
          loginState ===
            "completed"
        ) {
          stateBlock += `
            <div class="box">

              <strong>
                Authentication completed.
              </strong>

            </div>
          `;
        }

        res.writeHead(
          200,
          {
            "Content-Type":
              "text/html",

            "Cache-Control":
              "no-store",
          }
        );

        res.end(
          html(`
            <div class="box">

              <strong>
                Status:
              </strong>

              ${escapeHtml(
                loginState
              )}

            </div>

            ${stateBlock}

            ${authorizationBlock}

            ${
              loginError
                ? `
                  <div class="box">

                    <strong>
                      Authentication Error:
                    </strong>

                    <pre>${escapeHtml(
                      loginError
                    )}</pre>

                  </div>
                `
                : ""
            }

            <div class="box">

              <a href="/status">
                Check MCP Status
              </a>

            </div>

            <div class="box">

              <a href="/">
                Home
              </a>

            </div>
          `)
        );

        return;
      }


      /*
       * READ-ONLY TEST PAGE
       */
      if (
        url.pathname ===
        "/test-read"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "text/html",

            "Cache-Control":
              "no-store",
          }
        );

        res.end(
          html(`
            <div class="box">

              <h2>
                Robinhood Read-Only Test
              </h2>

              <p>
                This manually retrieves
                basic account information.
              </p>

              <p>

                <a href="/test-read/run">

                  <button>
                    Run Read-Only Test
                  </button>

                </a>

              </p>

            </div>

            <div class="box">

              <a href="/">
                Back
              </a>

            </div>
          `)
        );

        return;
      }


      if (
        url.pathname ===
        "/test-read/run"
      ) {
        runReadOnlyTest(
          (
            error,
            output
          ) => {
            res.writeHead(
              200,
              {
                "Content-Type":
                  "text/html",

                "Cache-Control":
                  "no-store",
              }
            );

            res.end(
              html(`
                <div class="box">

                  <h2>
                    Robinhood Read-Only
                    Test Result
                  </h2>

                  <pre>${escapeHtml(
                    output
                  )}</pre>

                  ${
                    error
                      ? `
                        <p class="error">
                          ${escapeHtml(
                            error.message
                          )}
                        </p>
                      `
                      : ""
                  }

                </div>

                <div class="box">

                  <a href="/">
                    Home
                  </a>

                </div>
              `)
            );
          }
        );

        return;
      }


      /*
       * MCP STATUS PAGE
       */
      if (
        url.pathname ===
        "/status"
      ) {
        checkMcp(
          (
            error,
            output
          ) => {
            res.writeHead(
              200,
              {
                "Content-Type":
                  "text/html",

                "Cache-Control":
                  "no-store",
              }
            );

            res.end(
              html(`
                <div class="box">

                  <h2>
                    Robinhood MCP Status
                  </h2>

                  <pre>${escapeHtml(
                    output
                  )}</pre>

                  ${
                    error
                      ? `
                        <p class="error">
                          Status command returned
                          an error.
                        </p>
                      `
                      : ""
                  }

                </div>

                <div class="box">

                  <a href="/">
                    Home
                  </a>

                </div>
              `)
            );
          }
        );

        return;
      }


      /*
       * HOME
       */
      if (
        url.pathname ===
        "/"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "text/html",

            "Cache-Control":
              "no-store",
          }
        );

        res.end(
          html(`
            <div class="box">

              <p>
                Claude Code Robinhood MCP
                runtime is online.
              </p>

              <p>

                <a href="/status">

                  <button>
                    MCP Status
                  </button>

                </a>

              </p>

              <p>

                <a href="/test-read">

                  <button>
                    Run Read-Only
                    Robinhood Test
                  </button>

                </a>

              </p>

              <p>

                <a href="/bridge">

                  <button>
                    Scanner Bridge
                  </button>

                </a>

              </p>

              <p>

                <a href="/decisions">

                  <button>
                    Decision Engine
                  </button>

                </a>

              </p>

              <p>

                <a href="/auth">
                  Robinhood Authentication
                </a>

              </p>

            </div>


            <div class="box">

              <strong>
                Automated trade execution:
              </strong>

              DISABLED

            </div>


            <div class="box">

              <strong>
                Automated Robinhood access
                from decision engine:
              </strong>

              BLOCKED

            </div>


            <div class="box">

              <a href="/logout">
                Sign Out
              </a>

            </div>
          `)
        );

        return;
      }


      res.writeHead(
        404,
        {
          "Content-Type":
            "text/html",

          "Cache-Control":
            "no-store",
        }
      );

      res.end(
        html(`
          <div class="box">
            Page not found.
          </div>

          <a href="/">
            Home
          </a>
        `)
      );
    }
  );


server.listen(
  PORT,

  "0.0.0.0",

  () => {
    console.log(
      `Claude Robinhood runtime listening on port ${PORT}`
    );

    console.log(
      "Scanner bridge ready."
    );

    console.log(
      "Dry-run decision engine enabled."
    );

    console.log(
      "Automated Robinhood tool access blocked."
    );

    console.log(
      "Trade execution disabled."
    );
  }
);