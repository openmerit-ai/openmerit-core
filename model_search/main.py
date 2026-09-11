#!/usr/bin/env python3
"""Lean model-search loop over OpenRouter.

Flow: task T + eval E -> run model M -> judge scores output -> strategist LLM
picks the next untried model from the live /models catalog (reasoning about
which benchmarks matter for the task) -> repeat -> pareto frontier on
(score vs price) -> report best fit + fallback.

Usage: python3 main.py <task.json> [--rounds 5]
Task JSON keys: task, eval, initial_model, (optional) judge_model,
strategist_model, max_usd_per_m.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

OR = "https://openrouter.ai/api/v1"
HERE = os.path.dirname(os.path.abspath(__file__))

JUDGE_PREFS = ["openai/gpt-4o-mini", "openai/gpt-4o"]
STRAT_PREFS = ["anthropic/claude-3.7-sonnet", "anthropic/claude-3.5-sonnet", "openai/gpt-4o"]
DEFAULT_MAX_PRICE = 20.0  # blended $ per 1M tokens

JUDGE_PROMPT = """You are grading a model's answer.
TASK: {task}
RUBRIC: {rubric}
ANSWER: {answer}
Return ONLY json: {{"score": <0..1>, "why": "<one line>"}}"""

STRAT_PROMPT = """We are finding the best OpenRouter model for a task via iterative trials.
TASK: {task}
RUBRIC: {rubric}
RESULTS SO FAR (model=score): {results}
Pick ONE untried model from the catalog below that is likely to do well on this
task, based on the benchmarks relevant to it (e.g. HumanEval/SWE-bench for
code, MMLU/GPQA for knowledge, MATH for math, IFEval for instruction following,
MMMU for multimodal). Balance quality against price so a pareto frontier emerges.
Return ONLY json: {{"next_model": "<catalog id>", "why": "<one line>"}}
CATALOG (id | blended $/1M tokens | ctx):
{catalog}"""


def load_key():
    p = os.path.join(HERE, ".env")
    if os.path.exists(p):
        for line in open(p):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("missing OPENROUTER_API_KEY (set it in env or model_search/.env)")
    return key


def _request(key, path, body=None, tries=3):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": "Bearer %s" % key}
    if data is not None:
        headers["Content-Type"] = "application/json"
        headers["X-Title"] = "model-search"
    for attempt in range(tries):
        req = urllib.request.Request(OR + path, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:400]
            if e.code in (429, 500, 502, 503) and attempt < tries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError("OpenRouter HTTP %s: %s" % (e.code, detail))


def chat(key, model, prompt, max_tokens, temperature):
    r = _request(key, "/chat/completions", {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
    })
    return r["choices"][0]["message"]["content"], r.get("usage") or {}


def fetch_catalog(key):
    raw = _request(key, "/models")
    cat = {}
    for m in raw.get("data", []):
        mid = m.get("id", "")
        if mid.startswith("openrouter/"):
            continue  # skip meta-router entries
        p = m.get("pricing") or {}
        try:
            pp = float(p.get("prompt") or 0)
            pc = float(p.get("completion") or 0)
        except (TypeError, ValueError):
            pp = pc = 0.0
        if pp < 0 or pc < 0:
            continue  # skip bogus/unknown pricing
        cat[mid] = {
            "id": m["id"],
            "name": m.get("name", m["id"]),
            "ctx": m.get("context_length") or 0,
            "pp": pp,  # $/token prompt
            "pc": pc,  # $/token completion
            "price": round((pp + pc) / 2 * 1e6, 4),  # blended $/1M tokens
        }
    return cat


def resolve(cat, prefs, label):
    for p in prefs:
        if p in cat:
            return p
    for p in prefs:
        for cid in sorted(cat):
            if p in cid:
                return cid
    sys.exit("could not resolve %s model from preferences %s" % (label, prefs))


def parse_obj(txt):
    m = re.search(r"\{.*\}", txt, re.S)
    if not m:
        m = re.search(r"\{[^}]*\}", txt, re.S)
    if not m:
        raise ValueError("no json object found")
    return json.loads(m.group(0))


def run_trial(key, task, rubric, judge, model, cat):
    try:
        gen, usage = chat(key, model, task, 4096, 0.2)
    except Exception as e:
        return {"model": model, "error": str(e)}
    jtxt, _ = chat(key, judge, JUDGE_PROMPT.format(
        task=task, rubric=rubric, answer=str(gen)[:16000]), 1024, 0)
    try:
        j = parse_obj(jtxt)
        score, why = float(j.get("score", 0)), j.get("why", "")
    except Exception:
        score, why = 0.0, "unparseable judge output"
    entry = cat.get(model, {})
    est_cost = (entry.get("pp", 0) * usage.get("prompt_tokens", 0)
                + entry.get("pc", 0) * usage.get("completion_tokens", 0))
    return {
        "model": model,
        "score": score,
        "why": why,
        "price": entry.get("price"),
        "est_cost": est_cost,
        "tokens": usage.get("total_tokens"),
        "output": gen,
    }


def pick_next(key, strat, task, rubric, results, cat, tried, max_price, failed_vendors):
    def ok(c):
        return (c["price"] <= max_price and c["id"] not in tried
                and c["ctx"] >= 4096 and c["id"].split("/")[0] not in failed_vendors)
    lines = [f"{c['id']} | {c['price']:.2f} | {c['ctx']}"
             for c in sorted(cat.values(), key=lambda c: c["price"]) if ok(c)]
    res = "  ".join(("%s=FAIL" % r["model"]) if "error" in r else ("%s=%.2f" % (r["model"], r["score"]))
                     for r in results) or "none yet"
    txt, _ = chat(key, strat, STRAT_PROMPT.format(
        task=task, rubric=rubric, results=res, catalog="\n".join(lines)), 1024, 0.2)
    try:
        obj = parse_obj(txt)
        pick, why = obj.get("next_model"), obj.get("why", "")
    except Exception:
        pick, why = None, "unparseable strategist output"
    if pick not in cat or pick in tried or not ok(cat[pick]):
        pool = [c for c in cat.values() if ok(c)]
        if not pool:
            return None, "exhausted catalog"
        print("    (strategist pick %r unusable; taking cheapest untried)" % (pick,))
        pick = min(pool, key=lambda c: (c["price"], -c["ctx"]))["id"]
        why = "fallback pick: cheapest untried"
    return pick, why


def frontier(points):
    pts = sorted(points, key=lambda p: (p["price"], -p["score"]))
    fr, best = [], -1
    for p in pts:
        if p["score"] > best:
            fr.append(p)
            best = p["score"]
    return fr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("task_file")
    ap.add_argument("--rounds", type=int, default=5)
    a = ap.parse_args()

    cfg = json.loads(open(a.task_file).read())
    task, rubric = cfg["task"], cfg["eval"]
    max_price = float(cfg.get("max_usd_per_m", DEFAULT_MAX_PRICE))
    key = load_key()

    print("fetching OpenRouter catalog...")
    cat = fetch_catalog(key)
    print("catalog: %d models" % len(cat))

    judge = resolve(cat, [cfg.get("judge_model")] + JUDGE_PREFS if cfg.get("judge_model") else JUDGE_PREFS, "judge")
    strat = resolve(cat, [cfg.get("strategist_model")] + STRAT_PREFS if cfg.get("strategist_model") else STRAT_PREFS, "strategist")
    print("judge: %s | strategist: %s" % (judge, strat))

    tried, results, failed_vendors = set(), [], set()
    for i in range(a.rounds):
        if i == 0:
            model, reason = cfg["initial_model"], "initial model"
        else:
            model, reason = pick_next(key, strat, task, rubric, results, cat, tried,
                                      max_price, failed_vendors)
            if model is None:
                break
        if model in tried:
            break
        print("[round %d/%d] %s (%s) ..." % (i + 1, a.rounds, model, reason))
        r = run_trial(key, task, rubric, judge, model, cat)
        tried.add(model)
        results.append(r)
        if "error" in r:
            failed_vendors.add(model.split("/")[0])
            print("    FAILED: %s" % r["error"][:160])
        else:
            print("    score=%.2f  $/M=%s  est_cost=$%.4f  %s"
                  % (r["score"], r["price"], r["est_cost"], r["why"][:110]))

    pts = [r for r in results if "error" not in r and r.get("price") is not None]
    if not pts:
        sys.exit("no trials completed")

    fr = frontier(pts)
    best = max(pts, key=lambda p: (p["score"], -p["price"]))
    others = lambda pool: [p for p in pool if p["model"] != best["model"]]
    cheaper = [p for p in others(fr) if p["price"] < best["price"]]
    pool = cheaper or others(fr) or others(pts)
    fallback = max(pool, key=lambda p: (p["score"], -p["price"])) if pool else None

    print("\n=== pareto frontier (cheaper + higher score dominates) ===")
    for p in sorted(fr, key=lambda p: p["price"]):
        print("  %-40s score=%.2f  $%.2f/M" % (p["model"], p["score"], p["price"]))
    print("\nBEST FIT : %s  (score %.2f, $%.2f/M)" % (best["model"], best["score"], best["price"]))
    if fallback:
        print("FALLBACK : %s  (score %.2f, $%.2f/M)" % (fallback["model"], fallback["score"], fallback["price"]))
    else:
        print("FALLBACK : n/a (only one trial)")

    out = {"task": task, "eval": rubric, "rounds": len(results), "results": results,
           "frontier": [{"model": p["model"], "score": p["score"], "price": p["price"]} for p in fr],
           "recommendation": {"best_fit": best["model"],
                              "fallback": fallback["model"] if fallback else None}}
    with open(os.path.join(HERE, "results.json"), "w") as f:
        json.dump(out, f, indent=2)
    print("\nsaved -> results.json")


if __name__ == "__main__":
    main()
