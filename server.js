const http = require("http");
const { spawn, execFile } = require("child_process");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;

let loginProcess = null;
let loginOutput = "";
let authorizationUrl = "";
let loginState = "idle";
let loginError = "";
let readyForRedirect = false;

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
  font-family: -apple-system,BlinkMacSystemFont,sans-serif;
  max-width:760px;
  margin:40px auto;
  padding:0 20px;
  background:#111;
  color:#eee;
}

.box {
  background:#1c1c1e;
  padding:20px;
  border-radius:14px;
  margin:18px 0;
}

button {
  font-size:17px;
  padding:12px 18px;
  border:0;
  border-radius:10px;
  cursor:pointer;
}

input {
  width:100%;
  box-sizing:border-box;
  font-size:16px;
  padding:12px;
  margin:10px 0;
}

a {
  color:#64a8ff;
  word-break:break-all;
}

pre {
  white-space:pre-wrap;
  word-break:break-word;
  font-size:13px;
}
</style>
</head>

<body>
<h1>Claude ↔ Robinhood</h1>
${body}
</body>
</html>`;
}

function stripAnsi(text) {
  return text.replace(
    /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    ""
  );
}

function redactSensitive(text) {
  return String(text)
    .replace(
      /https?:\/\/localhost[^\s"'<>]*/gi,
      "[LOCALHOST REDIRECT REDACTED]"
    )
    .replace(
      /([?&]code=)[^&\s]+/gi,
      "$1[REDACTED]"
    )
    .replace(
      /([?&]state=)[^&\s]+/gi,
      "$1[REDACTED]"
    );
}

function extractAuthorizationUrl(text) {
  const clean = stripAnsi(text);

  const matches =
    clean.match(/https?:\/\/[^\s"'<>]+/g) || [];

  for (const candidate of matches) {
    const lower = candidate.toLowerCase();

    if (
      !lower.includes("localhost") &&
      (
        lower.includes("robinhood") ||
        lower.includes("oauth") ||
        lower.includes("authorize")
      )
    ) {
      return candidate.replace(/[),.;]+$/, "");
    }
  }

  return "";
}

function consumeLoginOutput(data) {
  const text = stripAnsi(data.toString());

  loginOutput += text;

  /*
   * Never print OAuth URLs, authorization codes,
   * or state values into Railway logs.
   */
  console.log(
    "[CLAUDE LOGIN]",
    redactSensitive(text)
  );

  const found =
    extractAuthorizationUrl(loginOutput);

  if (found && !authorizationUrl) {
    authorizationUrl = found;
  }

  /*
   * Claude explicitly tells us when it is ready
   * for the localhost redirect URL.
   */
  if (
    text.includes("paste the redirect URL") ||
    text.includes("Paste the redirect URL") ||
    text.includes("Or paste the redirect URL here")
  ) {
    readyForRedirect = true;
  }

  if (
    authorizationUrl &&
    readyForRedirect
  ) {
    loginState =
      "waiting_for_authorization";
  }
}

function startLogin() {
  if (loginProcess) {
    return;
  }

  loginOutput = "";
  authorizationUrl = "";
  loginError = "";
  readyForRedirect = false;
  loginState = "starting";

  /*
   * stty -echo prevents anything written to the
   * PTY from being echoed back into the output.
   *
   * exec replaces the shell with Claude after
   * terminal configuration is complete.
   */
  const command =
    'stty -echo; exec claude mcp login robinhood-trading --no-browser';

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

  loginProcess.stdout.on(
    "data",
    consumeLoginOutput
  );

  loginProcess.stderr.on(
    "data",
    consumeLoginOutput
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
      if (code === 0) {
        loginState = "completed";
      } else if (
        loginState !== "error"
      ) {
        loginState = "failed";

        loginError =
          `Claude exited with code ${code}.`;
      }

      loginProcess = null;
      readyForRedirect = false;
    }
  );
}

function submitRedirect(redirectUrl) {
  if (
    !loginProcess ||
    !loginProcess.stdin ||
    loginProcess.stdin.destroyed ||
    !readyForRedirect
  ) {
    return false;
  }

  /*
   * Only accept Claude's expected localhost
   * callback. Do not accept arbitrary URLs.
   */
  let parsed;

  try {
    parsed = new URL(redirectUrl);
  } catch {
    return false;
  }

  if (
    parsed.hostname !== "localhost" &&
    parsed.hostname !== "127.0.0.1"
  ) {
    return false;
  }

  if (
    !parsed.searchParams.get("code") ||
    !parsed.searchParams.get("state")
  ) {
    return false;
  }

  loginState = "submitting_redirect";
  readyForRedirect = false;

  /*
   * This is the ONLY place user input is written
   * into Claude's PTY.
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

const server =
http.createServer((req, res) => {

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
        "Content-Type":
          "application/json"
      }
    );

    res.end(
      JSON.stringify({
        status: "ok",
        service:
          "claude-robinhood-runtime",
        login_state: loginState,
        authorization_url_ready:
          Boolean(authorizationUrl),
        ready_for_redirect:
          readyForRedirect
      })
    );

    return;
  }

  /*
   * START LOGIN
   */
  if (
    url.pathname === "/auth/start"
  ) {

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
   * SUBMIT LOCALHOST CALLBACK
   */
  if (
    url.pathname === "/auth/submit" &&
    req.method === "POST"
  ) {

    let body = "";

    req.on(
      "data",
      chunk => {
        body += chunk.toString();
      }
    );

    req.on(
      "end",
      () => {

        const params =
          new URLSearchParams(body);

        const redirectUrl =
          params.get(
            "redirect_url"
          ) || "";

        const accepted =
          submitRedirect(
            redirectUrl
          );

        if (!accepted) {

          res.writeHead(
            409,
            {
              "Content-Type":
                "text/html"
            }
          );

          res.end(
            html(`
