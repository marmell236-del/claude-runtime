const http = require("http");
const { execFile, spawn } = require("child_process");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;

let loginProcess = null;
let loginOutput = "";
let authorizationUrl = "";
let loginState = "idle";
let loginError = "";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
  const matches = text.match(/https?:\/\/[^\s"'<>]+/g) || [];

  for (const candidate of matches) {
    if (
      candidate.includes("robinhood") ||
      candidate.includes("oauth") ||
      candidate.includes("authorize")
    ) {
      return candidate.replace(/[),.;]+$/, "");
    }
  }

  return "";
}

function consumeLoginOutput(text) {
  loginOutput += text;

  console.log(
    "[CLAUDE LOGIN]",
    text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
  );

  const found = extractAuthorizationUrl(loginOutput);

  if (found) {
    authorizationUrl = found;
    loginState = "waiting_for_authorization";
  }
}

function startLogin() {
  if (loginProcess) {
    return;
  }

  loginOutput = "";
  authorizationUrl = "";
  loginError = "";
  loginState = "starting";

  /*
   * `script` creates a real pseudo-terminal.
   *
   * Claude Code MCP authentication checks whether stdin is attached
   * to a terminal. Ordinary child_process pipes fail that check.
   *
   * script -q -f -c COMMAND /dev/null
   * runs Claude inside a PTY while still allowing Node to communicate
   * with the process.
   */

  const command =
    "claude mcp login robinhood-trading --no-browser";

  loginProcess = spawn(
    "script",
    [
      "-q",
      "-f",
      "-c",
      command,
      "/dev/null"
    ],
    {
      env: {
        ...process.env,
        TERM: "xterm-256color"
      },
      stdio: [
        "pipe",
        "pipe",
        "pipe"
      ]
    }
  );

  loginProcess.stdout.on("data", data => {
    consumeLoginOutput(data.toString());
  });

  loginProcess.stderr.on("data", data => {
    consumeLoginOutput(data.toString());
  });

  loginProcess.on("error", err => {
    loginError = err.message;
    loginState = "error";
    loginProcess = null;
  });

  loginProcess.on("close", code => {
    if (code === 0) {
      loginState = "completed";
    } else if (loginState !== "error") {
      loginState = "failed";

      loginError =
        `Claude PTY process exited with code ${code}.`;
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
    return false;
  }

  loginState = "submitting_redirect";

  /*
   * Send the redirect URL back through the PTY.
   */

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
      env: process.env
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
    res.writeHead(
      200,
      {
        "Content-Type": "application/json"
      }
    );

    res.end(
      JSON.stringify({
        status: "ok",
        service: "claude-robinhood-runtime",
        login_state: loginState,
        authorization_url_ready:
          Boolean(authorizationUrl)
      })
    );

    return;
  }

  /*
   * START AUTHENTICATION
   */

  if (url.pathname === "/auth/start") {
    startLogin();

    res.writeHead(
      302,
      {
        Location: "/auth"
      }
    );

    res.end();

    return;
  }

  /*
   * SUBMIT REDIRECT URL
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
      const params =
        new URLSearchParams(body);

      const redirectUrl =
        params.get("redirect_url") || "";

      if (
        !redirectUrl.startsWith("http://") &&
        !redirectUrl.startsWith("https://")
      ) {
        res.writeHead(
          400,
          {
            "Content-Type": "text/html"
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
        submitRedirect(redirectUrl);

      if (!accepted) {
        res.writeHead(
          409,
          {
            "Content-Type": "text/html"
          }
        );

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

      res.writeHead(
        302,
        {
          Location: "/auth"
        }
      );

      res.end();
    });

    return;
  }

  /*
   * AUTHENTICATION PAGE
   */

  if (url.pathname === "/auth") {
    let authorizationBlock = "";

    if (authorizationUrl) {
      authorizationBlock = `
        <div class="box">

          <h2>Step 1</h2>

          <p>
            Claude generated the Robinhood
            authorization URL.
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
            When Robinhood redirects your browser
            to localhost, copy the COMPLETE URL
            from the browser address bar.
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

    let retryBlock = "";

    if (
      loginState === "idle" ||
      loginState === "failed" ||
      loginState === "error"
    ) {
      retryBlock = `
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

          <strong>
            Diagnostic Error:
          </strong>

          <pre>
${escapeHtml(loginError)}

Claude output:

${escapeHtml(loginOutput)}
          </pre>

        </div>
      `;
    }

    let waitingBlock = "";

    if (
      loginState === "starting" &&
      !authorizationUrl
    ) {
      waitingBlock = `
        <div class="box">

          Claude is starting the
          Robinhood OAuth flow.

          <p>
            Refresh this page in a few seconds.
          </p>

        </div>
      `;
    }

    let completedBlock = "";

    if (loginState === "completed") {
      completedBlock = `
        <div class="box">

          <h2>
            Authentication process completed.
          </h2>

          <p>
            Check MCP status below.
          </p>

        </div>
      `;
    }

    res.writeHead(
      200,
      {
        "Content-Type": "text/html"
      }
    );

    res.end(
      html(`

        <div class="box">
          <strong>Status:</strong>
          ${escapeHtml(loginState)}
        </div>

        ${retryBlock}

        ${waitingBlock}

        ${authorizationBlock}

        ${completedBlock}

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

  /*
   * MCP STATUS
   */

  if (url.pathname === "/status") {
    checkMcp((error, output) => {
      res.writeHead(
        200,
        {
          "Content-Type": "text/html"
        }
      );

      res.end(
        html(`

          <div class="box">

            <h2>
              Robinhood MCP Status
            </h2>

            <pre>
${escapeHtml(output)}
            </pre>

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

  res.writeHead(
    200,
    {
      "Content-Type": "text/html"
    }
  );

  res.end(
    html(`

      <div class="box">

        <p>
          Claude Code Robinhood MCP runtime
          is online.
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

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Claude Robinhood runtime listening on port ${PORT}`
    );
  }
);