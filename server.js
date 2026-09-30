const http = require("http");
const { spawn, execFile } = require("child_process");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;

let loginProcess = null;
let loginOutput = "";
let authorizationUrl = "";
let loginState = "idle";
let loginError = "";

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
  </style>
</head>

<body>
  <h1>Claude ↔ Robinhood</h1>
  ${body}
</body>
</html>`;
}

/*
 * Claude's PTY output may contain ANSI escape codes and may wrap
 * long URLs across multiple chunks/lines. Normalize that output
 * before trying to find the OAuth URL.
 */
function normalizeClaudeOutput(text) {
  return String(text || "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "")
    .replace(/\n/g, "");
}

function extractAuthorizationUrl(text) {
  const normalized = normalizeClaudeOutput(text);

  const matches =
    normalized.match(/https?:\/\/[^\s"'<>]+/g) || [];

  for (const raw of matches) {
    const candidate = raw.replace(/[),.;]+$/, "");

    if (
      candidate.includes("robinhood.com") &&
      (
        candidate.includes("oauth") ||
        candidate.includes("authorize") ||
        candidate.includes("response_type=code")
      )
    ) {
      return candidate;
    }
  }

  return "";
}

function inspectLoginOutput() {
  const normalized = normalizeClaudeOutput(loginOutput);

  const found = extractAuthorizationUrl(loginOutput);

  if (found) {
    authorizationUrl = found;
  }

  if (
    authorizationUrl ||
    normalized.includes("Waiting for authorization") ||
    normalized.includes("paste the redirect URL")
  ) {
    loginState = "waiting_for_authorization";
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
    ["-qfec", command, "/dev/null"],
    {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  function consume(data) {
    const text = data.toString();

    loginOutput += text;

    if (loginOutput.length > 100000) {
      loginOutput = loginOutput.slice(-100000);
    }

    inspectLoginOutput();

    const safeText = text
      .replace(/([?&]code=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/([?&]state=)[^&\s]+/gi, "$1[REDACTED]");

    process.stdout.write(`[CLAUDE LOGIN] ${safeText}`);
  }

  loginProcess.stdout.on("data", consume);
  loginProcess.stderr.on("data", consume);

  loginProcess.on("error", err => {
    loginError = err.message;
    loginState = "error";
    loginProcess = null;
  });

  loginProcess.on("close", code => {
    inspectLoginOutput();

    if (code === 0) {
      loginState = "completed";
    } else if (
      loginState !== "error" &&
      loginState !== "completed"
    ) {
      loginState = "failed";
      loginError =
        `Claude exited with code ${code}.\n\n` +
        normalizeClaudeOutput(loginOutput);
    }

    loginProcess = null;
  });
}

function submitRedirect(redirectUrl) {
  if (!loginProcess || !loginProcess.stdin) {
    return false;
  }

  loginState = "submitting_redirect";

  loginProcess.stdin.write(
    redirectUrl.trim() + "\n"
  );

  return true;
}

function checkMcp(callback) {
  execFile(
    "claude",
    ["mcp", "get", "robinhood-trading"],
    { env: process.env },
    (error, stdout, stderr) => {
      callback(
        error,
        `${stdout || ""}${stderr || ""}`
      );
    }
  );
}

/*
 * READ-ONLY ROBINHOOD TEST
 *
 * This deliberately instructs Claude to retrieve information only.
 * It must not place, modify, prepare, or cancel orders or perform
 * other account-changing actions.
 */
function runReadOnlyTest(callback) {
  const prompt = `
Use the connected robinhood-trading MCP server.

READ-ONLY TEST ONLY.

Retrieve basic information about the connected Robinhood account and its current holdings or positions.

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

If a requested field is unavailable through the connected read-only tools, say that it is unavailable.
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
    (error, stdout, stderr) => {
      callback(
        error,
        `${stdout || ""}${stderr || ""}`
      );
    }
  );
}

