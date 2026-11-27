// The server's MCP tools: their names, descriptions and input schemas. /mcp lists them, and the
// openmerit CLI makes one command of each (src/tool-cli.ts), so this file imports nothing.

const string = { type: "string" } as const;
const BUNDLE_SCHEMA = {
  type: "object",
  description: "Everything OpenMerit needs to measure models on this task without your code. Do not include API keys or secrets: the user adds endpoint keys at app.openmerit.ai.",
  required: ["task", "current", "prompt", "output"],
  properties: {
    task: { type: "string", description: "The task's name, such as \"ticket classifier\". The same name continues the same task." },
    description: string,
    current: { type: "object", required: ["model"], properties: { model: { type: "string", description: "The model ID the code uses now, as the code spells it" }, endpoint: { type: "string", description: "The ID of the user's endpoint at app.openmerit.ai that serves it, when not OpenRouter" } } },
    prompt: {
      type: "object", required: ["messages"], description: "The prompt the code sends, with {{name}} placeholders for each example's input variables",
      properties: { system: string, messages: { type: "array", items: { type: "object", required: ["role", "content"], properties: { role: { enum: ["user", "assistant"] }, content: string } } } },
    },
    tools: { type: "array", items: { type: "object", required: ["name", "parameters"], properties: { name: string, description: string, parameters: { type: "object" }, mockResult: {} } } },
    output: {
      oneOf: [
        { type: "object", required: ["kind"], properties: { kind: { const: "text" } } },
        { type: "object", required: ["kind", "schema"], properties: { kind: { const: "json" }, schema: { type: "object" } } },
        { type: "object", required: ["kind", "labels"], properties: { kind: { const: "label" }, labels: { type: "array", items: string } } },
      ],
    },
    examples: { type: "array", description: "Real inputs from the code or its tests, with the correct answer when known. These become the first test cases.", items: { type: "object", required: ["input"], properties: { input: { type: "object", additionalProperties: string }, expected: {} } } },
    constraints: { type: "object", properties: { maxLatencyMs: { type: "number" }, needsVision: { type: "boolean" }, maxTurns: { type: "integer", minimum: 1, description: "The most model calls one case may take, for a task that calls tools in a loop (an agent). Default 5." } } },
    input: { type: "object", required: ["description"], description: "The task spec: what the call's input is and how it varies in production", properties: { description: string } },
    steps: { type: "array", description: "The task spec: what the model does, in order, with the tools each step uses and their access", items: { type: "object", required: ["description"], properties: { description: string, tools: { type: "array", items: string }, access: { enum: ["none", "read", "write"] }, required: { type: "boolean", description: "True when the step must happen in every case, such as a write the code always makes: one of its tools is called and answers" }, after: { type: "array", items: { type: "integer", minimum: 1 }, description: "Only where the order matters, such as when this step's input is an earlier tool's result: the 1-based numbers of the earlier steps that must happen first" } } } },
    criteria: { type: "array", description: "The task spec: what a right answer does, from the code and its prompt: each one testable sentence about one thing, so a failed check means one thing. OpenMerit judges every case on each. For a task with tools, OpenMerit runs the whole loop (each tool call, its mocked result, then the final answer) and the judge sees all of it, so describe the final answer and the tool calls it needs, not one response: write 'reports the temperature get_weather returned', not 'responds with tool calls instead of text'", items: string },
    guardrails: { type: "array", description: "The task spec: what the call must never do, one statement each, such as rules the code enforces after the call. OpenMerit judges every case on each, and writes cases that test them", items: string },
    codeRefs: { type: "array", description: "Where the code names the model, so the result can include the edit. spelling is the exact string literal that holds the model ID as the code writes it, with its quotes, such as '\"gpt-4.1-mini\"', or the expression around it, such as 'process.env.CLASSIFIER_MODEL ?? \"gpt-4.1-mini\"'; only that literal is edited. A config file or environment value that holds the model belongs in a ref of its own, at the line that sets it", items: { type: "object", required: ["file", "line", "spelling"], properties: { file: string, line: { type: "number" }, spelling: string } } },
  },
};

