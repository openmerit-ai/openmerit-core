# Release-testing findings

Dated observations from using OpenMerit as Sahra Health, newest release first. Each entry says what we ran, what happened and what a customer would expect.

## openmerit 0.3.0 (4 Nov 2026)

### Claude Code project install fails when the project is a subdirectory of a git repository

- **Ran:** `npx openmerit@0.3.0 install --client claude-code --scope project --no-open` from `playground/`, which lives inside a larger git repository. The device approval succeeded.
- **Happened:** the installer exited 1 with `Claude Code did not save the "openmerit" MCP server`. Claude Code had saved it, but under the git root (`projects["/home/user/workspace/repo"]` in `~/.claude.json`), and `claude mcp list` from `playground/` shows it connected. The installer looks under the working directory (`projects["…/playground"]`). Rerunning then fails with `MCP server openmerit already exists in local config`, so the installer conflicts with its own entry. `openmerit status` reports `MCP server: missing`, and `openmerit doctor` reports `Installation incomplete`. The skill and rule were written to `playground/.claude/`, but automatic updates are off ("bootstrap required").
- **Side effect:** the MCP entry now applies to Claude Code sessions anywhere in the parent repository, not only in `playground/`.
- **Expected:** a monorepo package can install Scout at project scope, or the installer explains that Claude Code's project scope is the git root and installs there.

### Scout fails every turn (4 Nov 2026, about 20:10 UTC)

- **Ran:** `openmerit scout "<task>" --json` four times from `playground/`, with the saved `existing-first` policy and with `--all-endpoints`, including a trivial one-line prompt. Conversations `cb63a3ce-22ee-42da-b740-59d0415714d9`, `8e2b560c-d778-4f1c-8ff9-59ddeed316e1`, `818fc3c5-b37f-4598-99b5-3a6df205e42f` and `037fa0d5-1a33-4741-a9f1-54ef34722301`.
- **Happened:** every turn returned `{"status":"error","error":"Scout could not finish this turn. Please try again."}` within about 4 seconds. Re-reading the conversation returns the same error. `openmerit status --client pi --scope project --check` reports `connection: connected`, and `https://openmerit.ai/scout/` returns 200, so the status check does not reveal that Scout cannot answer.
- **Effect:** model choices are paused, as the Scout skill instructs. The error gives no reason or retry time.
- **Cause (from the operator side, not visible to a customer):** the OpenAI API key behind Scout's own agent model (`openai/gpt-6-sol`) had expired. Each turn ended `model_error` before any tool call. The Worker logged only the reason code, not the provider error. The key was rotated at 20:31 UTC and the next turn succeeded in 30 s. The CLI and `status --check` gave no sign that the outage was server-side.

### Scout respects UAE residency strictly; recommendations need an explicit exception

- See MODEL-DECISIONS.md. Under `existing-first` with no endpoints, Scout returned no models. With the whole catalogue, it refused every agent because the catalogue has no processing-location data, and it would not treat Workers AI as an exception. Only an explicit recorded-gap exception produced rankings. This is correct and cautious behavior. The gap: Scout can never say that an endpoint **does** process data in a given region, so data-residency customers always end up on an exception.
- Scout reported "web search was unavailable" during that turn.

### Cost-first ranking let weaker models through the quality bar

- The brief stated "quality and reliable tool calling matter more than cost", and Scout captured it in `criteria`. Every task still got `priority: "cost"`, and the ranking puts Claude Haiku 5.5 (quality 82) above Claude Sonnet 5.5 (90) and Gemini 4 Argon (94).
- Per the published guide this is by design: Scout ranks cheapest first among models that reach its quality bar, and ranks by quality only when you explicitly ask for the best quality. Our wording did not count as that. The real gap is the bar: Scout's benchmark-based estimates put Haiku and Gemini 3.7 Flash above it, and our own comparison (below) showed they were weaker on our claims.

### Suspicious latency data

- Claude Haiku 5.5 is listed at 33.4 s total with 30 s to first token, slower than Claude Sonnet 5.5 (18.4 s, 12.6 s). That is implausible for the smaller model and may be a data error. All rankings came from catalogue snapshot `548870f9…`, which the operator's `deploy:status` reported as stale and degraded at the time.

### First fixture run with Scout's candidates (4 Nov 2026, 21:02 UTC)

- Claude Sonnet 5.5 (Scout's rank 4, via OpenRouter) passed 24/24 checks across 9 claims and 2 enrollments on `wrangler dev`, in about 2 minutes. An earlier run passed 22/24. Both misses were our own seed-data flaws: an upcoded "original" visit, and one implausible bulk drug claim. The agents flagged both correctly.
- Not an OpenMerit issue, but worth knowing: Cloudflare's Pi extensions page imports `Type` from `@earendil-works/pi-ai`, which Pi 1.5 does not export. We used the `@earendil-works/pi-schema` builders instead.

### Model comparison: Scout's cost-first order picked the weaker candidates (4 Nov 2026, 22:10 UTC)

- **Setup:** three rounds over 14 claims, including five harder cases, plus 2 enrollments. Full table in MODEL-DECISIONS.md.
- **Results:**
  - Claude Sonnet 5.5, Scout's rank 4, passed 106/108 checks with no errored claims.
  - Scout's rank 1, Claude Haiku 5.5, passed 102/108. It over-flagged fraud and once paid an unsupported line.
  - Scout's rank 2, Gemini 3.7 Flash, passed 102/108, with 2 claims errored on unretried tool-validation failures. It was twice as slow.
- **Cost:** Scout's per-task cost estimates were within about 30% of measured cost.
- **Latency:** Scout's latency data had Haiku and Sonnet in the wrong order; see "Suspicious latency data".
- **What Scout could not see:** tool-calling reliability under our schemas. The quality scores it cited (Vals AI MedCode, MedScribe) do not measure that. The brief named reliable tool calling as a priority.

### An existing-first inventory cannot be declared without knowing endpoint IDs

- The skill asks for "public catalogue endpoint IDs" the project can reach. We already use Workers AI, but nothing in the package lists the catalogue's endpoint IDs; the docs say they come back in Scout's recommendations. So we saved `existing-first` with zero IDs, which per the skill allows no endpoints, and existing Workers AI access cannot be expressed up front.

### Pi project install: transient "could not reach" while approval was pending

- The first `install --client pi --scope project` printed `Could not reach https://openmerit.ai` while its code was pending. Later reruns worked, and the final install succeeded with `Connection check: connected`. Seen once; not reproduced.

### Device codes expire before slow approvals

- Each code lasts 10 minutes, and a rerun resumes the same code until it expires. Two rounds of codes lapsed before the owner could approve. That is working as documented, but it is friction when the person approving is not the one running the installer.
