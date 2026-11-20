// The Python scripts the Viktor connection runs in the workspace sandbox, with Viktor's own SDK.
// Each takes its inputs as arguments and prints one JSON line. Only BATCH needs an agent thread to
// run it, since `test_cron_as_subagent` fails without a parent thread; it writes its progress to a
// file that READ, a plain script run, reads back. A script run returns at most 64,000 characters of
// stdout, so a script whose output grows with the workspace (LIST, READ, DESCRIBE) runs through the
// client's `runScriptPaged`, which writes its stdout to a file and reads it back in PAGE-sized pieces.

/** Where OpenMerit's temporary copies live, and the title each starts with. CLEANUP deletes only tasks that match both. */
export const COPY_PATH = "/openmerit/";
export const COPY_TITLE = "OpenMerit: ";
/** Each job's files in the sandbox. */
export const WORK_DIR = "/work/temp/openmerit";

/**
 * Every task with the start of its instructions (list_crons' preview, not the full text: an evaluation
 * reads that with DESCRIBE), credits per task over 30 days from the usage threads, and leftover copies.
 */
export const LIST = String.raw`# openmerit:list
import asyncio, json
from sdk.tools.scheduled_crons import list_crons
from sdk.tools.account_tools import get_usage_threads
async def main():
    crons = (await list_crons()).crons
    tasks = []
    for c in crons:
        d = c.model_dump()
        d.pop("threads", None)
        tasks.append(d)
    usage = []
    for page in range(1, 5):
        r = await get_usage_threads(period="last_30_days", thread_type="cron", order="most_credits", page=page, limit=50)
        rows = r.threads if isinstance(r.threads, list) else []
        usage += [{"credits": t.get("credits"), "path": t.get("agent_runs_path"), "title": t.get("title")} for t in rows if isinstance(t, dict)]
        if len(rows) < 50: break
    print(json.dumps({"tasks": tasks, "usage": usage}, default=str))
asyncio.run(main())
`;

/** One task's full instructions, for the judge: {"description": "..."}. */
export const DESCRIBE = String.raw`# openmerit:describe
import asyncio, json, sys
from sdk.tools.thread_orchestration_tools import get_path_info
async def main():
    info = (await get_path_info(path=sys.argv[1])).info
    cron = info.cron if isinstance(info.cron, dict) else info.cron.model_dump()
    print(json.dumps({"description": cron.get("description") or ""}, default=str))
asyncio.run(main())
`;

/**
 * A piece of a paged script's output file: its size in bytes on the first line, then the bytes from
 * argv[2] for argv[3] bytes, in base64, so nothing in them is changed on the way. Deletes the file
 * after its last piece.
 */
export const PAGE = String.raw`# openmerit:page
import base64, os, sys
p, off, n = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
d = open(p, "rb").read()
sys.stdout.write(str(len(d)) + "\n" + base64.b64encode(d[off:off + n]).decode())
if off + n >= len(d): os.remove(p)
`;

/** Writes BATCH and its spec into the job's directory, so the agent thread runs exactly this code. */
export const PUT = String.raw`# openmerit:put
import json, os, sys
directory, source, spec = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(directory, exist_ok=True)
open(os.path.join(directory, "batch.py"), "w").write(source)
open(os.path.join(directory, "spec.json"), "w").write(spec)
print(json.dumps({"ok": True}))
`;

/**
 * Makes a personal, paused copy of the task for each model, tests each copy \`repeats\` times in test
 * mode, writes every run to the spec's \`out\` file as it finishes, and deletes the copies at the end,
 * whatever happened.
 */
