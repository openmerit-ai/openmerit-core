// GitHub repositories end to end: adding one by its URL or with a fine-grained token, the access
// check, the read-only shallow clone and its limits, the review and the deleted checkout. A local
// fake GitHub serves the REST API and real git over smart HTTP (git http-backend), so no request
// leaves the machine.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { EvalView, RepoView } from "../src/actors/account.ts";
import { parseRepoUrl, reviewCheckout, withCheckout, type GitHubConfig } from "../src/github.ts";
import { signStripePayload } from "../src/billing.ts";
import { bundle, caller, catalogue, chatAnswer, fakeModels, startApp, stop, subscribe, TICKETS, waitFor, type App, type FakeModels } from "./helpers.ts";

const TOKEN = `github_pat_${"A".repeat(30)}_good`;
const NO_CONTENTS = `github_pat_${"B".repeat(30)}_meta`;
/** user_ga's GitHub token from Clerk's GitHub App sign-in: it reaches what installations of the app give user_ga. */
const GHU = `ghu_${"G".repeat(36)}`;

interface FakeRepo { private: boolean; token?: string; sizeKb?: number; slowMs?: number }
/** Set `limited` to answer every REST call as GitHub does when its rate limit is used up. */
interface FakeGitHub { api: string; git: string; requests: { method: string; path: string; auth: string }[]; limited: { status: 403 | 429; reset: number } | null; close: () => Promise<void> }

