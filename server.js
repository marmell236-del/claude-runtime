const http = require("http");
const { spawn, execFile } = require("child_process");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;

let loginProcess = null;
let loginOutput = "";
let authorizationUrl = "";
let loginState = "idle";
let loginError = "";

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

function startLogin() {
  if (loginProcess) return;

  loginOutput = "";
  authorizationUrl = "";
  loginError = "";
  loginState = "starting";

  loginProcess = spawn(
    "claude",
    [
      "mcp",
      "login",
      "robinhood-trading",
      "--no-browser"
    ],
    {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );

  function consume(data) {
    const text = data.toString();
    loginOutput += text;

    const found = extractAuthorizationUrl(loginOutput);

    if (found) {
      authorizationUrl = found;
      loginState = "waiting_for_authorization";
    }
  }

  loginProcess.stdout.on("data", consume);

  loginProcess.stderr.on("data", consume);

  loginProcess.on("error", (err) => {
    loginError = err.message;
    loginState = "error";
    loginProcess = null;
  });

  loginProcess.on("close", (code) => {
    if (code === 0) {
      loginState = "completed";
    } else if (loginState !== "error") {
      loginState = "failed";
      loginError = `Claude exited with code ${code}`;
    }

    loginProcess = null;
  });
}

function submitRedirect(redirectUrl) {
  if (!loginProcess || !loginProcess.stdin) {
    return false;
  }

  loginState = "submitting_redirect";
  loginProcess.stdin.write(redirectUrl.trim() + "\n");
  return true;
}

function checkMcp(callback) {
  execFile(
    "claude",
    ["mcp", "get", "robinhood-trading"],
    { env: process.env },
    (error, stdout, stderr) => {
      callback(error, `${stdout || ""}${stderr || ""}`);
    }
  );
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "claude-robinhood-runtime",
        login_state: loginState
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

  if (url.pathname === "/auth/submit" && req.method === "POST") {
    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();
    });

    req.on("end", () => {
      const params = new URLSearchParams(body);
      const redirectUrl = params.get("redirect_url") || "";

      if (!redirectUrl.startsWith("http://") &&
          !redirectUrl.startsWith("https://")) {
        res.writeHead(400, { "Content-Type": "text/html" });

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

      const accepted = submitRedirect(redirectUrl);

      if (!accepted) {
        res.writeHead(409, { "Content-Type": "text/html" });

        res.end(
          html(`
            <div class="box">
              No active Claude login process.
            </div>
            <a href="/auth/start">Start again</a>
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
          <p>Open Robinhood authorization:</p>

          <p>
            <a href="${authorizationUrl}">
              Open Robinhood Authorization
            </a>
          </p>
        </div>

        <div class="box">
          <h2>Step 2</h2>

          <p>
            After Robinhood redirects you, copy the complete redirect
            URL from your browser and paste it here.
          </p>

          <form method="POST" action="/auth/submit">
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

    res.writeHead(200, { "Content-Type": "text/html" });

    res.end(
      html(`
        <div class="box">
          <strong>Status:</strong> ${loginState}
        </div>

        ${
          loginState === "idle"
            ? `
              <div class="box">
                <a href="/auth/start">
                  <button>Start Robinhood Login</button>
                </a>
              </div>
            `
            : ""
        }

        ${authorizationBlock}

        ${
          loginError
            ? `
              <div class="box">
                <strong>Error:</strong>
                <pre>${loginError}</pre>
              </div>
            `
            : ""
        }

        <div class="box">
          <a href="/status">Check MCP Status</a>
        </div>
      `)
    );

    return;
  }

  if (url.pathname === "/status") {
    checkMcp((error, output) => {
      res.writeHead(200, { "Content-Type": "text/html" });

      res.end(
        html(`
          <div class="box">
            <h2>Robinhood MCP Status</h2>
            <pre>${output}</pre>
          </div>

          <a href="/auth">Authentication</a>
        `)
      );
    });

    return;
  }

  res.writeHead(200, { "Content-Type": "text/html" });

  res.end(
    html(`
      <div class="box">
        <p>Claude Code Robinhood MCP runtime is online.</p>

        <p>
          <a href="/auth">
            <button>Robinhood Authentication</button>
          </a>
        </p>

        <p>
          <a href="/status">MCP Status</a>
        </p>
      </div>
    `)
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Claude Robinhood runtime listening on port ${PORT}`);
});