export const BATCH = String.raw`# openmerit:batch
import asyncio, json, os, sys, time, traceback
from sdk.tools.scheduled_crons import create_agent_cron, pause_cron, delete_cron, test_cron_as_subagent
from sdk.tools.thread_orchestration_tools import get_path_info
SPEC = json.load(open(sys.argv[1]))
OUT = SPEC["out"]
def save(state):
    tmp = OUT + ".tmp"
    json.dump(state, open(tmp, "w"), default=str)
    os.replace(tmp, OUT)
async def one(path, model, repeat, sem, state):
    async with sem:
        started = time.time()
        try:
            r = await test_cron_as_subagent(path=path, wait=True, timeout_minutes=SPEC["timeoutMinutes"])
            sub = r.subagent
            state["runs"].append({"model": model, "repeat": repeat, "status": r.status, "error": r.error, "report": r.report, "runModel": sub.model if sub else None,
                "threadId": sub.thread_id if sub else None, "actions": [a.model_dump() for a in r.captured_external_actions], "seconds": time.time() - started})
        except Exception as e:
            state["runs"].append({"model": model, "repeat": repeat, "status": "error", "error": f"{type(e).__name__}: {e}"[:2000], "seconds": time.time() - started})
        save(state)
async def main():
    state = {"status": "running", "runs": [], "copies": [], "started": time.time()}
    save(state)
    try:
        info = (await get_path_info(path=SPEC["source"])).info
        cron = info.cron if isinstance(info.cron, dict) else info.cron.model_dump()
        for model in SPEC["models"]:
            path = SPEC["copyPath"] + model
            await create_agent_cron(path=path, title=SPEC["copyTitle"], description=cron["description"], cron=cron["cron"], model=model, personal=True,
                timezone=cron.get("timezone"), expected_output_channel_ids=cron.get("expected_output_channel_ids") or None)
            state["copies"].append(path)
            await pause_cron(path=path)
            save(state)
        sem = asyncio.Semaphore(SPEC["parallel"])
        await asyncio.gather(*[one(SPEC["copyPath"] + m, m, r, sem, state) for r in range(1, SPEC["repeats"] + 1) for m in SPEC["models"]])
        state["status"] = "done"
    except Exception:
        state["status"] = "failed"
        state["error"] = traceback.format_exc()[-2000:]
    finally:
        for path in state["copies"]:
            try: await delete_cron(path=path)
            except Exception as e: state.setdefault("cleanupErrors", []).append(f"{path}: {e}")
        state["finished"] = time.time()
        save(state)
asyncio.run(main())
`;

/** Prints the batch's progress file, or {"status": "missing"} before it exists. */
export const READ = String.raw`# openmerit:read
import json, os, sys
p = sys.argv[1]
print(open(p).read() if os.path.exists(p) else json.dumps({"status": "missing"}))
`;

/** Credits per thread, for the threads named in argv[1] (a JSON list), from the last 7 days of usage. */
export const CREDITS = String.raw`# openmerit:credits
import asyncio, json, sys
from sdk.tools.account_tools import get_usage_threads
async def main():
    wanted = set(json.loads(sys.argv[1]))
    found = {}
    for page in range(1, 9):
        r = await get_usage_threads(period="last_7_days", thread_type="all", order="last_created", page=page, limit=50)
        rows = r.threads if isinstance(r.threads, list) else []
        for t in rows:
            if isinstance(t, dict) and t.get("thread_id") in wanted: found[t["thread_id"]] = t.get("credits")
        if len(rows) < 50 or wanted <= set(found): break
    print(json.dumps({"credits": found}))
asyncio.run(main())
`;

/**
 * Deletes OpenMerit's copies whose path starts with argv[1] (always under COPY_PATH) and whose title
 * starts with COPY_TITLE, and the directory argv[2] when given. Nothing else is touched.
 */
export const CLEANUP = String.raw`# openmerit:cleanup
import asyncio, json, os, shutil, sys
from sdk.tools.scheduled_crons import list_crons, delete_cron
PREFIX, TITLE = sys.argv[1], "${COPY_TITLE}"
async def main():
    assert PREFIX.startswith("${COPY_PATH}")
    deleted, errors = [], []
    for c in (await list_crons()).crons:
        if c.path.startswith(PREFIX) and (c.title or "").startswith(TITLE):
            try:
                await delete_cron(path=c.path); deleted.append(c.path)
            except Exception as e:
                errors.append(f"{c.path}: {e}")
    if len(sys.argv) > 2 and sys.argv[2].startswith("${WORK_DIR}/"):
        shutil.rmtree(sys.argv[2], ignore_errors=True)
    print(json.dumps({"deleted": deleted, "errors": errors}))
asyncio.run(main())
`;