/** A bare repository under root/<owner>/<name>.git with the given files committed on main. Values starting with -> are symlinks. */
function bareRepo(root: string, fullName: string, files: Record<string, string>): void {
  const work = mkdtempSync(join(tmpdir(), "openmerit-fake-work-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(work, file, ".."), { recursive: true });
    if (content.startsWith("->")) symlinkSync(content.slice(2), join(work, file));
    else writeFileSync(join(work, file), content);
  }
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  run(work, "init", "-q", "-b", "main");
  run(work, "add", "-A");
  run(work, "commit", "-q", "-m", "first");
  run(work, "commit", "-q", "--allow-empty", "-m", "second");
  run(root, "clone", "-q", "--bare", work, join(root, `${fullName}.git`));
}

/** Installations of the OpenMerit GitHub App each user token reaches: GET /user/installations and their repositories. */
type FakeInstallations = Record<string, { id: number; account: string; repos: string[] }[]>;

async function fakeGitHub(repos: Record<string, FakeRepo>, root: string, installations: FakeInstallations = {}): Promise<FakeGitHub> {
  const requests: FakeGitHub["requests"] = [];
  const fake = { limited: null as FakeGitHub["limited"] };
  const read = (req: IncomingMessage) => new Promise<Buffer>(resolve => { const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk as Buffer)); req.on("end", () => resolve(Buffer.concat(chunks))); });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const auth = String(req.headers.authorization ?? "");
    requests.push({ method: req.method ?? "GET", path: url.pathname, auth });
    const body = await read(req);
    const mine = installations[auth.replace(/^Bearer /, "")];
    if (url.pathname === "/api/user/installations") {
      if (!mine) { res.writeHead(401).end(JSON.stringify({ message: "Bad credentials" })); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total_count: mine.length,
        installations: mine.map(item => ({ id: item.id, account: { login: item.account, type: "Organization" }, repository_selection: "selected", html_url: `https://github.com/organizations/${item.account}/settings/installations/${item.id}` })) }));
      return;
    }
    const listed = /^\/api\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    if (listed) {
      const found = mine?.find(item => item.id === Number(listed[1]));
      if (!found) { res.writeHead(404).end(JSON.stringify({ message: "Not Found" })); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ total_count: found.repos.length,
        repositories: found.repos.map(name => ({ full_name: name, private: repos[name]?.private === true, default_branch: "main", size: 12 })) }));
      return;
    }
    const api = /^\/api\/repos\/([^/]+)\/([^/]+)(\/commits)?$/.exec(url.pathname);
    if (api && fake.limited) {
      res.writeHead(fake.limited.status, { "content-type": "application/json", "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(fake.limited.reset) })
        .end(JSON.stringify({ message: "API rate limit exceeded for 127.0.0.1." }));
      return;
    }
    if (api) {
      const fullName = `${api[1]}/${api[2]}`, repo = repos[fullName];
      const bearer = auth.replace(/^Bearer /, "");
      const visible = repo && (!repo.private || bearer === repo.token || bearer === NO_CONTENTS);
      if (!visible) { res.writeHead(404).end(JSON.stringify({ message: "Not Found" })); return; }
      if (api[3]) {
        if (repo.private && bearer !== repo.token) { res.writeHead(403).end(JSON.stringify({ message: "Resource not accessible by personal access token" })); return; }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ sha: "abc" }]));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ full_name: fullName, private: repo.private, default_branch: "main", size: repo.sizeKb ?? 12 }));
      return;
    }
    // git over smart HTTP: /git/<owner>/<name>.git/...
    const git = /^\/git\/([^/]+\/[^/]+)\.git(\/.*)$/.exec(url.pathname);
    const repo = git ? repos[git[1]!] : undefined;
    if (!git || !repo) { res.writeHead(404).end(); return; }
    if (repo.private && auth !== `Basic ${Buffer.from(`x-access-token:${repo.token}`).toString("base64")}`) { res.writeHead(401, { "www-authenticate": "Basic realm=\"GitHub\"" }).end(); return; }
    if (repo.slowMs) await new Promise(resolve => setTimeout(resolve, repo.slowMs));
    const cgi = spawn("git", ["http-backend"], { env: {
      PATH: process.env.PATH ?? "", GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: `/${git[1]}.git${git[2]}`, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: String(req.headers["content-type"] ?? ""), CONTENT_LENGTH: String(body.length), GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""), HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
    } });
    cgi.stdin.end(body);
    const out: Buffer[] = [];
    cgi.stdout.on("data", chunk => out.push(chunk as Buffer));
    cgi.on("close", () => {
      const all = Buffer.concat(out), split = all.indexOf("\r\n\r\n");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of all.subarray(0, split).toString().split("\r\n")) {
        const [name, ...rest] = line.split(":");
        if (name!.toLowerCase() === "status") status = Number(rest.join(":").trim().split(" ")[0]);
        else if (name) headers[name] = rest.join(":").trim();
      }
      res.writeHead(status, headers).end(all.subarray(split + 4));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { api: `${base}/api`, git: `${base}/git`, requests, get limited() { return fake.limited; }, set limited(value) { fake.limited = value; }, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** A fake OpenRouter for the reviewer: it maps every usage it is shown to one task, then writes that task's spec. */
interface FakeReviewer { url: string; prompts: string[]; close: () => Promise<void> }
/**
 * The reviewer's model on OpenRouter. The app's jobs share OpenRouter's URL, so with `others` every
 * request that is not the reviewer's, such as a job's key check and model calls, goes to that fake.
 */
async function fakeReviewer(others?: string): Promise<FakeReviewer> {
  const prompts: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (others && !body.includes("You are OpenMerit Harness")) {
        void fetch(`${others}${req.url ?? ""}`, { method: req.method ?? "GET", headers: Object.fromEntries(Object.entries(req.headers).filter(([name]) => name !== "host" && name !== "content-length").map(([name, value]) => [name, String(value)])), ...(body ? { body } : {}) })
          .then(async answer => { res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" }); res.end(Buffer.from(await answer.arrayBuffer())); })
          .catch(() => { res.writeHead(502).end(); });
        return;
      }
      const parsed = JSON.parse(body) as { stream?: boolean; messages: { content: string | { text?: string }[] }[] };
      const text = parsed.messages.map(message => typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("")).join("\n");
      prompts.push(text);
      const answer = text.includes("map model usages")
        ? { tasks: [{ name: "reply drafter", description: "Drafts a reply to a ticket.", usageIds: [...text.matchAll(/^### (u\d+) model/gm)].map(match => match[1]), usesTools: false, needsVision: false, structuredOutput: false }] }
        : { description: "Drafts the reply to a support ticket.", input: "A customer's support ticket.", steps: [{ description: "Write the reply.", tools: [], access: "none", required: true, after: [] }],
          criteria: ["Answers the customer's question.", "Stays polite."], guardrails: ["Never promises a refund."], system: "You draft replies to support tickets.", user: "{{ticket}}", tools: [],
          output: { kind: "text", labels: [], schemaJson: "" }, examples: [], maxTurns: 0 };
      // Pi prices the call itself from openai/gpt-5-mini's list price: $0.0025 in plus $0.001 out.
      chatAnswer(res, parsed, JSON.stringify(answer), { prompt_tokens: 10_000, completion_tokens: 500 });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, prompts, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("a pasted GitHub URL names its repository; anything else is refused", () => {
  for (const url of ["https://github.com/acme/app", "github.com/acme/app.git", "https://github.com/acme/app/tree/main/src", "git@github.com:acme/app.git", " https://www.github.com/acme/app/ "]) {
    assert.deepEqual(parseRepoUrl(url), { owner: "acme", name: "app" }, url);
  }
  for (const url of ["https://gitlab.com/acme/app", "https://github.com/acme", "https://user:pw@github.com/acme/app", "https://github.com:8443/acme/app", "file:///etc/passwd", "https://github.com/acme/..", "https://github.evil.com/acme/app"]) {
    assert.equal(parseRepoUrl(url), null, url);
  }
});

test("a review stops at its budget: the model calls already made are billed, and the tasks left say why", async () => {
  const reviewer = await fakeReviewer();
  const root = mkdtempSync(join(tmpdir(), "openmerit-budget-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/reply.ts"), 'const MODEL = "openai/gpt-5-mini";\n');
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  try {
    // The mapping call costs $0.0035, past the $0.003 budget, so the task's spec is never asked for.
    const result = await reviewCheckout(root, catalogue, { model: "openai/gpt-5-mini", apiKey: "or-test-key", baseUrl: reviewer.url, budgetUsd: 0.003, timeoutMs: 60_000 });
    assert.equal(reviewer.prompts.length, 1);
    assert.deepEqual(result.tasks, []);
    assert.deepEqual(result.unmapped.map(item => item.reason), ["The review of reply drafter stopped: it reached its $0.00 budget."]);
    assert.ok(Math.abs(result.costUsd - 0.0035) < 1e-9, String(result.costUsd));
  } finally { await reviewer.close(); }
});

describe("GitHub repositories", () => {
  let models: FakeModels, reviewer: FakeReviewer, github: FakeGitHub, app: App, sandboxes: string;
  // Who is signed in with GitHub, as Clerk's getUserOauthAccessToken would answer: user ID to token.
  const signIns = join(mkdtempSync(join(tmpdir(), "openmerit-signins-")), "github.json");
  writeFileSync(signIns, JSON.stringify({ user_ga: GHU }));
  before(async () => {
    const root = mkdtempSync(join(tmpdir(), "openmerit-fake-github-"));
    // A file outside the repository that a symlink in it points to: followed, it would add a model call.
    const outside = join(root, "outside.ts");
    writeFileSync(outside, 'const MODEL = "openai/gpt-5-pro";\n');
    bareRepo(root, "acme/public-app", {
      "src/classify.ts": 'export const MODEL = "openai/gpt-5-mini";\nconst client = new OpenAI({ model: process.env.CLASSIFY_MODEL });\n',
      "src/reply.py": 'reply = client.chat.completions.create(model="anthropic/claude-haiku-5.5", messages=messages)\n',
      "src/leak.ts": `->${outside}`,
      "README.md": "An app.\n",
    });
    bareRepo(root, "acme/private-app", { "app.ts": 'const model = "anthropic/claude-sonnet-5.5";\n' });
    bareRepo(root, "acme/app-private", { "src/route.ts": 'const model = "openai/gpt-5-mini";\n', "tests/route.test.ts": 'const model = "openai/gpt-5";\n' });
    bareRepo(root, "acme/mixed-app", {
      "src/app.ts": 'const MODEL = "openai/gpt-5-mini";\n',
      "src/app.test.ts": 'const MODEL = "openai/gpt-5";\n',
      "tests/replies.test.py": 'model="openai/gpt-5"\nfallback = { model: "anthropic/claude-sonnet-5.5" }\n',
      "examples/demo.ts": 'const demo = { model: "anthropic/claude-haiku-5.5" };\n',
    });
    // Evals Scout wrote: two to import, one copy app.openmerit.ai manages, and one that is not a usable bundle.
    const evalFiles = (task: string) => ({ bundle: JSON.stringify({ ...bundle(task), examples: undefined }), cases: JSON.stringify(Object.entries(TICKETS).slice(0, 3).map(([ticket, queue], index) => ({ id: `example-${index + 1}`, input: { ticket }, expected: queue, origin: "example" }))) });
    bareRepo(root, "acme/evals-app", {
      "src/app.ts": 'const MODEL = "openai/gpt-5.4";\n',
      ".openmerit/evals/ticket-router/bundle.json": evalFiles("ticket router").bundle, ".openmerit/evals/ticket-router/cases.json": evalFiles("ticket router").cases,
      ".openmerit/evals/reply-drafter/bundle.json": evalFiles("reply drafter").bundle, ".openmerit/evals/reply-drafter/cases.json": evalFiles("reply drafter").cases,
      ".openmerit/evals/managed/bundle.json": evalFiles("managed").bundle, ".openmerit/evals/managed/cases.json": evalFiles("managed").cases, ".openmerit/evals/managed/MANAGED.md": "Managed by app.openmerit.ai\n",
      ".openmerit/evals/broken/bundle.json": "{\"task\": 1}", ".openmerit/evals/broken/cases.json": "[]",
    });
    bareRepo(root, "acme/tests-only", { "tests/fixtures/calls.ts": 'export const MODEL = "openai/gpt-5";\n' });
    bareRepo(root, "acme/slow-app", { "app.ts": 'const model = "openai/gpt-5";\n' });
    bareRepo(root, "acme/big-app", { "data.bin": randomBytes(400_000).toString("base64") });
    github = await fakeGitHub({
      "acme/public-app": { private: false },
      "acme/private-app": { private: true, token: TOKEN },
      "acme/app-private": { private: true, token: GHU },
      "acme/slow-app": { private: false, slowMs: 10_000 },
      "acme/mixed-app": { private: false },
      "acme/tests-only": { private: false },
      "acme/evals-app": { private: false },
      "acme/huge-app": { private: false, sizeKb: 300 * 1024 },
      "acme/big-app": { private: false },
    }, root, { [GHU]: [{ id: 7, account: "acme", repos: ["acme/app-private", "acme/public-app"] }] });
    models = await fakeModels();
    reviewer = await fakeReviewer(models.url);
    sandboxes = mkdtempSync(join(tmpdir(), "openmerit-sandboxes-"));
    app = await startApp({ models, env: { OPENMERIT_GITHUB_API_URL: github.api, OPENMERIT_GITHUB_URL: github.git, OPENMERIT_REPO_CLONE_SECONDS: "4", OPENMERIT_REVIEWS_PER_HOUR: "2", TMPDIR: sandboxes, TEST_GITHUB_TOKENS: signIns,
      OPENROUTER_BASE_URL: reviewer.url, OPENMERIT_REVIEWER_MODEL: "openai/gpt-5-mini", PI_OFFLINE: "1" } });
  });
  after(async () => { await stop(app); await models.close(); await reviewer.close(); await github.close(); });
  // Repository reviews need an active plan, as jobs do; every account here has one but org_np and org_lapse.
  before(async () => { for (const org of ["org_gh", "org_gp", "org_rl", "org_mx", "org_gs", "org_lapse", "org_rv", "org_ga"]) await subscribe(app, org); });

  const reviewed = (agent: ReturnType<typeof caller>, id: string) => waitFor(async () => (await agent.api<RepoView[]>("/api/repos")).body.find(repo => repo.id === id)!, repo => repo.review.status === "done" || repo.review.status === "failed", 60_000);

  test("a public repository added by its URL is cloned read-only, its model calls are listed, and the checkout is deleted", async () => {
    const admin = caller(app, "test:user_gh:org_gh:admin");
    const added = await admin.api<RepoView>("/api/repos", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/public-app" }) });
    assert.equal(added.status, 201);
    assert.equal(added.body.fullName, "acme/public-app");
    assert.equal(added.body.private, false);
    assert.equal(added.body.tokenLast4, null);
    assert.ok(["queued", "reviewing"].includes(added.body.review.status));

    const repo = await reviewed(admin, added.body.id);
    assert.equal(repo.review.status, "done", repo.review.error ?? "");
    const result = repo.review.result!;
    assert.equal(result.reviewer, "review");
    assert.equal(result.branch, "main");
    assert.match(result.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(result.tasks.map(task => task.task), ["reply drafter"]);
    const calls = result.modelCalls.map(call => `${call.file}:${call.line} ${call.catalogueId ?? call.value}`);
    assert.ok(calls.includes("src/classify.ts:1 openai/gpt-5-mini"), calls.join("\n"));
    assert.ok(calls.includes("src/reply.py:1 anthropic/claude-haiku-5.5"), calls.join("\n"));
    assert.ok(result.modelCalls.some(call => call.file === "src/classify.ts" && call.line === 2 && call.dynamic && call.envVar === "CLASSIFY_MODEL"));
    // The symlink was checked out as a plain file holding its target's path, so the file it points to was never read.
    assert.ok(!result.modelCalls.some(call => call.file === "src/leak.ts" || call.value.includes("gpt-5-pro")), calls.join("\n"));
    assert.deepEqual(result.models.map(model => model.value).sort(), ["anthropic/claude-haiku-5.5", "openai/gpt-5-mini"]);
    // The checkout is gone.
    assert.equal(readdirSync(sandboxes).filter(name => name.startsWith("openmerit-repo-")).length, 0);
    // Read-only: GitHub saw only GET requests to the API and git's fetch, never a push.
    assert.ok(github.requests.every(request => (request.path.startsWith("/api/") ? request.method === "GET" : !request.path.includes("receive-pack"))));

    // A member lists the repositories but cannot add, review or remove one.
    const member = caller(app, "test:user_gh2:org_gh:member");
    assert.equal((await member.api<RepoView[]>("/api/repos")).body.length, 1);
    assert.equal((await member.api("/api/repos", { method: "POST", body: JSON.stringify({ url: "github.com/acme/public-app" }) })).status, 403);
    assert.equal((await member.api(`/api/repos/${repo.id}`, { method: "DELETE" })).status, 403);
    // Another organization sees none of it.
    assert.deepEqual((await caller(app, "test:user_other:org_other:admin").api("/api/repos")).body, []);

    const again = await admin.api<RepoView>(`/api/repos/${repo.id}/review`, { method: "POST" });
    assert.equal(again.status, 202);
    assert.equal((await reviewed(admin, repo.id)).review.status, "done");
    assert.equal((await admin.api(`/api/repos/${repo.id}`, { method: "DELETE" })).status, 200);
    assert.deepEqual((await admin.api("/api/repos")).body, []);
  });

  test("without an active plan, adding a repository and Review again refuse as jobs do, and nothing reaches GitHub", async () => {
    const before = github.requests.length;
    const planless = caller(app, "test:user_np:org_np:admin");
    const refused = await planless.api<{ error: string }>("/api/repos", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/public-app" }) });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "This account has no active OpenMerit plan. Subscribe at https://app.openmerit.test/plan/, then try again.");
    assert.equal(github.requests.length, before, "no access check, and no clone");
    assert.deepEqual((await planless.api("/api/repos")).body, []);

    // An account whose plan lapses keeps its repositories listed, with their last review, but cannot review them again.
    const lapsing = caller(app, "test:user_lp:org_lapse:admin");
    const added = await lapsing.api<RepoView>("/api/repos", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/public-app" }) });
    assert.equal(added.status, 201);
    assert.equal((await reviewed(lapsing, added.body.id)).review.status, "done");
    const payload = JSON.stringify({ id: "evt_cancel_org_lapse", type: "customer.subscription.deleted", created: Math.floor(Date.now() / 1000) + 60,
      data: { object: { id: "sub_org_lapse", customer: "cus_org_lapse", status: "canceled", metadata: { account_id: "org_lapse" }, items: { data: [{ price: { nickname: "Team", metadata: { included_evals: "50", overage: "refuse" } } }] } } } });
    assert.equal((await fetch(`${app.url}/api/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signStripePayload(payload, "whsec_test") }, body: payload })).status, 200);
    const cloned = github.requests.length;
    const again = await lapsing.api<{ error: string }>(`/api/repos/${added.body.id}/review`, { method: "POST" });
    assert.equal(again.status, 402);
    assert.equal(again.body.error, "This account has no active OpenMerit plan (Stripe says canceled). Subscribe at https://app.openmerit.test/plan/, then try again.");
    assert.equal(github.requests.length, cloned, "nothing was cloned");
    const [kept] = (await lapsing.api<RepoView[]>("/api/repos")).body;
    assert.equal(kept!.fullName, "acme/public-app");
    assert.equal(kept!.review.status, "done");
    assert.ok(kept!.review.result!.modelCalls.length > 0, "the last review is kept");
  });

  test("on an active plan, a review writes task specs from the application's code only, and bills its model calls to the ledger without counting an evaluation", async () => {
    const admin = caller(app, "test:user_rv:org_rv:admin");
    const seen = reviewer.prompts.length;
    const added = await admin.api<RepoView>("/api/repos", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/mixed-app" }) });
    assert.equal(added.status, 201);
    const repo = await reviewed(admin, added.body.id);
    assert.equal(repo.review.status, "done", repo.review.error ?? "");
    const result = repo.review.result!;
    assert.equal(result.reviewer, "review");
    assert.deepEqual(result.unmapped, []);
    const [spec] = result.tasks;
    assert.equal(result.tasks.length, 1);
    assert.equal(spec!.task, "reply drafter");
    assert.deepEqual(spec!.criteria, ["Answers the customer's question.", "Stays polite."]);
    assert.deepEqual(spec!.guardrails, ["Never promises a refund."]);
    assert.equal(spec!.input?.description, "A customer's support ticket.");
    // The spec is tied to the application's calls, src and examples; the reviewer was never shown a test file.
    assert.deepEqual(spec!.codeRefs!.map(ref => `${ref.file}:${ref.line}`).sort(), ["examples/demo.ts:1", "src/app.ts:1"]);
    const prompts = reviewer.prompts.slice(seen);
    assert.equal(prompts.length, 2, "one mapping call and one spec");
    assert.ok(prompts.every(prompt => !prompt.includes("app.test.ts") && !prompt.includes("tests/replies")), "no test file reached the reviewer");
    // Two calls at $0.0035 each, settled as OpenMerit-paid spend; a review is not one of the plan's evaluations.
    assert.ok(Math.abs(result.costUsd - 0.007) < 1e-9, String(result.costUsd));
    const spend = await admin.api<{ openmeritUsd: number }>("/api/spend");
    assert.ok(Math.abs(spend.body.openmeritUsd - 0.007) < 1e-9, String(spend.body.openmeritUsd));
    assert.equal((await admin.api<{ plan: { usedEvals: number } }>("/api/me")).body.plan.usedEvals, 0);
    const exported = await admin.api<{ ledger: { key: string; status: string; actual_usd: number }[] }>("/api/account/export", { method: "POST" });
    assert.deepEqual(exported.body.ledger.map(row => [row.key.split("/")[0], row.status]), [["review", "settled"]]);
  });

  test("a repository belongs to one project, and a coding agent's call from it lands in that project", async () => {
    const admin = caller(app, "test:user_pp:org_pp:admin");
    const project = await admin.api<{ id: string; repos: string[] }>("/api/projects", { method: "POST", body: JSON.stringify({ name: "Support bot" }) });
    assert.equal(project.status, 201);
    await subscribe(app, "org_pp");
    const inProject = { "x-openmerit-project": project.body.id };
    const added = await admin.api<RepoView>("/api/repos", { method: "POST", headers: inProject, body: JSON.stringify({ url: "https://github.com/acme/mixed-app" }) });
    assert.equal(added.status, 201);
    assert.equal((await waitFor(async () => (await admin.api<RepoView[]>("/api/repos", { headers: inProject })).body[0]!, repo => repo.review.status === "done" || repo.review.status === "failed", 60_000)).review.status, "done");
    assert.deepEqual((await admin.api("/api/repos")).body, [], "the default project does not list another project's repository");
    const twice = await admin.api<{ error: string }>("/api/repos", { method: "POST", body: JSON.stringify({ url: "https://github.com/Acme/Mixed-App" }) });
    assert.equal(twice.status, 400);
    assert.match(twice.body.error, /already in the project Support bot/);
    assert.deepEqual((await admin.api<{ name: string; repos: string[] }[]>("/api/projects")).body.map(item => [item.name, item.repos]), [["Default project", []], ["Support bot", ["acme/mixed-app"]]]);

    const started = await admin.tool("openmerit_recommend", { bundle: bundle(), environment: "acme/mixed-app" });
    assert.equal(started.isError, false, started.text);
    const tasks = await admin.api<{ id: string; projectId: string }[]>("/api/tasks", { headers: inProject });
    assert.deepEqual(tasks.body.map(task => task.projectId), [project.body.id]);
    assert.deepEqual((await admin.api("/api/tasks")).body, [], "the task is not in the default project");
    assert.equal((await admin.api<unknown[]>("/api/runs", { headers: inProject })).body.length, 1);
    // The run stops at its label check; waiting for it keeps it from calling the fakes after the suite.
    await waitFor(() => admin.tool("openmerit_result", { job_id: started.data.job_id }), value => value.data.status !== "queued" && value.data.status !== "running");
  });

  test("a review offers the repository's evals as drafts; approving one creates the task, not run yet, with the draft as its eval", async () => {
    const admin = caller(app, "test:user_ev:org_ev:admin");
    const member = caller(app, "test:user_ev2:org_ev:member");
    await subscribe(app, "org_ev");
    const added = await admin.api<RepoView>("/api/repos", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/evals-app" }) });
    assert.equal((await reviewed(admin, added.body.id)).review.status, "done");
    const drafts = (await member.api<{ id: string; name: string; environment: string; cases: unknown[]; bundle: { criteria?: string[] } }[]>("/api/eval-drafts")).body;
    assert.deepEqual(drafts.map(draft => [draft.name, draft.environment, draft.cases.length]).sort(), [["reply drafter", "acme/evals-app", 3], ["ticket router", "acme/evals-app", 3]], "the managed copy and the broken eval are not offered");

    // A member approves one with an edit; the task waits for its first run.
    const router = drafts.find(draft => draft.name === "ticket router")!;
    const approved = await member.api<{ taskId: string }>(`/api/eval-drafts/${router.id}/approve`, { method: "POST", body: JSON.stringify({ spec: { criteria: ["Picks the queue that owns the ticket"] } }) });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal((await member.api(`/api/eval-drafts/${router.id}/approve`, { method: "POST" })).status, 409);
    const [task] = (await admin.api<{ id: string; name: string; lastRunAt: string | null; status: string; eval: unknown }[]>("/api/tasks")).body;
    assert.deepEqual([task!.id, task!.name, task!.lastRunAt, task!.status], [approved.body.taskId, "ticket router", null, "new"]);
    const evaluation = (await admin.api<EvalView>(`/api/tasks/${task!.id}/eval`)).body;
    assert.deepEqual([evaluation.latest!.version, evaluation.latest!.source, evaluation.latest!.author, evaluation.latest!.spec.criteria], [1, "review", "user_ev2", ["Picks the queue that owns the ticket"]]);
    assert.match((await admin.tool("openmerit_tasks", {})).text, /ticket router \[t_\w+\] \(acme\/evals-app\): openai\/gpt-5.4, not run yet/);

    // Dismissed and approved drafts are not offered again by the next review.
    assert.equal((await member.api(`/api/eval-drafts/${drafts.find(draft => draft.name === "reply drafter")!.id}`, { method: "DELETE" })).status, 200);
    await admin.api(`/api/repos/${added.body.id}/review`, { method: "POST" });
    assert.equal((await reviewed(admin, added.body.id)).review.status, "done");
    assert.deepEqual((await member.api("/api/eval-drafts")).body, []);

    // Its first run measures on the approved eval and writes no cases.
    const writerCalls = models.calls.filter(call => call.ticket.startsWith("writer:")).length;
    const run = await admin.api<{ jobId: string }>(`/api/tasks/${task!.id}/run`, { method: "POST" });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    const ran = await waitFor(async () => (await admin.api<{ id: string; evalVersion: number | null }[]>("/api/runs")).body.find(item => item.id === run.body.jobId), item => item?.evalVersion !== null && item?.evalVersion !== undefined, 60_000);
    assert.equal(ran!.evalVersion, 1);
    // The approved cases all have answers, so the run asks nothing; with three cases it ends before screening candidates.
    const finished = await waitFor(() => admin.tool("openmerit_result", { job_id: run.body.jobId }), value => value.data.status !== "queued" && value.data.status !== "running");
    assert.notEqual(finished.data.status, "needs_input", finished.text);
    assert.match(finished.text, /Current model openai\/gpt-5\.4: 3\/3 cases passed/);
    assert.equal(models.calls.filter(call => call.ticket.startsWith("writer:")).length, writerCalls);

    // Retire instead of delete keeps the eval.
    const retired = await member.api<{ state: string }>(`/api/tasks/${task!.id}/retire`, { method: "POST" });
    assert.equal(retired.body.state, "retired");
    assert.equal((await admin.api<EvalView>(`/api/tasks/${task!.id}/eval`)).body.latest!.version, 1);
  });

  test("only the application's model calls are listed: examples stay, tests, fixtures and docs are counted apart", async () => {
    const admin = caller(app, "test:user_mx:org_mx:admin");
    const add = async (url: string) => {
      const added = await admin.api<RepoView>("/api/repos", { method: "POST", body: JSON.stringify({ url }) });
      assert.equal(added.status, 201);
      const repo = await reviewed(admin, added.body.id);
      assert.equal(repo.review.status, "done", repo.review.error ?? "");
      return repo.review.result!;
    };
    const mixed = await add("https://github.com/acme/mixed-app");
    assert.deepEqual(mixed.modelCalls.map(call => `${call.file}:${call.line} ${call.value}`), ["examples/demo.ts:1 anthropic/claude-haiku-5.5", "src/app.ts:1 openai/gpt-5-mini"]);
    assert.equal(mixed.totalCalls, 2);
    assert.equal(mixed.supportCalls, 3);
    assert.equal(mixed.notListed, "3 more in tests, fixtures or docs, not listed");
    // gpt-5 and claude-sonnet-5.5 appear only in tests, so they are not among the repository's models.
    assert.deepEqual(mixed.models.map(model => `${model.value} ×${model.calls}`).sort(), ["anthropic/claude-haiku-5.5 ×1", "openai/gpt-5-mini ×1"]);
    const testsOnly = await add("https://github.com/acme/tests-only");
    assert.deepEqual(testsOnly.modelCalls, []);
    assert.deepEqual(testsOnly.models, []);
    assert.equal(testsOnly.totalCalls, 0);
    assert.equal(testsOnly.notListed, "1 more in tests, fixtures or docs, not listed");
  });

  test("a member signed in with GitHub picks a repository an installation of the GitHub App gives them, and adds it without a token", async () => {
    const admin = caller(app, "test:user_ga:org_ga:admin");
    const listed = await admin.api<{ app: string; installUrl: string; signedIn: boolean; installations: { id: number; account: string; repos: { fullName: string; private: boolean }[] }[]; error: string | null }>("/api/github");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.installUrl, "https://github.com/apps/openmeritai/installations/new");
    assert.equal(listed.body.signedIn, true);
    assert.deepEqual(listed.body.installations.map(item => [item.id, item.account, item.repos.map(repo => `${repo.fullName}${repo.private ? " (private)" : ""}`)]), [[7, "acme", ["acme/app-private (private)", "acme/public-app"]]]);
    // A member without a GitHub sign-in gets the install link and nothing from GitHub.
    const before = github.requests.length;
    const other = await caller(app, "test:user_gb:org_ga:admin").api<{ signedIn: boolean; installations: unknown[] }>("/api/github");
    assert.deepEqual([other.body.signedIn, other.body.installations], [false, []]);
    assert.equal((await caller(app, "test:user_gb:org_ga:admin").api<{ error: string }>("/api/repos", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/app-private", via: "github" }) })).body.error,
      "Your OpenMerit sign-in has no GitHub account. Sign in with GitHub, or add the repository with a fine-grained token.");
    assert.equal(github.requests.length, before, "no GitHub call without a GitHub sign-in");

    const added = await admin.api<RepoView & { error: string }>("/api/repos", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/app-private", via: "github" }) });
    assert.equal(added.status, 201, added.body.error);
    assert.deepEqual([added.body.private, added.body.access, added.body.githubUser, added.body.tokenLast4], [true, "github", "user_ga", null]);
    const repo = await reviewed(admin, added.body.id);
    assert.equal(repo.review.status, "done", repo.review.error ?? "");
    // Only the application's call is listed; the test's is counted apart.
    assert.deepEqual(repo.review.result!.modelCalls.map(call => `${call.file}:${call.line}`), ["src/route.ts:1"]);
    assert.equal(repo.review.result!.supportCalls, 1);
    // git sent the user's token to GitHub in its header; OpenMerit stored no token, and no listing or export carries it.
    assert.ok(github.requests.some(request => request.path.startsWith("/git/acme/app-private") && request.auth === `Basic ${Buffer.from(`x-access-token:${GHU}`).toString("base64")}`));
    assert.ok(!JSON.stringify((await admin.api("/api/repos")).body).includes(GHU));
    assert.ok(!JSON.stringify((await admin.api("/api/account/export", { method: "POST" })).body).includes(GHU));
    // A repository the installation does not give the user says what to do.
    assert.match((await admin.api<{ error: string }>("/api/repos", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/private-app", via: "github" }) })).body.error,
      /The OpenMerit GitHub App cannot see acme\/private-app for you\. Install it/);

    // Once the member unlinks GitHub, Review again fails and says how to add it back; the last review is kept.
    writeFileSync(signIns, JSON.stringify({}));
    const again = await admin.api<RepoView>(`/api/repos/${repo.id}/review`, { method: "POST" });
    assert.equal(again.status, 202);
    const failed = await reviewed(admin, repo.id);
    assert.equal(failed.review.status, "failed");
    assert.match(failed.review.error ?? "", /no longer has a GitHub account on OpenMerit\. Add it again/);
    assert.ok(failed.review.result!.modelCalls.length > 0);
    writeFileSync(signIns, JSON.stringify({ user_ga: GHU }));
  });

  test("a private repository needs a fine-grained token that can read its contents, which is stored encrypted and sent only to GitHub", async () => {
    const admin = caller(app, "test:user_gp:org_gp:admin");
    const add = (body: object) => admin.api<RepoView & { error: string }>("/api/repos", { method: "POST", body: JSON.stringify(body) });
    assert.match((await add({ url: "https://github.com/acme/private-app" })).body.error, /no public repository acme\/private-app.*fine-grained token/);
    assert.match((await add({ url: "https://github.com/acme/private-app", token: `ghp_${"C".repeat(36)}` })).body.error, /classic token/);
    assert.match((await add({ url: "https://github.com/acme/private-app", token: "hunter2-not-a-token" })).body.error, /github_pat_/);
    assert.match((await add({ url: "https://github.com/acme/private-app", token: `github_pat_${"D".repeat(30)}` })).body.error, /cannot see acme\/private-app/);
    assert.match((await add({ url: "https://github.com/acme/private-app", token: NO_CONTENTS })).body.error, /not read its code.*Contents: Read-only/);
    assert.match((await add({ url: "https://github.com/acme/huge-app" })).body.error, /300 MB on GitHub, more than the 200 MB/);
    assert.match((await add({ url: "https://gitlab.com/acme/app" })).body.error, /GitHub URL/);

    const added = await add({ url: "https://github.com/acme/private-app", token: TOKEN });
    assert.equal(added.status, 201, added.body.error);
    assert.equal(added.body.private, true);
    assert.equal(added.body.tokenLast4, "good");
    const repo = await reviewed(admin, added.body.id);
    assert.equal(repo.review.status, "done", repo.review.error ?? "");
    assert.deepEqual(repo.review.result!.models.map(model => model.value), ["anthropic/claude-sonnet-5.5"]);
    // git sent the token to the fake GitHub, and no listing or export carries it.
    assert.ok(github.requests.some(request => request.path.startsWith("/git/acme/private-app") && request.auth.startsWith("Basic ")));
    for (const path of ["/api/repos"]) assert.ok(!JSON.stringify((await admin.api(path)).body).includes(TOKEN));
    const exported = await admin.api<{ repos: RepoView[] }>("/api/account/export", { method: "POST" });
    assert.equal(exported.body.repos[0]!.fullName, "acme/private-app");
    assert.ok(!JSON.stringify(exported.body).includes(TOKEN));
  });

  test("a checkout holds a symlink as a plain file and no .git directory, and a clone that grows past the size limit stops", async () => {
    const config: GitHubConfig = { apiUrl: github.api, gitUrl: github.git, maxBytes: 200 * 1024 * 1024, cloneTimeoutMs: 20_000, appSlug: null };
    let seen = "";
    await withCheckout({ fullName: "acme/public-app", branch: "main", token: null, config }, async checkout => {
      seen = checkout.root;
      assert.equal(lstatSync(join(checkout.root, "src/leak.ts")).isSymbolicLink(), false);
      assert.match(readFileSync(join(checkout.root, "src/leak.ts"), "utf8"), /outside\.ts$/);
      assert.equal(existsSync(join(checkout.root, ".git")), false);
    });
    assert.equal(existsSync(seen), false);
    await assert.rejects(withCheckout({ fullName: "acme/big-app", branch: "main", token: null, config: { ...config, maxBytes: 300_000 } }, async () => assert.fail("the clone should stop")), /Cloning acme\/big-app failed: grew past/);
  });

  test("when GitHub's limit for checks without a token is used up, adding a repository says when to try again, counts no review, and Review again still clones", async () => {
    const admin = caller(app, "test:user_rl:org_rl:admin");
    const add = () => admin.api<RepoView & { error: string }>("/api/repos", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/public-app" }) });
    const added = await add();
    assert.equal(added.status, 201);
    assert.equal((await reviewed(admin, added.body.id)).review.status, "done");
    // 14:05 UTC: GitHub answers 403 or 429 with the reset time in x-ratelimit-reset.
    const reset = Math.floor(Date.UTC(2026, 10, 24, 14, 5, 0) / 1000);
    for (const status of [403, 429] as const) {
      github.limited = { status, reset };
      for (let attempt = 0; attempt < 3; attempt++) {
        const refused = await add();
        assert.equal(refused.status, 400, `a ${status} is the add form's own error, not a generic one`);
        assert.equal(refused.body.error, "GitHub's limit for checks without a token is used up; try again after 14:05 UTC.");
      }
    }
    // Review again clones over git, which this limit does not cover. The six refused checks counted no review:
    // the account's limit here is 2 an hour, and the add above was the first.
    const again = await admin.api<RepoView & { error: string }>(`/api/repos/${added.body.id}/review`, { method: "POST" });
    assert.equal(again.status, 202, again.body.error);
    assert.equal((await reviewed(admin, added.body.id)).review.status, "done");
    github.limited = null;
  });

  test("a clone that runs past its time limit fails the review and leaves no checkout behind", async () => {
    const admin = caller(app, "test:user_gs:org_gs:admin");
    const added = await admin.api<RepoView>("/api/repos", { method: "POST", body: JSON.stringify({ url: "https://github.com/acme/slow-app" }) });
    assert.equal(added.status, 201);
    const repo = await reviewed(admin, added.body.id);
    assert.equal(repo.review.status, "failed");
    assert.match(repo.review.error ?? "", /Cloning acme\/slow-app failed: took longer than 4 s/);
    assert.equal(repo.review.result, null);
    assert.equal(readdirSync(sandboxes).filter(name => name.startsWith("openmerit-repo-")).length, 0);
  });
});
