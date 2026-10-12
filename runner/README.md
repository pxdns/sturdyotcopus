# Luma runner

An optional server that gives the IDE a **real terminal**: a shell with Node, a JDK, Gradle, Python and git, plus whatever agent
CLIs you install (Claude Code, Copilot CLI, ...). The IDE works without it; the runner adds what a browser tab cannot do.

```
IDE (browser)  --WebSocket-->  runner/server.mjs  --docker run-->  isolated container with a PTY
   GitHub token  --------------> verified against the GitHub API, then checked against your allow-list
```

You host it, so you control cost, region and who can use it.

## Security model - read before deploying

A runner hands people a shell. It is **closed by default**:

* It refuses to start unless you set who may connect (`RUNNER_ALLOWED_USERS` and/or `RUNNER_ALLOWED_ORG`) **and** which web origin
  may open connections (`RUNNER_ALLOWED_ORIGINS`).
* Every connection must present a GitHub token. The server asks GitHub who the user is, then checks the allow-list.
* Each session is a separate Docker container with memory, CPU and process limits, all capabilities dropped and
  `no-new-privileges`. A named volume per user keeps their files between sessions.
* Limits: `RUNNER_MAX_SESSIONS_PER_USER` (default 2) and `RUNNER_IDLE_MINUTES` (default 30).
* The user's GitHub token is placed in the container's environment so `git` and `gh` work as them. It is their token in their own
  sandbox, but anything they run can read it.
* **Containers can reach the internet** by default. For untrusted users put the host behind an egress firewall.
* Terminate TLS in front of the server (Caddy, nginx, a load balancer) and use `wss://`.
* Docker isolation is not a virtual machine. For hostile users prefer gVisor, Kata or Firecracker.

`RUNNER_MODE=local` starts a bare shell on the host with **no isolation**. It exists for development and tests only and needs
`RUNNER_UNSAFE_LOCAL=1`.

## Deploy

```bash
# on a Linux host with Docker
docker build -t luma-runner:latest runner/image
cd runner && npm install
RUNNER_ALLOWED_USERS=your-github-login \
RUNNER_ALLOWED_ORIGINS=https://luma-ide.vercel.app \
node server.mjs            # listens on :8787
```

Then in the IDE: sign in with GitHub, run **Remote Runner: Set Server URL** (for example `wss://runner.example.com/ws`), then
**Remote Runner: Open Terminal**, or use the terminal's profile menu.

### Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | 8787 | Listen port |
| `RUNNER_ALLOWED_ORIGINS` | none | Comma-separated web origins allowed to connect (required) |
| `RUNNER_ALLOWED_USERS` | none | Comma-separated GitHub logins allowed |
| `RUNNER_ALLOWED_ORG` | none | GitHub organization whose active members are allowed |
| `RUNNER_ALLOW_ANY_GITHUB_USER` | off | `1` allows every GitHub account (not recommended) |
| `RUNNER_IMAGE` | `luma-runner:latest` | Image for sessions |
| `RUNNER_MEMORY` / `RUNNER_CPUS` / `RUNNER_PIDS` | `2g` / `1` / `512` | Per-session limits |
| `RUNNER_MAX_SESSIONS_PER_USER` | 2 | Concurrent sessions per user |
| `RUNNER_IDLE_MINUTES` | 30 | Close sessions with no input for this long |
| `GITHUB_API_URL` | `https://api.github.com` | For GitHub Enterprise |

## Status

* The server and the IDE client are tested end to end in local mode against a fake GitHub (`npm test` runs the server checks).
* The Docker mode and the `image/Dockerfile` have **not** been exercised in CI. Build and try them on your host first.
* The npm package names for the agent CLIs in the Dockerfile (`@anthropic-ai/claude-code`, `@github/copilot`) are given from
  memory; check them, and change `AGENT_CLIS` to taste. A failed install only prints a warning.
* Files are shared with the IDE through git: the IDE commits to GitHub and you `git pull` in the runner (and push from the
  runner). There is no live file bridge yet.
