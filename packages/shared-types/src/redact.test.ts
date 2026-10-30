import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskKey, redact } from "./redact.ts";
import { DeccanError, errorFromStatus } from "./errors.ts";

describe("redact", () => {
  it("removes provider-style keys", () => {
    const s = redact("failed with key sk-abcdef1234567890 and sk-ant-abcdef1234567890");
    assert.ok(!s.includes("abcdef1234567890"));
    assert.ok(s.includes("[REDACTED]"));
  });

  it("removes bearer tokens and key-value secrets", () => {
    const s = redact('Authorization: Bearer abcdefghijklmnop and {"api_key":"supersecretvalue"}');
    assert.ok(!s.includes("abcdefghijklmnop"));
    assert.ok(!s.includes("supersecretvalue"));
  });

  it("leaves ordinary text unchanged", () => {
    assert.equal(redact("model gpt-x responded in 120ms"), "model gpt-x responded in 120ms");
  });

  it("masks keys to last four", () => {
    assert.equal(maskKey("sk-abcdef1234567890"), "****7890");
    assert.equal(maskKey("short"), "****");
  });
});

describe("errorFromStatus", () => {
  it("classifies statuses and retryability", () => {
    assert.equal(errorFromStatus(429, "x", 3).kind, "rate_limited");
    assert.equal(errorFromStatus(429, "x", 3).retryAfterSec, 3);
    assert.equal(errorFromStatus(503, "x").retryable, true);
    assert.equal(errorFromStatus(401, "x").retryable, false);
    assert.ok(errorFromStatus(400, "x") instanceof DeccanError);
  });
});
