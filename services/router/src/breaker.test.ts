import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker } from "./breaker.ts";

describe("CircuitBreaker", () => {
  it("opens after N consecutive failures and blocks dispatch", () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => t });
    assert.equal(b.state("k"), "closed");
    b.onFailure("k");
    b.onFailure("k");
    assert.equal(b.state("k"), "closed");
    b.onFailure("k");
    assert.equal(b.state("k"), "open");
    assert.equal(b.allow("k"), false);
  });

  it("a success resets the consecutive-failure count", () => {
    const b = new CircuitBreaker({ failureThreshold: 2 });
    b.onFailure("k");
    b.onSuccess("k");
    b.onFailure("k");
    assert.equal(b.state("k"), "closed");
  });

  it("goes half-open after cooldown and admits exactly one trial", () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => t });
    b.onFailure("k");
    t = 999;
    assert.equal(b.state("k"), "open");
    t = 1000;
    assert.equal(b.state("k"), "half_open");
    assert.equal(b.allow("k"), true); // the trial
    assert.equal(b.allow("k"), false); // no second concurrent trial
  });

  it("closes on a successful trial and re-opens on a failed one", () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => t });
    b.onFailure("k");
    t = 1000;
    assert.equal(b.allow("k"), true);
    b.onSuccess("k");
    assert.equal(b.state("k"), "closed");

    b.onFailure("k");
    t = 2000;
    assert.equal(b.allow("k"), true);
    b.onFailure("k");
    assert.equal(b.state("k"), "open");
    t = 2999;
    assert.equal(b.state("k"), "open"); // cooldown restarted from the failed trial
  });

  it("tracks keys independently", () => {
    const b = new CircuitBreaker({ failureThreshold: 1 });
    b.onFailure("a");
    assert.equal(b.state("a"), "open");
    assert.equal(b.state("b"), "closed");
  });
});
