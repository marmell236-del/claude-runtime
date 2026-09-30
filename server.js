const http = require("http");
const { spawn, execFile } = require("child_process");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;

let loginProcess = null;
let loginOutput = "";
let authorizationUrl = "";
let loginState = "idle";
let loginError = "";

// Escape text before putting it into HTML.
function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Remove likely OAuth/security values before displaying diagnostics.
function sanitize(text) {
  if (!text) return "";

  return String(text)
    .replace(
      /(code|access_token|refresh_token|id_token|client_secret|code_verifier|code_challenge|state)=([^&\s]+)/gi,
      "$1=[REDACTED]"
    )
    .replace(
      /("?(?:access_token|refresh_token|id_token|client_secret|code_verifier|code_challenge|state)"?\s*[:=]\s*")([^"]+)(")/gi,
      "$1[REDACTED]$3"
    );
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

function extractAuthorizationUrl(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s"'<>]+/g) || [];

  for (const candidate of matches) {
    const lower = candidate.toLowerCase();

    if (
      lower.includes("robinhood") ||
      lower.includes("oauth") ||
      lower.includes("authorize")
    ) {
      return candidate.replace(/[),.;]+$/, "");
    }
  }

  return "";
}

function startLogin() {
  if (loginProcess) {
    console.log("[AUTH] Login already running.");
    return;
  }

  loginOutput = "";
  authorizationUrl = "";
  loginError = "";
  loginState = "starting";

  console.log("[AUTH] Starting Claude MCP login.");
  console.log(
    "[AUTH] Command: claude mcp login robinhood-trading --no-browser"
  );

  try {
    loginProcess = spawn(
      "claude",
      [
        "mcp",
        "login",
        "robinhood-trading",
        "--no-browser"
      ],
      {
        env: {
          ...process.env,
          HOME: process.env.HOME || "/root",
          PATH:
            process.env.PATH ||
            "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        },
        cwd: "/app",
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
  } catch (err) {
    loginState = "error";
    loginError = `Failed to start Claude: ${err.message}`;
    console.error("[AUTH]", loginError);
    loginProcess = null;
    return;
  }

  console.log(`[AUTH] Claude PID: ${loginProcess.pid}`);

  function consume(source, data) {
    const raw = data.toString();
    loginOutput += raw;

    // Log diagnostic output, but sanitize likely OAuth secrets.
    const safe = sanitize(raw);

    if (safe.trim()) {
      console.log(`[AUTH ${source}] ${safe.trimEnd()}`);
    }

    if (!authorizationUrl) {
      const found = extractAuthorizationUrl(loginOutput);

      if (found) {
        authorizationUrl = found;
        loginState = "waiting_for_authorization";

        // Do not print the authorization URL to Railway logs.
        console.log("[AUTH] Authorization URL detected.");
        console.log("[AUTH] Waiting for user authorization.");
      }
    }
  }

  loginProcess.stdout.on("data", data => {
    consume("STDOUT", data);
  });

  loginProcess.stderr.on("data", data => {
    consume("STDERR", data);
  });

  loginProcess.stdin.on("error", err => {
    console.error(
      `[AUTH STDIN ERROR] ${sanitize(err.message)}`
    );
  });

  loginProcess.on("error", err => {
    loginError = `Claude process error: ${err.message}`;
    loginState = "error";

    console.error(
      `[AUTH PROCESS ERROR] ${sanitize(err.message)}`
    );

    loginProcess = null;
  });

  loginProcess.on("close", (code, signal) => {
    console.log(
      `[AUTH] Claude process closed. code=${code} signal=${signal || "none"}`
    );

    if (code === 0) {
      loginState = "completed";
      loginError = "";

      console.log("[AUTH] Robinhood MCP login completed.");
    } else if (loginState !== "error") {
      loginState = "failed";

      const diagnostic = sanitize(loginOutput).trim();

      loginError =
        `Claude exited with code ${code}.` +
        (signal ? ` Signal: ${signal}.` : "") +
        (diagnostic
          ? `\n\nClaude output:\n${diagnostic}`
          : "\n\nClaude produced no stdout/stderr output.");

      console.error("[AUTH] Login failed.");
      console.error(sanitize(loginError));
    }

    loginProcess = null;
  });
}

function submitRedirect(redirectUrl) {
  if (
    !loginProcess ||
    !loginProcess.stdin ||
    loginProcess.stdin.destroyed
  ) {
    console.error(
      "[AUTH] Redirect submitted but no active Claude process exists."
    );

    return false;
  }

  loginState = "submitting_redirect";

  console.log(
    "[AUTH] Redirect received from browser. Sending it to Claude."
  );

  // Never print the redirect URL because it can contain OAuth credentials.
  loginProcess.stdin.write(redirectUrl.trim() + "\n");

  return true;
}

function checkMcp(callback) {
  console.log("[STATUS] Checking Robinhood MCP configuration.");

  execFile(
    "claude",
    ["mcp", "get", "robinhood-trading"],
    {
      env: {
        ...process.env,
        HOME: process.env.HOME || "/root"
      },
      cwd: "/app"
    },
    (error, stdout, stderr) => {
      const output = `${stdout || ""}${stderr || ""}`;

      if (error) {
        console.error(
          `[STATUS] MCP check error: ${sanitize(error.message)}`
        );
      }

      console.log(
        `[STATUS] MCP check completed.\n${sanitize(output)}`
      );

      callback(error, sanitize(output));
    }
  );
}

const server = http.createServer((req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  if (url.pathname === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(
      JSON.stringify({
        status: "ok",
        service: "claude-robinhood-runtime",
        login_state: loginState,
        login_process_active: Boolean(loginProcess),
        authorization_url_detected: Boolean(authorizationUrl)
      })
    );

    return;
  }

  if (url.pathname === "/auth/start") {
    startLogin();

    res.writeHead(302, {
      Location: "/auth"
    });

    res.end();
    return;
  }

  if (
    url.pathname === "/auth/submit" &&
    req.method === "POST"
  ) {
    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();

      // Prevent accidentally accepting huge request bodies.
      if (body.length > 20000) {
        req.destroy();
      }
    });

    req.on("end", () => {
      const params = new URLSearchParams(body);

      const redirectUrl =
        params.get("redirect_url") || "";

      if (
        !redirectUrl.startsWith("http://") &&
        !redirectUrl.startsWith("https://")
      ) {
        res.writeHead(400, {
          "Content-Type": "text/html"
        });

        res.end(
          html(`
            <div class="box">
              Invalid redirect URL.
            </div>

            <a href="/auth">Back</a>
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

  if (url.pathname === "/auth") {
    let authorizationBlock = "";

    if (authorizationUrl) {
      authorizationBlock = `
        <div class="box">
          <h2>Step 1</h2>

          <p>
            Open Robinhood authorization:
          </p>

          <p>
            <a
              href="${escapeHtml(authorizationUrl)}"
              rel="noreferrer"
            >
              Open Robinhood Authorization
            </a>
          </p>
        </div>

        <div class="box">
          <h2>Step 2</h2>

          <p>
            After Robinhood redirects you, copy the complete
            redirect URL from your browser and paste it here.
          </p>

          <p>
            Do not paste that redirect URL into chat or anywhere
            else.
          </p>

          <form
            method="POST"
            action="/auth/submit"
          >
            <input
              name="redirect_url"
              type="text"
              autocomplete="off"
              placeholder="Paste complete redirect URL"
              required
            >

            <button type="submit">
              Complete Authentication
            </button>
          </form>
        </div>
      `;
    }

    let actionBlock = "";

    if (
      loginState === "idle" ||
      loginState === "failed" ||
      loginState === "error"
    ) {
      actionBlock = `
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

    let errorBlock = "";

    if (loginError) {
      errorBlock = `
        <div class="box">
          <strong>Diagnostic Error:</strong>

          <pre>${escapeHtml(sanitize(loginError))}</pre>
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

        ${actionBlock}

        ${authorizationBlock}

        ${errorBlock}

        <div class="box">
          <a href="/status">
            Check MCP Status
          </a>
        </div>
      `)
    );

    return;
  }

  if (url.pathname === "/status") {
    checkMcp((error, output) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store"
      });

      res.end(
        html(`
          <div class="box">
            <h2>Robinhood MCP Status</h2>

            <pre>${escapeHtml(output)}</pre>
          </div>

          <a href="/auth">
            Authentication
          </a>
        `)
      );
    });

    return;
  }

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
      </div>
    `)
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Claude Robinhood runtime listening on port ${PORT}`
  );
});