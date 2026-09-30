const http = require("http");
const { spawn, execFile } = require("child_process");
const { URL } = require("url");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SCANNER_BRIDGE_TOKEN =
  process.env.SCANNER_BRIDGE_TOKEN || "";

if (!ADMIN_PASSWORD) {
  console.error("FATAL: ADMIN_PASSWORD is not configured.");
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
  .update("claude-robinhood-admin-session-v1")
  .digest("hex");

/*
 * IMPORTANT:
 * Scanner-to-Robinhood execution is intentionally disabled.
 */
const BRIDGE_EXECUTION_ENABLED = false;

let loginProcess = null;
let loginOutput = "";
let authorizationUrl = "";
let loginState = "idle";
let loginError = "";

/*
 * Latest signal received from the Alpaca scanner.
 * This is intentionally memory-only for this first test.
 */
let bridgeState = {
  received_count: 0,
  last_received_at: null,
  last_signal: null,
  last_error: null,
};

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
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Claude Robinhood Runtime</title>

  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      max-width: 760px;
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

    .error {
      color: #ff6961;
    }

    .good {
      color: #70d67b;
    }
  </style>
</head>

<body>
  <h1>Claude ↔ Robinhood</h1>
  ${body}
</body>
</html>`;
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || "";

  header.split(";").forEach(part => {
    const index = part.indexOf("=");

    if (index === -1) {
      return;
    }

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (key) {
      cookies[key] = value;
    }
  });

  return cookies;
}

function safeEqual(a, b) {
  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    aBuffer,
    bBuffer
  );
}

function isAuthenticated(req) {
  const cookies = parseCookies(req);
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

  const prefix = "Bearer ";

  if (!authorization.startsWith(prefix)) {
    return false;
  }

  const supplied =
    authorization.slice(prefix.length);

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

function redirect(res, location) {
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store"
  });

  res.end();
}

function requireAuth(req, res) {
  if (isAuthenticated(req)) {
    return true;
  }

  redirect(res, "/login");
  return false;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(
    payload,
    null,
    2
  );

  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Length":
      Buffer.byteLength(body)
  });

  res.end(body);
}

function normalizeClaudeOutput(text) {
  return String(text || "")
    .replace(
      /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
      ""
    )
    .replace(/\r/g, "")
    .replace(/\n/g, "");
}

function extractAuthorizationUrl(text) {
  const normalized =
    normalizeClaudeOutput(text);

  const matches =
    normalized.match(
      /https?:\/\/[^\s"'<>]+/g
    ) || [];

  for (const raw of matches) {
    const candidate =
      raw.replace(/[),.;]+$/, "");

    if (
      candidate.includes("robinhood.com") &&
      (
        candidate.includes("oauth") ||
        candidate.includes("authorize") ||
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
    normalizeClaudeOutput(loginOutput);

  const found =
    extractAuthorizationUrl(loginOutput);

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
  loginState = "starting";

  const command =
    "claude mcp login robinhood-trading --no-browser";

  loginProcess = spawn(
    "script",
    [
      "-qfec",
      command,
      "/dev/null"
    ],
    {
      env: process.env,
      stdio: [
        "pipe",
        "pipe",
        "pipe"
      ]
    }
  );

  function consume(data) {
    const text = data.toString();

    loginOutput += text;

    if (loginOutput.length > 100000) {
      loginOutput =
        loginOutput.slice(-100000);
    }

    inspectLoginOutput();

    const safeText = text
      .replace(
        /https?:\/\/[^\s"'<>]+/gi,
        "[URL REDACTED]"
      )
      .replace(
        /([?&]code=)[^&\s]+/gi,
        "$1[REDACTED]"
      )
      .replace(
        /([?&]state=)[^&\s]+/gi,
        "$1[REDACTED]"
      );

    process.stdout.write(
      `[CLAUDE LOGIN] ${safeText}`
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
      loginError = err.message;
      loginState = "error";
      loginProcess = null;
    }
  );

  loginProcess.on(
    "close",
    code => {
      inspectLoginOutput();

      if (code === 0) {
        loginState = "completed";
      } else if (
        loginState !== "error" &&
        loginState !== "completed"
      ) {
        loginState = "failed";
        loginError =
          `Claude exited with code ${code}.`;
      }

      loginProcess = null;
    }
  );
}

function submitRedirect(redirectUrl) {
  if (
    !loginProcess ||
    !loginProcess.stdin
  ) {
    return false;
  }

  loginState =
    "submitting_redirect";

  loginProcess.stdin.write(
    redirectUrl.trim() + "\n"
  );

  return true;
}

function checkMcp(callback) {
  execFile(
    "claude",
    [
      "mcp",
      "get",
      "robinhood-trading"
    ],
    {
      env: process.env,
      timeout: 30000
    },
    (
      error,
      stdout,
      stderr
    ) => {
      callback(
        error,
        `${stdout || ""}${stderr || ""}`
      );
    }
  );
}

function runReadOnlyTest(callback) {
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

Do not return full account numbers or other
unnecessary identifiers.

If a requested field is unavailable through the
connected read-only tools, say that it is
unavailable.
`;

  execFile(
    "claude",
    [
      "-p",
      prompt,
      "--allowedTools",
      "mcp__robinhood-trading__*"
    ],
    {
      env: process.env,
      timeout: 60000,
      maxBuffer: 1024 * 1024
    },
    (
      error,
      stdout,
      stderr
    ) => {
      callback(
        error,
        `${stdout || ""}${stderr || ""}`
      );
    }
  );
}

