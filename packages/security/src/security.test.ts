import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Authenticator, CredentialVault, FileVaultStore, RateLimiter, VaultError, generateMasterKey } from "./index.ts";

const SECRET = "sk-live-ABCDEFGHIJKLMNOP-1234";

describe("CredentialVault", () => {
  it("round-trips a secret and never stores it in plaintext", () => {
    const v = new CredentialVault(generateMasterKey());
    const rec = v.seal("openai", SECRET);
    assert.equal(v.open(rec), SECRET);
    assert.ok(!JSON.stringify(rec).includes("ABCDEFGHIJKLMNOP"));
    assert.equal(rec.last4, "1234");
  });

  it("uses a fresh data key and IV for every seal", () => {
    const v = new CredentialVault(generateMasterKey());
    const a = v.seal("x", SECRET);
    const b = v.seal("x", SECRET);
    assert.notEqual(a.sealed.data, b.sealed.data);
    assert.notEqual(a.wrapped.data, b.wrapped.data);
  });

  it("fails closed with a wrong master key", () => {
    const rec = new CredentialVault(generateMasterKey()).seal("x", SECRET);
    assert.throws(() => new CredentialVault(generateMasterKey()).open(rec), VaultError);
  });

  it("detects tampering with the ciphertext", () => {
    const v = new CredentialVault(generateMasterKey());
    const rec = v.seal("x", SECRET);
    const buf = Buffer.from(rec.sealed.data, "base64");
    buf[0] = buf[0]! ^ 0xff;
    assert.throws(() => v.open({ ...rec, sealed: { ...rec.sealed, data: buf.toString("base64") } }), VaultError);
  });

  it("binds ciphertext to its id (cannot be moved to another credential)", () => {
    const v = new CredentialVault(generateMasterKey());
    const rec = v.seal("provider-a", SECRET);
    assert.throws(() => v.open({ ...rec, id: "provider-b" }), VaultError);
  });

  it("re-wraps under a new master key without touching the ciphertext", () => {
    const oldKey = generateMasterKey();
    const newKey = generateMasterKey();
    const rec = new CredentialVault(oldKey).seal("x", SECRET);
    const rewrapped = new CredentialVault(oldKey).rewrap(rec, newKey);
    assert.equal(rewrapped.sealed.data, rec.sealed.data);
    assert.equal(new CredentialVault(newKey).open(rewrapped), SECRET);
    assert.throws(() => new CredentialVault(oldKey).open(rewrapped), VaultError);
  });

  it("rejects malformed master keys", () => {
    assert.throws(() => new CredentialVault("too-short"), VaultError);
  });
});

describe("FileVaultStore", () => {
  it("persists encrypted, owner-only, lists masked metadata, rotates and deletes", () => {
    const dir = mkdtempSync(join(tmpdir(), "deccan-vault-"));
    try {
      const file = join(dir, "vault.json");
      const key = generateMasterKey();
      const store = new FileVaultStore(file, new CredentialVault(key));
      const meta = store.put("openai", SECRET);
      assert.equal(meta.masked, "****1234");
      assert.equal(meta.version, 1);

      const onDisk = readFileSync(file, "utf8");
      assert.ok(!onDisk.includes("ABCDEFGHIJKLMNOP"), "secret must not appear on disk");
      assert.equal(statSync(file).mode & 0o777, 0o600);

      // survives restart
      const reopened = new FileVaultStore(file, new CredentialVault(key));
      assert.equal(reopened.get("openai"), SECRET);

      // rotation bumps the version
      const rotated = reopened.put("openai", "sk-rotated-ZZZZZZZZ-9999");
      assert.equal(rotated.version, 2);
      assert.equal(reopened.get("openai"), "sk-rotated-ZZZZZZZZ-9999");
      assert.deepEqual(reopened.list().map((m) => m.masked), ["****9999"]);

      // master-key rotation: store keeps working, and only the new key opens the file
      const newKey = generateMasterKey();
      reopened.rewrapAll(newKey);
      assert.equal(reopened.get("openai"), "sk-rotated-ZZZZZZZZ-9999");
      assert.equal(new FileVaultStore(file, new CredentialVault(newKey)).get("openai"), "sk-rotated-ZZZZZZZZ-9999");
      assert.throws(() => new FileVaultStore(file, new CredentialVault(key)).get("openai"), VaultError);

      assert.equal(reopened.delete("openai"), true);
      assert.equal(reopened.get("openai"), undefined);
      assert.ok(!readFileSync(file, "utf8").includes("rotated"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Authenticator", () => {
  const auth = new Authenticator({ user: ["user-token-1"], admin: ["admin-token-1"] });
  it("accepts valid tokens with the right role and a loggable id", () => {
    const u = auth.authenticate("Bearer user-token-1")!;
    assert.equal(u.role, "user");
    assert.match(u.id, /^[0-9a-f]{8}$/);
    assert.equal(auth.authenticate("bearer admin-token-1")?.role, "admin");
  });
  it("rejects missing, malformed and wrong tokens", () => {
    assert.equal(auth.authenticate(undefined), undefined);
    assert.equal(auth.authenticate("user-token-1"), undefined);
    assert.equal(auth.authenticate("Bearer nope"), undefined);
    assert.equal(auth.authenticate("Bearer "), undefined);
  });
  it("reads tokens from the environment", () => {
    const a = Authenticator.fromEnv({ GATEWAY_API_KEYS: "a, b", GATEWAY_ADMIN_KEYS: "c" });
    assert.equal(a.authenticate("Bearer b")?.role, "user");
    assert.equal(a.authenticate("Bearer c")?.role, "admin");
    assert.equal(Authenticator.fromEnv({}).configured, false);
  });
});

describe("RateLimiter", () => {
  it("limits per principal per window and resets", () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    assert.equal(rl.take("a").ok, true);
    assert.equal(rl.take("a").ok, true);
    const blocked = rl.take("a");
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.retryAfterSec, 1);
    assert.equal(rl.take("b").ok, true); // independent
    t = 1000;
    assert.equal(rl.take("a").ok, true);
  });
});