const server = http.createServer((req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  /*
   * HEALTH
   */
  if (url.pathname === "/health") {
    inspectLoginOutput();

    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(
      JSON.stringify({
        status: "ok",
        service: "claude-robinhood-runtime",
        login_state: loginState,
        login_process_active: Boolean(loginProcess),
        authorization_url_detected:
          Boolean(authorizationUrl)
      })
    );

    return;
  }

  /*
   * START ROBINHOOD AUTHENTICATION
   */
  if (url.pathname === "/auth/start") {
    startLogin();

    res.writeHead(302, {
      Location: "/auth"
    });

    res.end();
    return;
  }

  /*
   * SUBMIT ROBINHOOD LOCALHOST REDIRECT
   */
  if (
    url.pathname === "/auth/submit" &&
    req.method === "POST"
  ) {
    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();
    });

    req.on("end", () => {
      const params = new URLSearchParams(body);

      const redirectUrl =
        params.get("redirect_url") || "";

      if (
        !redirectUrl.startsWith("http://localhost") &&
        !redirectUrl.startsWith("http://127.0.0.1") &&
        !redirectUrl.startsWith("https://localhost")
      ) {
        res.writeHead(400, {
          "Content-Type": "text/html"
        });

        res.end(
          html(`
            <div class="box">
              <strong>Invalid redirect URL.</strong>

              <p>
                Paste the complete localhost URL that Robinhood
                redirected your browser to.
              </p>
            </div>

            <a href="/auth">
              Back
            </a>
          `)
        );

        return;
      }

      const accepted =
        submitRedirect(redirectUrl);

      if (!accepted) {
        res.writeHead(409, {
          "Content-Type": "text/html"
        });

        res.end(
          html(`
            <div class="box">
              No active Claude login process.
            </div>

            <a href="/auth/start">
              Start again
            </a>
          `)
        );

        return;
      }

      res.writeHead(302, {
        Location: "/auth"
      });

      res.end();
    });

    return;
  }

  /*
   * ROBINHOOD AUTHENTICATION PAGE
   */
  if (url.pathname === "/auth") {
    inspectLoginOutput();

    let authorizationBlock = "";

    if (authorizationUrl) {
      authorizationBlock = `
        <div class="box">
          <h2>Step 1</h2>

          <p>
            Claude generated the Robinhood authorization URL.
          </p>

          <p>
            <a
              href="${escapeHtml(authorizationUrl)}"
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
            Complete authorization with Robinhood.
          </p>

          <p>
            When Robinhood redirects your browser to localhost,
            copy the <strong>complete URL</strong> from the
            browser address bar.
          </p>

          <p>
            Paste that URL below.
          </p>

          <form
            method="POST"
            action="/auth/submit"
          >
            <input
              name="redirect_url"
              type="text"
              autocomplete="off"
              placeholder="http://localhost:.../?code=..."
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
          Claude is starting the Robinhood authentication flow.

          <p>
            Refresh this page in a few seconds.
          </p>
        </div>
      `;
    }

    if (
      loginState === "waiting_for_authorization" &&
      !authorizationUrl
    ) {
      stateBlock += `
        <div class="box">
          Claude is waiting for authorization, but the web
          interface has not yet reconstructed the authorization
          URL.
        </div>
      `;
    }

    if (loginState === "submitting_redirect") {
      stateBlock += `
        <div class="box">
          Redirect submitted to Claude.

          <p>
            Refresh this page in a few seconds.
          </p>
        </div>
      `;
    }

    if (loginState === "completed") {
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
                  Diagnostic Error:
                </strong>

                <pre>${escapeHtml(loginError)}</pre>
              </div>
            `
            : ""
        }

        <div class="box">
          <a href="/status">
            Check MCP Status
          </a>
        </div>
      `)
    );

    return;
  }

  /*
   * READ-ONLY TEST LANDING PAGE
   */
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
            This will ask Claude to retrieve basic account,
            holdings, and buying-power information through the
            connected Robinhood MCP server.
          </p>

          <p>
            This test explicitly prohibits placing, preparing,
            modifying, or cancelling orders and prohibits other
            account-changing actions.
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

  /*
   * EXECUTE READ-ONLY TEST
   */
  if (url.pathname === "/test-read/run") {
    runReadOnlyTest((error, output) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store"
      });

      res.end(
        html(`
          <div class="box">
            <h2>
              Robinhood Read-Only Test Result
            </h2>

            <pre>${escapeHtml(output)}</pre>

            ${
              error
                ? `
                  <p>
                    <strong>
                      Process error:
                    </strong>

                    ${escapeHtml(error.message)}
                  </p>
                `
                : ""
            }
          </div>

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
    });

    return;
  }

  /*
   * MCP STATUS
   */
  if (url.pathname === "/status") {
    checkMcp((error, output) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store"
      });

      res.end(
        html(`
          <div class="box">
            <h2>
              Robinhood MCP Status
            </h2>

            <pre>${escapeHtml(output)}</pre>
          </div>

          <div class="box">
            <a href="/test-read">
              Run Read-Only Robinhood Test
            </a>
          </div>

          <div class="box">
            <a href="/auth">
              Authentication
            </a>
          </div>
        `)
      );
    });

    return;
  }

  /*
   * HOME
   */
  res.writeHead(200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-store"
  });

  res.end(
    html(`
      <div class="box">
        <p>
          Claude Code Robinhood MCP runtime is online.
        </p>

        <p>
          <a href="/auth">
            <button>
              Robinhood Authentication
            </button>
          </a>
        </p>

        <p>
          <a href="/status">
            MCP Status
          </a>
        </p>

        <p>
          <a href="/test-read">
            <button>
              Run Read-Only Robinhood Test
            </button>
          </a>
        </p>
      </div>
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
  }
);