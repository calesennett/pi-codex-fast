import test from "node:test";
import assert from "node:assert/strict";
import { applyPriorityCostMultiplier, adjustAssistantMessageCost } from "./codex-fast.ts";

test("applyPriorityCostMultiplier doubles all tracked cost buckets", () => {
  const adjusted = applyPriorityCostMultiplier({
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    total: 10,
  });

  assert.deepEqual(adjusted, {
    input: 2,
    output: 4,
    cacheRead: 6,
    cacheWrite: 8,
    total: 20,
  });
});

test("adjustAssistantMessageCost mutates assistant usage cost only", () => {
  const message = {
    role: "assistant",
    usage: {
      cost: {
        input: 0.25,
        output: 0.5,
        total: 0.75,
      },
    },
  };

  const changed = adjustAssistantMessageCost(message);

  assert.equal(changed, true);
  assert.deepEqual(message.usage.cost, {
    input: 0.5,
    output: 1,
    total: 1.5,
  });
});

test("adjustAssistantMessageCost ignores non-assistant messages", () => {
  const message = {
    role: "user",
    usage: {
      cost: {
        total: 1,
      },
    },
  };

  const changed = adjustAssistantMessageCost(message);

  assert.equal(changed, false);
  assert.deepEqual(message.usage.cost, { total: 1 });
});
