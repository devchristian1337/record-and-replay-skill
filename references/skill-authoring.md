# Writing a skill from a recording

## Contents
- 1. Clarify before writing (question bank)
- 2. Update instead of duplicate
- 3. Frontmatter rules (hard limits)
- 4. Writing the description
- 5. SKILL.md skeleton
- 6. Turning recorded events into steps
- 7. Bundled scripts
- 8. Quality checklist
- 9. Testing the generated skill (evals)
- 10. Exporting for claude.ai

Distilled from the Agent Skills spec and guides (agentskills.io: best practices, optimizing descriptions, evaluating skills, using scripts), Anthropic's skill authoring best practices and "The Complete Guide to Building Skills for Claude". Where those sources disagree, the stricter rule is used so one skill works in Claude Code, claude.ai and other agents.

## 1. Clarify before writing (question bank)

A recording shows *what* the user did, never *why*. There is no narration track: the clarification round replaces it. Answer everything you can from the recording first (steps, inputs, outputs, apps, corrections visible in the timeline), then ask only about the gaps.

Ask once, in a single message, at most 5–6 questions. Use the agent's structured question tool when it has one (e.g. AskUserQuestion in Claude Code), plain chat otherwise. Quote the concrete moment you are asking about ("at 02:14 you cleared the date filter — …"). Never ask what the recording already answers.

Pick from these, in priority order:

1. **Outcome** — In one sentence, what does this task achieve, and how do you tell it worked? (→ description, verification step)
2. **Variables** — Which values change from run to run (names, dates, amounts, files, search terms) and where do they come from? Which are always the same? (→ Inputs, hard-coded constants)
3. **Decisions** — At <moment> you chose X over Y / skipped a step. What rule should be followed there? (→ conditional steps; this is what narration would have said)
4. **Detours** — Were any actions mistakes, retries or exploration that the skill should leave out?
5. **Triggers** — What would you say or type to ask for this next time? What similar request should *not* use it? (→ description trigger phrases and "Not for …")
6. **Safety** — Which actions are irreversible or need your confirmation (submit, send, pay, delete)? Is there data that must never be stored in the skill? (→ Safety section)
7. **Failure** — If a window or page looks different, or an element is missing, what should happen? (→ Troubleshooting)
8. **Output** — What should the final result be (a file, a message, a state in the app) and in what format? (→ Output section, template)
9. **Environment** — Which apps, accounts, logins or permissions does it need? Is there an API, CLI or connector that does the same thing? (→ `compatibility`, tool choice)
10. **Scope** — Claude Code only, or also exported as a ZIP for claude.ai? Should it run on its own, or only when you invoke it?

Masked stretches (`type → [masked: …]`, excluded windows, secure-input gaps, elevated-window blind spots) are gaps too: ask what happened there instead of guessing, and never ask the user to reveal a secret — use an environment variable or "ask the user at run time".

If the user declines to answer, proceed with the most conservative reading and state the assumption in the skill's Gotchas.

## 2. Update instead of duplicate

Before creating a new skill, look for one that already covers this workflow: list `~/.agents/skills/` and the agent's own skill directories, read the `description` of plausible matches. If one overlaps, propose updating it (merge the new steps, keep its name) and bump `metadata.version`. Create a new skill only for a genuinely different workflow.

## 3. Frontmatter rules (hard limits)

| Field | Rule |
|---|---|
| file | exactly `SKILL.md` (case-sensitive), YAML between `---` lines |
| `name` | required; 1–64 chars; `a-z`, `0-9`, single `-`; no leading/trailing hyphen; equals the folder name; must not contain `anthropic` or `claude` |
| `description` | required; 1–1024 chars; no `<` or `>`; third person; says what it does AND when to use it |
| `compatibility` | optional; ≤ 500 chars; environment needs (apps, OS, packages, network) |
| `metadata` | optional map; use `author`, `version` (bump on every refinement), `source: record-and-replay` |
| `license`, `allowed-tools` | optional |

