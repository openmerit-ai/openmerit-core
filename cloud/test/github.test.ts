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
import type { RepoView } from "../src/actors/account.ts";
import { parseRepoUrl, withCheckout, type GitHubConfig } from "../src/github.ts";
import { caller, fakeModels, startApp, stop, waitFor, type App, type FakeModels } from "./helpers.ts";

const TOKEN = `github_pat_${"A".repeat(30)}_good`;
const NO_CONTENTS = `github_pat_${"B".repeat(30)}_meta`;

interface FakeRepo { private: boolean; token?: string; sizeKb?: number; slowMs?: number }
interface FakeGitHub { api: string; git: string; requests: { method: string; path: string; auth: string }[]; close: () => Promise<void> }

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

async function fakeGitHub(repos: Record<string, FakeRepo>, root: string): Promise<FakeGitHub> {
  const requests: FakeGitHub["requests"] = [];
  const read = (req: IncomingMessage) => new Promise<Buffer>(resolve => { const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk as Buffer)); req.on("end", () => resolve(Buffer.concat(chunks))); });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const auth = String(req.headers.authorization ?? "");
    requests.push({ method: req.method ?? "GET", path: url.pathname, auth });
    const body = await read(req);
    const api = /^\/api\/repos\/([^/]+)\/([^/]+)(\/commits)?$/.exec(url.pathname);
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
  return { api: `${base}/api`, git: `${base}/git`, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("a pasted GitHub URL names its repository; anything else is refused", () => {
  for (const url of ["https://github.com/acme/app", "github.com/acme/app.git", "https://github.com/acme/app/tree/main/src", "git@github.com:acme/app.git", " https://www.github.com/acme/app/ "]) {
    assert.deepEqual(parseRepoUrl(url), { owner: "acme", name: "app" }, url);
  }
  for (const url of ["https://gitlab.com/acme/app", "https://github.com/acme", "https://user:pw@github.com/acme/app", "https://github.com:8443/acme/app", "file:///etc/passwd", "https://github.com/acme/..", "https://github.evil.com/acme/app"]) {
    assert.equal(parseRepoUrl(url), null, url);
  }
});

describe("GitHub repositories", () => {
  let models: FakeModels, github: FakeGitHub, app: App, sandboxes: string;
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
    bareRepo(root, "acme/slow-app", { "app.ts": 'const model = "openai/gpt-5";\n' });
    bareRepo(root, "acme/big-app", { "data.bin": randomBytes(400_000).toString("base64") });
    github = await fakeGitHub({
      "acme/public-app": { private: false },
      "acme/private-app": { private: true, token: TOKEN },
      "acme/slow-app": { private: false, slowMs: 10_000 },
      "acme/huge-app": { private: false, sizeKb: 300 * 1024 },
      "acme/big-app": { private: false },
    }, root);
    models = await fakeModels();
    sandboxes = mkdtempSync(join(tmpdir(), "openmerit-sandboxes-"));
    app = await startApp({ models, env: { OPENMERIT_GITHUB_API_URL: github.api, OPENMERIT_GITHUB_URL: github.git, OPENMERIT_REPO_CLONE_SECONDS: "4", TMPDIR: sandboxes } });
  });
  after(async () => { await stop(app); await models.close(); await github.close(); });

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
    assert.equal(result.reviewer, "scan");
    assert.equal(result.branch, "main");
    assert.match(result.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(result.tasks, []);
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
    const config: GitHubConfig = { apiUrl: github.api, gitUrl: github.git, maxBytes: 200 * 1024 * 1024, cloneTimeoutMs: 20_000 };
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