export const TOOLS = [
  {
    name: "openmerit_recommend", title: "OpenMerit: recommend a model",
    description: "Starts measuring cheaper models for one model call in the user's code. Send an idempotency_key, and the same one on a retry, so a retried call does not start a second paid job. Send a task bundle: the task, the current model, the prompt, tools, output shape, examples and where the code names the model. Or, to run a past job's task again on the bundle OpenMerit saved, as a result's Fix line says, send its job_id instead, with budget_usd to raise the task's budget per job first. Returns a provisional pick from the catalogue at once, and a job_id; call openmerit_result with it later for the measured pick. When the task's prompt, tools or output changed since its eval was accepted, the run grades the reopened eval with the user before it searches, as a first run does; tell them they will be asked to grade answers. Measuring makes paid model calls within the account's plan and budget: ask the user before a rerun. A higher budget needs the user's confirmation on a page this tool links to.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      bundle: BUNDLE_SCHEMA, environment: { type: "string", description: "The repository or workspace, such as owner/repo. Default: default" },
      agent: { type: "string", description: "The agent this task belongs to, when the code groups calls into agents" },
      project: { type: "string", description: "The OpenMerit project a new task goes in, by name or ID, when the user named one. Default: the project whose tasks already use this environment, else the default project" },
      job_id: { type: "string", description: "Instead of a bundle: a past job whose task runs again on its saved bundle, environment and agent" },
      task_id: { type: "string", description: "Instead of a bundle: a task to run on its saved bundle and eval, such as one approved in the app that has not run yet" },
      budget_usd: { type: "number", description: "With job_id: the task's new budget per job in US dollars, set before the run starts" },
      idempotency_key: { type: "string", description: "A new random string for each recommendation you mean to start, such as a UUID. Send the same key when you retry this call after a timeout or lost connection: within a day, a key that already started a job returns that job instead of starting and charging another" },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "openmerit_result", title: "OpenMerit: job result",
    description: "A job's state: running with progress, questions for the user, or the measured result with the code edit and a report link. Show every question to the user, with its detail, and send their answers with openmerit_answer. Never answer for the user.",
    inputSchema: { type: "object", required: ["job_id"], additionalProperties: false, properties: { job_id: string } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "openmerit_answer", title: "OpenMerit: answer a job's questions",
    description: "Sends the user's answers to a job's questions, keyed by question id, such as a label check, or a person's grades of a run's answers (good or bad, with an optional note after a colon; never grade them yourself). After a result, it also takes the user's decision on its change, keyed by the result's approval id (configure_<task>): true once you applied the edit they approved, false when they declined. Grades and decisions take effect once the user confirms them on the page this tool links to; give them the link, then check with openmerit_confirmation. Returns the job's state, as openmerit_result does.",
    inputSchema: { type: "object", required: ["job_id", "answers"], additionalProperties: false, properties: { job_id: string, answers: { type: "object", description: "Answers keyed by question id: strings, string lists, booleans or numbers", additionalProperties: { type: ["string", "array", "boolean", "number"] } } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "openmerit_confirmation", title: "OpenMerit: a confirmation's outcome",
    description: "Whether the user confirmed a critical request another tool held for them (a higher budget, grades, a decision on a switch), and its outcome, such as the job a confirmed run started. You cannot confirm it: only the user can, on the page the holding tool linked to.",
    inputSchema: { type: "object", required: ["confirmation_id"], additionalProperties: false, properties: { confirmation_id: string } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "openmerit_eval_command", title: "OpenMerit: measure with the repository's eval",
    description: "On a self-hosted OpenMerit server, makes a task's own eval command, from the user's repository, what measures each model, instead of cases OpenMerit writes. The command follows the eval contract: it reads the model from $OPENMERIT_MODEL, sends its model calls to $OPENAI_BASE_URL with $OPENAI_API_KEY, runs only the $OPENMERIT_ITEMS items when set, and writes {\"items\":[{\"id\",\"pass\"}]} to $OPENMERIT_RESULT. Name the task by task_id, or, for a task that has not run, send its bundle and environment as openmerit_recommend takes them. It runs a command on the user's machine, so the user confirms it on a page this tool links to; then call openmerit_recommend with the task_id. clear true stops using it. The hosted server refuses it for now.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      task_id: string, bundle: BUNDLE_SCHEMA, environment: { type: "string", description: "With bundle: the repository or workspace, as openmerit_recommend takes it" }, agent: string, project: { type: "string", description: "With bundle: the project, as openmerit_recommend takes it" },
      command: { type: "string", description: "The shell command that runs the eval, such as 'node evals/classify.mjs'" },
      root: { type: "string", description: "The repository's absolute path on the machine the server runs on" },
      cwd: { type: "string", description: "The directory to run it in, relative to root. Default: root" },
      env: { type: "object", additionalProperties: string, description: "Extra variables; {{model}} and {{items}} are filled in, as in CLASSIFIER_MODEL={{model}}" },
      threshold: { type: ["number", "null"], description: "The eval's own minimum pass rate, 0 to 1, or null" },
      timeout_seconds: { type: "number", description: "Longest one run may take. Default 1,800" },
      clear: { type: "boolean", description: "True to stop measuring the task with its eval command" },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "openmerit_tasks", title: "OpenMerit: tasks",
    description: "Lists the account's tasks with their ids and watch state, and the results that finished since the last session. A task is watching (OpenMerit re-runs it when the model catalogue changes), idle (no openmerit_recommend call for a while; the next one resumes it), frozen (a watch guardrail keeps its validated model), review (its eval waits for the user to review it in the app; no runs until then) or retired.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "openmerit_eval", title: "OpenMerit: a task's eval",
    description: "A task's accepted eval: its version, the spec the judge checks each case on, and its cases. OpenMerit keeps it; it stays as accepted until the task changes or the user revises it in the app. Use it to show the user what their task is measured on.",
    inputSchema: { type: "object", required: ["task_id"], additionalProperties: false, properties: { task_id: string } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "openmerit_retire", title: "OpenMerit: retire a task",
    description: "Call this when you remove a model call from the user's code, so OpenMerit stops re-running that task. The task's runs and report links are kept, and a later openmerit_recommend for the same task brings it back. Do not use it to keep a model the user validated: that is the watch guardrail at app.openmerit.ai. Take the task id from openmerit_tasks.",
    inputSchema: { type: "object", required: ["task_id"], additionalProperties: false, properties: { task_id: string } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];