No other keys in skills meant to be portable. `dependencies` is not a spec field (put requirements in `compatibility`). Claude Code-only keys (`disable-model-invocation`, `argument-hint`, `when_to_use`, `model`, `context`, …) are fine for a Claude Code-only skill but fail the claude.ai upload — the exporter can strip them (`--strip-cc-keys`).

The skill folder holds no `README.md`: documentation lives in `SKILL.md` or `references/`.

## 4. Writing the description

The description is the only text an agent reads before deciding to load the skill. Formula: **[what it does] + [when to use it] + [key capabilities]** — a third-person "what" sentence, then an imperative "Use when …" that tells the agent when to act.

- Describe the user's intent, not the skill's internals ("file this week's expenses", not "drives the portal's form via UI Automation").
- Name the concrete app, site, file type and objects ("expense reports in the Acme portal", not "forms").
- Include the phrases the user actually says (from question 5), including requests that never name the app.
- Agents tend to under-trigger skills: be slightly pushy ("Use whenever …, even if the user does not mention Acme").
- If it could fire on near-misses, add a negative trigger ("Not for approving other people's expenses").
- Put the most important trigger first (some surfaces truncate around 200 chars). A few sentences is right; the hard cap is 1024.
- Simple one-step requests may not trigger any skill whatever the wording — the description matters for multi-step, domain-specific work, which is what recordings capture.

Good: `Files weekly expense reports in the Acme portal from receipt photos, filling amount, date and cost center. Use when the user asks to submit, file or report expenses or receipts, even without naming Acme. Not for approving others' reports.`
Bad: `Helps with expenses.` — no app, no trigger, no scope.

## 5. SKILL.md skeleton

Keep the body under 500 lines; move long material to `references/` and say *when* to read each file. Critical rules go near the top.

````markdown
---
name: filing-acme-expenses
description: <formula from section 4>
compatibility: Requires <app/site, OS, logins>
metadata:
  author: <user>
  version: 1.0.0
  source: record-and-replay
---

# Filing Acme expenses

<One or two sentences: the outcome and when it applies.>

## Important
- <Irreversible actions need confirmation; secrets come from env vars or the user.>

## Inputs
- `<parameter>`: <what it is, where it comes from, example>

## Instructions
Copy this checklist and tick it off:
- [ ] 1. <goal-level step, semantic target: Button "Submit" in the "New report" dialog>
      Expected: <what the screen/output shows when this worked>
- [ ] 2. <decision: if X → …, otherwise → …>
- [ ] 3. Verify: <observable success signal>; if absent → see Troubleshooting

## Examples
User says: "<request>" → Actions: <steps in brief> → Result: <outcome>

## Gotchas
- <non-obvious fact from the recording or the clarification answers>

## Troubleshooting
- Error: <symptom> — Cause: <why> — Fix: <what to do>

## References
- Exact selectors / UI targets: read [references/targets.md](references/targets.md) when a step's target is not found.
````

Next to it, `evals/evals.json` holds 2–3 test cases (section 9); the recorded demonstration is the first one.

## 6. Turning recorded events into steps

- Treat the recording as evidence of intent, not a script. If an API, CLI or connector reaches the same outcome, make that the default and keep UI steps as the fallback.
- **Browser**: use the selector candidates in order `testId` > `role`+name > label > text; `css` only as a last resort. Generated scripts start from `scripts/replay-template.mjs`.
- **Desktop**: describe targets the way an accessibility-tree tool searches for them — role + name (+ `automationId` when present) + the window title, e.g. *Button "Save" in window "Invoice — Acme"*. Coordinates only when no target was captured, and then say so.
- Collapse noise: repeated clicks on the same target, scrolling, focus clicks before typing.
- Parametrize what varies (question 2), hard-code what does not.
- Never copy literal secrets, personal data or masked placeholders into the skill. A `[masked]` input becomes "ask the user" or an environment variable named in Inputs.
- Add an `Expected:` line after every step that changes state, and a final verification step.

## 7. Bundled scripts

Bundle a script when the agent would otherwise rewrite the same logic every run (a replay script, a parser, a validator). Agents run scripts in non-interactive shells and read their output to decide what to do next, so:

- **Never prompt.** All input via flags, environment variables or stdin; a missing input is an error that names the flag (`Error: --amount is required. Usage: …`). Secrets come from env vars.
- **`--help`** with a one-line purpose, the flags and one or two examples — it is how the agent learns the interface.
- **Structured output**: JSON on stdout, progress and diagnostics on stderr. Keep output small (summaries, `--output <file>` for large results).
- **Helpful errors and distinct exit codes** (say what was expected and what to try); document the codes in `--help`.
- **Safe by default**: `--dry-run` for anything that submits, sends, pays or deletes; idempotent where possible (agents retry).
- **Self-contained dependencies**: Python scripts declare them inline (PEP 723 `# /// script` block, versions pinned) and run with `uv run scripts/x.py`; Node scripts prefer built-ins; pin versions of one-off tools (`npx pkg@1.2.3`). State runtime requirements in `compatibility`.
- Reference scripts by paths relative to the skill root (`scripts/replay.mjs`), list them in SKILL.md, and say whether to run or read each one.

## 8. Quality checklist

- [ ] Validator passes: `node scripts/export-skill.mjs <skillDir> --check` (fix every error; read every warning)
- [ ] Description has what + when + concrete triggers, third person, a negative trigger if needed
- [ ] Only what the agent would not know on its own; no tutorial prose
- [ ] One default per step, not a menu of options; procedures that generalize beyond the recorded instance
- [ ] Every state-changing step has an expected result; the workflow ends with a verification
- [ ] Gotchas in SKILL.md (not hidden in a reference); consistent terminology throughout
- [ ] Forward-slash relative paths; every referenced file exists; references one level deep, with a Contents list past 100 lines
- [ ] No secrets, no time-sensitive statements ("before August…"), no README.md in the folder
- [ ] Scripts follow section 7 (no prompts, `--help`, JSON out, `--dry-run` for side effects)
- [ ] `evals/evals.json` has 2–3 realistic cases

## 9. Testing the generated skill (evals)

Write `evals/evals.json` in the skill folder while the recording is fresh. The demonstration itself is case 1; add one paraphrased variant and one edge case (a value missing, an unusual input):

```json
{
  "skill_name": "filing-acme-expenses",
  "evals": [
    {"id": 1, "prompt": "file my expenses for this week, receipts are in ~/Downloads/receipts",
     "expected_output": "One Acme report per week with every receipt attached; the user confirmed before Submit.",
     "files": []}
  ]
}
```

Prompts should sound like the user (file paths, casual phrasing, context). Add assertions only after a first run shows what good looks like; they must be checkable from the output ("report status is Submitted"), not vague ("works well").

Then offer the user this light loop:

1. **Trigger check** — ask the agent "When would you use the <name> skill?"; it should paraphrase the description. Try 3 requests that should trigger it (one paraphrased, one that never names the app) and 3 near-misses that share keywords but need something else. Should-trigger requests that need no special knowledge may not trigger any skill — that is expected.
2. **Dry run** — run eval 1 once with the user watching, stopping before any irreversible action. When subagents are available, also run it once without the skill to see what the skill adds.
3. **Fix and bump** — turn every correction into a Gotcha or a clearer step (generalize; do not patch for the one example), bump `metadata.version`, re-run the validator.

For a rigorous pass (about 20 trigger queries, 3 runs each, train/validation split, with/without-skill benchmarks), hand over to the `skill-creator` skill when the environment has it.

## 10. Exporting for claude.ai

```bash
node scripts/export-skill.mjs ~/.agents/skills/<name> [--strip-cc-keys]
```

Writes `~/.agents/exports/<name>.zip` with the folder at the ZIP root (`<name>/SKILL.md`), leaves out README.md, `evals/`, caches and raw recording evidence, and reads the archive back before reporting success. Upload it in claude.ai under Customize › Skills › + › Upload a skill (older UI: Settings › Capabilities › Skills); code execution must be enabled in the user's settings.
