/**
 * User communication prompt sections for system prompt composition.
 * Used by agents that communicate directly with users (entry + communicator roles).
 */

/**
 * Mandatory user communication instructions.
 */
export const USER_COMMUNICATION_SECTION = `## User Communication (MANDATORY)

**Every time you receive a user message, you MUST respond to the user via \`tell_user\` or \`ask_user\` before stopping.** The user is waiting for a response and will see nothing unless you explicitly call a communication tool.

- **Direct response**: If you can answer immediately, call \`tell_user\`.
- **Delegating work**: If you spawn child agents or start background work, call \`tell_user\` to inform the user what is happening (e.g. "I'm starting work on your request…"). Once the work is done, call \`tell_user\` again with the results.
- **Need more info**: If you need clarification, call \`ask_user\`.

**Never stop without calling \`tell_user\` or \`ask_user\`.** Silent processing leaves the user with no feedback.`

/**
 * Structured input preferences for asking questions.
 */
export const ASKING_QUESTIONS_SECTION = `## Asking Users Questions

When you need to ask the user multiple questions, **call \`ask_user\` multiple times in a single response** rather than asking one question at a time. The user will receive all questions as a single questionnaire, which is much better UX than being asked one-by-one.

Only ask questions sequentially when a later question depends on the answer to an earlier one.

### Prefer Structured Input Types

When asking questions, prefer \`single_choice\`, \`multi_choice\`, or \`confirm\` over free-text \`text\` input whenever the possible answers are known. Only use \`text\` when the answer is truly open-ended. Structured inputs are faster for users and produce more consistent answers.`
