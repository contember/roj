---
name: Agent prompt authoring
description: Patterns for system prompts, multi-agent orchestration, ask_user, attachments, hard limits. Read when writing or reviewing agent prompts.
---

# Agent prompt authoring

System prompts are configuration, not documentation. Patterns below come from working presets (App Builder, SCORM creator, webmaster's redo/preview/edit/coding-only/planning-only).

## Prompt composition

The SDK assembles each agent's prompt in this order:

1. **Role briefing** — fixed by the SDK based on `role` (orchestrator / communicator / child).
2. **Environment section** — auto-injected `sessionDir` / `workspaceDir` description.
3. **Your custom prompt** — `defineAgent({ system })`, with `{{sessionDir}}` / `{{workspaceDir}}` substituted (paths are virtual when sandboxed; details in `paths-and-sandbox.md`).
4. **Plugin contributions** — fragments from each plugin's `.systemPrompt(ctx)`.

You control only step 3. Always use placeholders, never hardcoded paths.

---

## Role section structure

A workable structure for a non-trivial agent (orchestrator or sub-agent):

```markdown
# Role: <one-line role label>

## Goal
<1-2 sentences. What is "done" for this agent? Why does it exist?>

## Inputs
<bulleted list of where data comes from — files, the orchestrator's delegation, the user>

## Sub-agents (orchestrators only)
<one bullet per sub-agent: name, what it does, when to call it>

## Phases / Decisions / Rules
<the actual procedural content — phases with entry/exit conditions, or
 rule lists, or a checklist. Pick one frame and stick to it for the whole prompt.>

## What you do not do
<negative rules. Just as important as positive ones — guards against
 the agent over-reaching into another agent's job.>

## Communication (optional)
<status updates, language, tone, when to talk vs. delegate>
```

Keep the prompt to the single agent's job. Multi-agent context (how the explorer relates to the planner) lives in the **orchestrator's** prompt; the explorer's prompt just describes what the explorer does.

---

## Multi-agent orchestration

Default pattern: one orchestrator + a small set of specialised sub-agents (planner, coder, reviewer, …). The orchestrator decides flow; each sub-agent has a single deliverable.

**Phases on the orchestrator** map well to event-driven flow:

```markdown
### Phase 1 — Material intake
**Entry**: session start.
**Goal**: enough material to plan from.
**Actions**:
1. Acknowledge the topic.
2. Invite the user to upload.
3. Run material-explorer when uploads arrive.
**Exit**: user signals "to je vše" or explicitly delegates.

### Phase 2 — Plan
**Entry**: Phase 1 exit.
**Goal**: an approved spec.
…
```

Phases beat free-form "decide what to do next" because they let you bound `ask_user` calls (don't ask Phase-2 questions in Phase 1) and pin work products.

**Sub-agent prompts** should not see the phases. They see "you receive X from the orchestrator, you produce Y, hand control back". The orchestrator owns the flow.

**Iteration patterns** are worth spelling out — small change vs. fundamental redirection lead to different actions:

```markdown
- **Specific tweak** ("add a page about X") → re-prompt the same planner.
- **Direction is fundamentally wrong** ("not what I meant at all") → spawn a new planner with corrected guidance.
```

---

## Asking the user

`ask_user` (from `userChatPlugin`) emits a structured question. The SPA renders it as a form input:

| `inputType` | Renders as |
|---|---|
| `single_choice` | radio group |
| `multi_choice` | checkbox group |
| `confirm` | yes/no |
| `text` | text input |
| `rating` | numeric scale |

Multiple `ask_user` calls in the same assistant turn batch into a single questionnaire — the user answers once, all answers come back together.

**Prompt patterns:**

- Prefer `single_choice` / `multi_choice` / `confirm` for parameters that have well-known discrete answers (course length, pass threshold, audience seniority).
- Use plain chat (not `ask_user`) for genuinely open questions.
- Don't offer "leave it to you" as an option. The user delegates explicitly when they want to.
- Phrase choices in the user's language. The kickoff context names the locale.

---

## Working with uploads

Uploads arrive as `<attachment uploadId="…" filename="…" basePath="…">extracted text</attachment>` blocks in a synthetic user message (see `presets.md` and `paths-and-sandbox.md` for layout). In prompts: tell the agent to read raw bytes from `<basePath>/<filename>` when extracted text is insufficient; for agents that shouldn't see attachments (e.g. a coder consuming only the planner's spec), let the orchestrator forward only what's needed.

---

## Hard limits

For sandboxes without network or topics where the knowledge cutoff matters: **disclose once at session start, not in every reply**. Tell the agent which limits to disclose, when (kickoff or when the topic implies external retrieval), and not to repeat the disclaimer in every message. Better than peppering "I cannot browse the web" through the whole prompt.

---

## Anti-patterns

- **Mixing orchestrator and sub-agent concerns.** Orchestrator says "delegate to coder"; coder says "use these patterns".
- **Listing what tools do.** Agents see schemas. Use prompt space for *when* to use each tool.
- **Vague rules without "Why".** "Don't edit src/components yourself" → "Don't edit src/components yourself, except single-string copy fixes — the styled wrappers are owned by the template".
- **Mixing role and process prose.** Use Role / Inputs / Phases / Rules sections, not "You are a coder. First read the spec. Then…".
- **Per-session prompt growth.** "This session is about X" belongs in the orchestrator's delegation message, not the system prompt.
- **Re-asking what's on record.** Tell the orchestrator explicitly to read chat history before `ask_user`.
- **Missing "What you do not do".** Negative rules are pure leverage.
- **Promises the agent can't keep.** No-network agent: say "ask the user to paste the source", not "verify the source".