/*
 * Validate and store a scanner signal.
 *
 * NO Claude call occurs here.
 * NO Robinhood tool occurs here.
 * NO order can be submitted here.
 */
function acceptBridgeSignal(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error(
      "Payload must be a JSON object."
    );
  }

  const symbol =
    String(payload.symbol || "")
      .trim()
      .toUpperCase();

  const price =
    Number(payload.price);

  const score =
    Number(payload.score);

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
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      "Invalid price."
    );
  }

  if (
    !Number.isFinite(score)
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
      payload.change_pct ?? null,

    relative_volume:
      payload.relative_volume ?? null,

    spread_pct:
      payload.spread_pct ?? null,

    position_in_range:
      payload.position_in_range ?? null,

    bid:
      payload.bid ?? null,

    ask:
      payload.ask ?? null,

    reasons:
      Array.isArray(payload.reasons)
        ? payload.reasons
            .slice(0, 20)
            .map(item =>
              String(item).slice(0, 300)
            )
        : [],

    scanner_generated_at:
      payload.generated_at || null,

    bridge_received_at:
      new Date().toISOString()
  };

  bridgeState.received_count += 1;
  bridgeState.last_received_at =
    signal.bridge_received_at;
  bridgeState.last_signal = signal;
  bridgeState.last_error = null;

  console.log(
    `BRIDGE SIGNAL RECEIVED | ` +
    `${signal.symbol} | ` +
    `$${signal.price} | ` +
    `SCORE ${signal.score} | ` +
    `EXECUTION DISABLED`,
    { flush: true }
  );

  return signal;
}

