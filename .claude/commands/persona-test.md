---
description: "Generate natural language user simulation tests"
allowed-tools: [Read, Glob, Grep, Bash, Agent, Edit, Write]
---

# User Persona Test Generation

You are taking on the persona of a real, non-technical user interacting with this app through Telegram. Generate comprehensive tests using natural language that real people would actually type.

## Process

### 1. Understand the App

Read the app's manifest.yaml, help.md, and main source file to understand:
- What commands are available
- What intents the app handles
- What the app does in plain English

### 2. Study Existing Patterns

Read `apps/hearthstone/src/__tests__/natural-language.test.ts` as the reference pattern. This file demonstrates:
- Grouping tests by user intent/scenario
- Testing with casual, messy, real-world language
- Verifying intent classification AND output correctness
- Testing edge cases users would naturally hit

### 3. Generate Test Messages

For each app capability, generate messages a real person would type. Think about:

**Casual language**: "hey can you add milk to the list", "whats for dinner tonight"
**Incomplete sentences**: "grocery list", "my pantry", "recipe chicken"
**Typos and variations**: "reciepe for pasta", "grocey list"
**Context-dependent**: "add that to my list", "how about tomorrow instead"
**Emotional/conversational**: "ugh we're out of everything", "ooh that sounds good"
**Commands people might guess**: "show me my stuff", "what do I have"
**Ambiguous messages**: things that could match multiple intents or no intent
**Non-matching messages**: things that should NOT trigger any intent

### 4. Test Categories

For each test message, verify:

1. **Intent Classification** - Does the message route to the correct handler?
   - Messages that should match specific intents DO match
   - Messages that should NOT match DO NOT match (no false positives)
   - Ambiguous messages handled gracefully

2. **LLM Prompt Correctness** - When LLM is called:
   - User input is sanitized before prompt inclusion
   - Response is parsed correctly
   - Malformed LLM responses handled gracefully

3. **Output Quality** - What the user sees back:
   - Response makes sense for what they asked
   - Formatting is readable in Telegram
   - Error messages are helpful, not technical

### 5. Test File Structure

Create the test file at `apps/<app-id>/src/__tests__/natural-language.test.ts` following this structure:

```typescript
describe('<App Name> Natural Language Tests', () => {
  describe('Intent: <intent name>', () => {
    test.each([
      'natural message 1',
      'natural message 2',
      'natural message 3',
    ])('recognizes "%s" as <intent>', async (message) => {
      // Test that the message triggers the correct handler
    });
  });

  describe('Should NOT match', () => {
    test.each([
      'message that looks similar but should not match',
    ])('does not match "%s"', async (message) => {
      // Test that the message does NOT trigger any handler
    });
  });

  describe('End-to-end scenarios', () => {
    test('user adds items then views list', async () => {
      // Multi-step user interaction flow
    });
  });
});
```

### 6. Quality Bar

- Minimum 50 unique natural language test messages per app
- At least 10 "should NOT match" cases
- At least 3 multi-step scenario tests
- Cover ALL intents declared in the manifest
- Include at least 5 messages per intent
