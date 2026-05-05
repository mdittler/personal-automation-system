/**
 * Instruction block and intent regex for the <session-search> pseudo-tool.
 *
 * SESSION_SEARCH_INSTRUCTION_BLOCK: injected into the system prompt when
 * SESSION_SEARCH_TOOL_INTENT_REGEX matches the user message AND the tool
 * is enabled AND a session search index is available.
 *
 * SESSION_SEARCH_TOOL_TOGGLE_INTENT_REGEX: gates <config-set> tag injection
 * for the session_search_tool_enabled key.
 *
 * REQ-CONV-TOOL-SEARCH-001, REQ-CONV-TOOL-SEARCH-010
 */

export const SESSION_SEARCH_INSTRUCTION_BLOCK = `
If you need to recall what was said in past conversations, you can search them by emitting a single tag at the end of your reply:

<session-search query="search terms here"/>

Stop your reply immediately after the tag. The system will run the search and then prompt you again with the results inside a <session-search-result> block. You can then complete your reply using the new context.

Supported attributes:
  query  (required) — the search terms
  after  (optional) — restrict to messages on or after this date (YYYY-MM-DD)
  before (optional) — restrict to messages before or on this date (YYYY-MM-DD)

To search with date filters:
  Absolute day: <session-search query="pizza recipe" after="2026-04-28" before="2026-04-28"/>
  Date window:  <session-search query="trip" after="2026-04-14" before="2026-04-22"/>
  No date filter: <session-search query="pasta"/>

Use this only when the user is asking about specific past discussions. Do not use it for general or factual questions.
`.trim();

/** Matches user messages asking about past conversations or memory recall. */
export const SESSION_SEARCH_TOOL_INTENT_REGEX =
	/\b(remember|recall|did we|earlier|last (time|week|month|year)|previous|previously|past|history|talked about|mentioned|discussed|said about|told (you|me))\b/i;

/** Matches user messages requesting to toggle the session-search tool. */
export const SESSION_SEARCH_TOOL_TOGGLE_INTENT_REGEX =
	/\b(session\s+search|past\s+conversation\s+search|search\s+(?:my\s+)?past\s+(?:chats?|conversations?))\b.*\b(on|off|enable|disable|turn)\b|\b(on|off|enable|disable|turn)\b.*\b(session\s+search|past\s+conversation\s+search|search\s+(?:my\s+)?past\s+(?:chats?|conversations?))\b/i;

export const SESSION_SEARCH_CONFIG_INSTRUCTION_BLOCK = `
You can control whether the session-search tool is active:

  To enable:  <config-set key="session_search_tool_enabled" value="true"/>
  To disable: <config-set key="session_search_tool_enabled" value="false"/>

Only emit the tag if the user explicitly asks to turn the session search on or off.
`.trim();
