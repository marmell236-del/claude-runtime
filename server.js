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
      )