const server =
  http.createServer((req, res) => {
    const url = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    /*
     * PUBLIC GENERIC HEALTH CHECK
     */
    if (url.pathname === "/health") {
      sendJson(
        res,
        200,
        {
          status: "ok",
          service:
            "claude-robinhood-runtime"
        }
      );

      return;
    }

    /*
     * SCANNER -> ROBINHOOD BRIDGE
     *
     * Separate Bearer token authentication.
     * This route does NOT use the browser
     * administrator session.
     */
    if (
      url.pathname === "/bridge/signal" &&
      req.method === "POST"
    ) {
      if (!isBridgeAuthenticated(req)) {
        sendJson(
          res,
          401,
          {
            ok: false,
            error: "unauthorized"
          }
        );

        return;
      }

      let body = "";

      req.on("data", chunk => {
        body += chunk.toString();

        if (body.length > 50000) {
          req.destroy();
        }
      });

      req.on("end", () => {
        try {
          const payload =
            JSON.parse(body);

          const signal =
            acceptBridgeSignal(
              payload
            );

          sendJson(
            res,
            200,
            {
              ok: true,
              accepted: true,
              execution_enabled:
                BRIDGE_EXECUTION_ENABLED,
              message:
                "Signal received. Trading execution is disabled.",
              signal
            }
          );
        } catch (error) {
          bridgeState.last_error =
            error.message;

          sendJson(
            res,
            400,
            {
              ok: false,
              error:
                error.message
            }
          );
        }
      });

      return;
    }

    /*
     * ADMIN LOGIN PAGE
     */
    if (
      url.pathname === "/login" &&
      req.method === "GET"
    ) {
      if (isAuthenticated(req)) {
        redirect(res, "/");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store"
      });

      res.end(
        html(`
          <div class="box">
            <h2>Administrator Login</h2>

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

              <button type="submit">
                Sign In
              </button>
            </form>
          </div>
        `)
      );

      return;
    }

    /*
     * ADMIN LOGIN SUBMISSION
     */
    if (
      url.pathname === "/login" &&
      req.method === "POST"
    ) {
      let body = "";

      req.on("data", chunk => {
        body += chunk.toString();

        if (body.length > 10000) {
          req.destroy();
        }
      });

      req.on("end", () => {
        const params =
          new URLSearchParams(body);

        const password =
          params.get("password") || "";

        if (
          safeEqual(
            password,
            ADMIN_PASSWORD
          )
        ) {
          setSessionCookie(res);
          redirect(res, "/");
          return;
        }

        res.writeHead(401, {
          "Content-Type": "text/html",
          "Cache-Control": "no-store"
        });

        res.end(
          html(`
            <div class="box">
              <h2>Administrator Login</h2>

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

                <button type="submit">
                  Sign In
                </button>
              </form>
            </div>
          `)
        );
      });

      return;
    }

    if (url.pathname === "/logout") {
      clearSessionCookie(res);
      redirect(res, "/login");
      return;
    }

    /*
     * EVERYTHING BELOW HERE REQUIRES
     * ADMINISTRATOR LOGIN.
     */
    if (!requireAuth(req, res)) {
      return;
    }

    /*
     * ADMIN BRIDGE STATUS
     */
    if (url.pathname === "/bridge") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store"
      });

      res.end(
        html(`
          <div class="box">
            <h2>Scanner Bridge</h2>

            <p>
              <strong>Execution:</strong>
              DISABLED
            </p>

            <p>
              <strong>
                Signals received:
              </strong>
              ${bridgeState.received_count}
            </p>

            <p>
              <strong>
                Last received:
              </strong>
              ${escapeHtml(
                bridgeState.last_received_at ||
                "None"
              )}
            </p>
          </div>

          <div class="box">
            <h2>Latest Signal</h2>

            <pre>${escapeHtml(
              bridgeState.last_signal
                ? JSON.stringify(
                    bridgeState.last_signal,
                    null,
                    2
                  )
                : "No signal received yet."
            )}</pre>
          </div>

          ${
            bridgeState.last_error
              ? `
                <div class="box">
                  <strong>
                    Last bridge error:
                  </strong>

                  <pre>${escapeHtml(
                    bridgeState.last_error
                  )}</pre>
                </div>
              `
              : ""
          }

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
     * START ROBINHOOD AUTHENTICATION
     */
    if (url.pathname === "/auth/start") {
      startLogin();
      redirect(res, "/auth");
      return;
    }

    /*
     * ROBINHOOD OAUTH CALLBACK
     */
    if (
      url.pathname ===
        "/auth/submit" &&
      req.method === "POST"
    ) {
      let body = "";

      req.on("data", chunk => {
        body += chunk.toString();

        if (body.length > 20000) {
          req.destroy();
        }
      });

      req.on("end", () => {
        const params =
          new URLSearchParams(body);

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
          res.writeHead(400, {
            "Content-Type":
              "text/html",
            "Cache-Control":
              "no-store"
          });

          res.end(
            html(`
              <div class="box">
                <strong>
                  Invalid redirect URL.
                </strong>
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
          res.writeHead(409, {
            "Content-Type":
              "text/html",
            "Cache-Control":
              "no-store"
          });

          res.end(
            html(`
              <div class="box">
                No active Claude login
                process.
              </div>

              <a href="/auth/start">
                Start again
              </a>
            `)
          );

          return;
        }

        redirect(res, "/auth");
      });

      return;
    }

    if (url.pathname === "/auth") {
      inspectLoginOutput();

      let authorizationBlock = "";

      if (authorizationUrl) {
        authorizationBlock = `
          <div class="box">
            <h2>Step 1</h2>

            <p>
              Claude generated the Robinhood
              authorization request.
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
            <h2>Step 2</h2>

            <p>
              Complete authorization with
              Robinhood.
            </p>

            <p>
              When Robinhood redirects your
              browser to localhost, copy the
              complete URL and paste it below.
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

      let stateBlock = "";

      if (
        loginState === "idle" ||
        loginState === "failed" ||
        loginState === "error"
      ) {
        stateBlock = `
          <div class="box">
            <a href="/auth/start">
              <button>
                ${
                  loginState === "idle"
                    ? "Start Robinhood Login"
                    : "Retry Robinhood Login"
                }
              </button>
            </a>
          </div>
        `;
      }

      if (
        loginState === "starting" &&
        !authorizationUrl
      ) {
        stateBlock += `
          <div class="box">
            Claude is starting the Robinhood
            authentication flow.
          </div>
        `;
      }

      if (
        loginState ===
          "waiting_for_authorization" &&
        !authorizationUrl
      ) {
        stateBlock += `
          <div class="box">
            Claude is waiting for
            authorization.
          </div>
        `;
      }

      if (
        loginState ===
        "submitting_redirect"
      ) {
        stateBlock += `
          <div class="box">
            Redirect submitted to Claude.
          </div>
        `;
      }

      if (
        loginState === "completed"
      ) {
        stateBlock += `
          <div class="box">
            <strong>
              Authentication completed.
            </strong>
          </div>
        `;
      }

      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store"
      });

      res.end(
        html(`
          <div class="box">
            <strong>Status:</strong>
            ${escapeHtml(loginState)}
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

    if (url.pathname === "/test-read") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store"
      });

      res.end(
        html(`
          <div class="box">
            <h2>
              Robinhood Read-Only Test
            </h2>

            <p>
              This retrieves basic Robinhood
              account information using
              read-only instructions.
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
        (error, output) => {
          res.writeHead(200, {
            "Content-Type":
              "text/html",
            "Cache-Control":
              "no-store"
          });

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

    if (url.pathname === "/status") {
      checkMcp(
        (error, output) => {
          res.writeHead(200, {
            "Content-Type":
              "text/html",
            "Cache-Control":
              "no-store"
          });

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

    if (url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store"
      });

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
              <a href="/auth">
                Robinhood Authentication
              </a>
            </p>
          </div>

          <div class="box">
            <strong>
              Trade execution:
            </strong>
            DISABLED
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

    res.writeHead(404, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store"
    });

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
  });

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Claude Robinhood runtime listening on port ${PORT}`
    );

    console.log(
      "Scanner bridge ready. Trade execution disabled."
    );
  }
);