<div class="box">
The Claude authentication process is not
currently waiting for a valid localhost
redirect URL.
</div>

<a href="/auth">
Back
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
      }
    );

    return;
  }

  /*
   * AUTH PAGE
   */
  if (
    url.pathname === "/auth"
  ) {

    let main = `
<div class="box">
<strong>Status:</strong>
${escapeHtml(loginState)}
</div>
`;

    if (
      loginState === "idle" ||
      loginState === "failed" ||
      loginState === "error"
    ) {

      main += `
<div class="box">

<a href="/auth/start">

<button>
${
  loginState === "idle"
    ? "Start Robinhood Login"
    : "Start New Robinhood Login"
}
</button>

</a>

</div>
`;
    }

    if (
      loginState === "starting"
    ) {

      main += `
<div class="box">

Claude is starting the Robinhood
authentication flow.

<p>
Refresh this page in a few seconds.
</p>

</div>
`;
    }

    if (
      authorizationUrl &&
      readyForRedirect
    ) {

      main += `
<div class="box">

<h2>Step 1</h2>

<p>
Open Robinhood authorization.
</p>

<a
href="${escapeHtml(authorizationUrl)}"
target="_blank"
rel="noopener noreferrer"
>

<button>
Open Robinhood Authorization
</button>

</a>

</div>


<div class="box">

<h2>Step 2</h2>

<p>
After approving access, Robinhood will
redirect your browser to localhost.
</p>

<p>
The localhost page may say that it
cannot connect. That is expected.
</p>

<p>
Copy the COMPLETE localhost URL from
your browser's address bar and paste it
below.
</p>

<form
method="POST"
action="/auth/submit"
>

<input
name="redirect_url"
type="text"
autocomplete="off"
placeholder="Paste localhost redirect URL"
required
>

<button type="submit">
Complete Authentication
</button>

</form>

</div>
`;
    }

    if (
      loginState ===
      "submitting_redirect"
    ) {

      main += `
<div class="box">

Claude is exchanging the Robinhood
authorization grant.

<p>
Refresh this page in a few seconds.
</p>

</div>
`;
    }

    if (
      loginState === "completed"
    ) {

      main += `
<div class="box">

<h2>
Authentication completed.
</h2>

<p>
Check MCP status below.
</p>

</div>
`;
    }

    if (loginError) {

      main += `
<div class="box">

<strong>
Diagnostic Error:
</strong>

<pre>
${escapeHtml(loginError)}

Claude output:

${escapeHtml(
  redactSensitive(loginOutput)
)}
</pre>

</div>
`;
    }

    main += `
<div class="box">

<a href="/status">
Check MCP Status
</a>

</div>
`;

    res.writeHead(
      200,
      {
        "Content-Type":
          "text/html"
      }
    );

    res.end(
      html(main)
    );

    return;
  }

  /*
   * STATUS
   */
  if (
    url.pathname === "/status"
  ) {

    checkMcp(
      (error, output) => {

        res.writeHead(
          200,
          {
            "Content-Type":
              "text/html"
          }
        );

        res.end(
          html(`
<div class="box">

<h2>
Robinhood MCP Status
</h2>

<pre>
${escapeHtml(
  redactSensitive(output)
)}
</pre>

</div>

<div class="box">

<a href="/auth">
Authentication
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
  res.writeHead(
    200,
    {
      "Content-Type":
        "text/html"
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