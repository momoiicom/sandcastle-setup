# sandcastle-setup

A working [Sandcastle](https://github.com/mattpocock/sandcastle) template for running Codex agents in Docker sandboxes against a Next.js project. This repo is the reference setup — copy or adapt `.sandcastle/` into other projects once it works here.

The Next.js app is the codebase agents work on. The Sandcastle config in `.sandcastle/` is the main deliverable.

## Prerequisites

- [Docker Desktop](https://www.docker.com/)
- [pnpm](https://pnpm.io/) 11.x (`corepack enable` or `npm i -g pnpm`)
- [Codex CLI](https://github.com/openai/codex) authenticated on the host (`codex login`)
- A GitHub personal access token with **Issues (read/write)** and **Metadata (read)**

## First-time setup

```bash
pnpm install
cp .sandcastle/.env.example .sandcastle/.env
# Edit .sandcastle/.env — add OPENAI_KEY and GH_TOKEN (never commit real values)
pnpm sandcastle:rebuild   # builds Docker image + starts Sandcastle
```

After the first build, use `pnpm sandcastle` for subsequent runs.

## Running Sandcastle

| Command | What it does |
|---|---|
| `pnpm sandcastle` | Run the plan → implement → review → merge loop |
| `pnpm sandcastle:rebuild` | Rebuild the Docker image (after Dockerfile changes) and run |

Logs are written to `.sandcastle/logs/`.

## How it works

Sandcastle runs a multi-phase loop defined in `.sandcastle/main.mts`:

1. **Plan** — reads GitHub issues, picks unblocked work, outputs a JSON plan
2. **Execute + Review** — one Docker sandbox per issue; implementer then reviewer on the same branch
3. **Merge** — merges completed branches back to `main`

Agents run inside Docker containers. The host worktree is bind-mounted at `/home/agent/workspace`.

### Key configuration

| File | Purpose |
|---|---|
| `.sandcastle/main.mts` | Orchestration loop, Docker sandbox config, hooks |
| `.sandcastle/Dockerfile` | Sandbox image: Node 22, pnpm, Codex CLI, gh, git |
| `.sandcastle/plan-prompt.md` | Planner agent instructions |
| `.sandcastle/implement-prompt.md` | Implementer agent instructions |
| `.sandcastle/review-prompt.md` | Reviewer agent instructions |
| `.sandcastle/merge-prompt.md` | Merger agent instructions |
| `.sandcastle/CODING_STANDARDS.md` | Project coding standards (loaded by reviewer) |
| `.sandcastle/.env` | Secrets (gitignored) |
| `pnpm-workspace.yaml` | pnpm settings including `dangerouslyAllowAllBuilds` |

### Docker image details

- **Image name:** `sandcastle:sandcastle-setup` (derived from repo directory name by Sandcastle)
- **UID/GID:** built with host `id -u` / `id -g` so bind-mounted files have correct ownership on macOS
- **Codex auth:** `~/.codex` is bind-mounted to `/home/agent/.codex`
- **Dependencies:** `pnpm install` runs in each sandbox with `CI=true` (required for non-interactive installs)

Rebuild the image after any Dockerfile change:

```bash
pnpm sandcastle:rebuild
```

---

## Guidance for AI agents

If you are an AI agent working in this repository, read this section first.

### What this repo is

This is a **Sandcastle reference setup**, not a generic Next.js starter. Changes to `.sandcastle/` affect how autonomous agents run in Docker. Changes to `app/`, `src/`, etc. are the application the agents build.

### Package manager

**Use pnpm only.** Do not introduce npm or yarn.

- Lockfile: `pnpm-lock.yaml`
- Workspace config: `pnpm-workspace.yaml`
- Scripts: `pnpm <script>`, `pnpm exec tsx`, `pnpm add`, etc.
- Never create or commit `package-lock.json`

### Secrets and environment

- **Never commit real tokens or API keys.** Use `.sandcastle/.env.example` with placeholders only.
- Real values go in `.sandcastle/.env` (gitignored).
- If a secret was accidentally committed, rewrite git history before pushing — GitHub push protection will block it.

### Sandcastle changes

When modifying `.sandcastle/`:

1. **Dockerfile** — rebuild is required (`pnpm sandcastle:rebuild`). The image must be tagged `sandcastle:sandcastle-setup` and built with `--build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g)`.
2. **Global CLI in Docker** — use pnpm with system-wide paths (`global-bin-dir`, `global-dir`, `store-dir` under `/usr/local/share/`) and `chmod -R a+rX` so the `agent` user can run Codex.
3. **Sandbox hooks** — `pnpm install` needs `CI=true` in the container env (no TTY for module purge).
4. **Codex auth** — keep the `~/.codex` → `/home/agent/.codex` mount in `main.mts`; do not remove it.
5. **Prompts** — use `pnpm run` in agent instructions, not `npm run`.

### Application changes

- This is Next.js 16 with the App Router. Read `node_modules/next/dist/docs/` before changing Next.js APIs — conventions differ from older versions.
- Follow `.sandcastle/CODING_STANDARDS.md` when writing code that Sandcastle agents will review.
- Keep changes minimal and focused on the task.

### Common pitfalls (already solved — don't regress)

| Problem | Solution in this repo |
|---|---|
| `sandbox-install: not found` | Use `pnpm install` directly in hooks, not a custom script |
| UID mismatch on macOS | Build image with host UID/GID build args |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | Set `CI=true` in sandbox env |
| Codex module not found in container | pnpm global install to `/usr/local/share/`, not `~/.local` |
| Corepack download prompt in CI | `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` + pre-install pnpm 11.7.0 |
| pnpm build script approval | `dangerouslyAllowAllBuilds: true` in `pnpm-workspace.yaml` |
| GitHub push blocked for secrets | Never put real `GH_TOKEN` in committed files |

### File layout

```
.sandcastle/
  main.mts              # entry point — start here to understand the loop
  Dockerfile            # sandbox image definition
  .env / .env.example   # secrets / template
  *-prompt.md           # agent instructions per phase
  CODING_STANDARDS.md   # code style for review phase
  logs/                 # runtime logs (gitignored)
  worktrees/            # sandcastle worktrees (gitignored)
```

### Verifying changes

- Dockerfile changes → `pnpm sandcastle:rebuild`
- `main.mts` or prompt changes → `pnpm sandcastle`
- App changes → `pnpm dev`, `pnpm build`, `pnpm lint`

---

## Next.js app

```bash
pnpm dev      # http://localhost:3000
pnpm build
pnpm lint
```

Edit `app/page.tsx` to change the homepage.
