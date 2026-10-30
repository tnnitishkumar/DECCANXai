import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { maskKey } from "#shared";

/**
 * Credential vault (spec section 8): envelope encryption at rest.
 *
 *   secret   --AES-256-GCM(dataKey, aad=id)-->  ciphertext
 *   dataKey  --AES-256-GCM(masterKey, aad=id)-> wrappedKey
 *
 * - A fresh random data key per record: compromising one record's key reveals nothing else.
 * - The record id is bound as AAD, so ciphertext cannot be moved to another id.
 * - Master-key rotation re-wraps data keys only; ciphertext is untouched.
 * - Listing returns masked metadata (last 4 characters) only; plaintext never leaves open().
 *
 * The master key comes from the environment/OS keychain/KMS (caller's responsibility);
 * it is never stored next to the data.
 */

const ALG = "aes-256-gcm";

interface Box {
  iv: string;
  tag: string;
  data: string;
}

export interface SealedRecord {
  id: string;
  version: number;
  wrapped: Box; // data key encrypted by the master key
  sealed: Box; // secret encrypted by the data key
  last4: string;
  createdAt: string;
  rotatedAt?: string;
}

export interface RecordMetadata {
  id: string;
  version: number;
  masked: string;
  createdAt: string;
  rotatedAt?: string;
}

function encrypt(key: Buffer, plaintext: Buffer, aad: string): Box {
  const iv = randomBytes(12);
  const c = createCipheriv(ALG, key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function decrypt(key: Buffer, box: Box, aad: string): Buffer {
  const d = createDecipheriv(ALG, key, Buffer.from(box.iv, "base64"));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(box.data, "base64")), d.final()]);
}

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export function generateMasterKey(): string {
  return randomBytes(32).toString("base64");
}

function parseMasterKey(b64: string): Buffer {
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new VaultError("master key must be 32 bytes, base64-encoded");
  return k;
}

export class CredentialVault {
  private readonly master: Buffer;

  constructor(masterKeyB64: string) {
    this.master = parseMasterKey(masterKeyB64);
  }

  seal(id: string, secret: string, prev?: SealedRecord): SealedRecord {
    if (!id) throw new VaultError("id is required");
    if (!secret) throw new VaultError("secret is empty");
    const dataKey = randomBytes(32);
    const now = new Date().toISOString();
    const rec: SealedRecord = {
      id,
      version: (prev?.version ?? 0) + 1,
      wrapped: encrypt(this.master, dataKey, id),
      sealed: encrypt(dataKey, Buffer.from(secret, "utf8"), id),
      last4: secret.slice(-4),
      createdAt: prev?.createdAt ?? now,
      ...(prev ? { rotatedAt: now } : {}),
    };
    dataKey.fill(0);
    return rec;
  }

  open(rec: SealedRecord): string {
    try {
      const dataKey = decrypt(this.master, rec.wrapped, rec.id);
      try {
        return decrypt(dataKey, rec.sealed, rec.id).toString("utf8");
      } finally {
        dataKey.fill(0);
      }
    } catch {
      // Deliberately vague: do not reveal whether the key, the tag or the id binding failed.
      throw new VaultError(`cannot decrypt credential '${rec.id}' (wrong master key or tampered data)`);
    }
  }

  /** Master-key rotation: re-wrap the data key under a new master; ciphertext is unchanged. */
  rewrap(rec: SealedRecord, newMasterKeyB64: string): SealedRecord {
    const next = parseMasterKey(newMasterKeyB64);
    let dataKey: Buffer;
    try {
      dataKey = decrypt(this.master, rec.wrapped, rec.id);
    } catch {
      throw new VaultError(`cannot rewrap credential '${rec.id}' (wrong master key or tampered data)`);
    }
    const wrapped = encrypt(next, dataKey, rec.id);
    dataKey.fill(0);
    return { ...rec, wrapped, rotatedAt: new Date().toISOString() };
  }
}

/** Persistent store: one JSON file, written atomically with owner-only permissions. */
export class FileVaultStore {
  private records = new Map<string, SealedRecord>();
  private readonly path: string;
  private vault: CredentialVault;

  constructor(path: string, vault: CredentialVault) {
    this.path = path;
    this.vault = vault;
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { records?: SealedRecord[] };
      for (const r of parsed.records ?? []) this.records.set(r.id, r);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, records: [...this.records.values()] }, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  /** Add or rotate a credential. */
  put(id: string, secret: string): RecordMetadata {
    const rec = this.vault.seal(id, secret, this.records.get(id));
    this.records.set(id, rec);
    this.persist();
    return this.meta(rec);
  }

  /** Plaintext is returned only to in-process callers that need to call the provider. */
  get(id: string): string | undefined {
    const rec = this.records.get(id);
    return rec ? this.vault.open(rec) : undefined;
  }

  delete(id: string): boolean {
    const had = this.records.delete(id);
    if (had) this.persist();
    return had;
  }

  list(): RecordMetadata[] {
    return [...this.records.values()].map((r) => this.meta(r));
  }

  rewrapAll(newMasterKeyB64: string): CredentialVault {
    const next = new CredentialVault(newMasterKeyB64); // validates the new key before touching anything
    const rewrapped = new Map<string, SealedRecord>();
    for (const [id, rec] of this.records) rewrapped.set(id, this.vault.rewrap(rec, newMasterKeyB64));
    this.records = rewrapped; // all-or-nothing: a failure above leaves the store unchanged
    this.vault = next; // the store must use the new master key from now on
    this.persist();
    return next;
  }

  private meta(r: SealedRecord): RecordMetadata {
    return {
      id: r.id,
      version: r.version,
      masked: maskKey(`xxxxxxxxx${r.last4}`),
      createdAt: r.createdAt,
      ...(r.rotatedAt ? { rotatedAt: r.rotatedAt } : {}),
    };
  }
}
