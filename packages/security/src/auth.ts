import { createHash, timingSafeEqual } from "node:crypto";

export type GatewayRole = "user" | "admin";

export interface Principal {
  /** Non-reversible short id derived from the token; safe to log. */
  id: string;
  role: GatewayRole;
}

const digest = (t: string) => createHash("sha256").update(t, "utf8").digest();

/**
 * Bearer-token authentication. Tokens are held only as SHA-256 digests and compared in
 * constant time across all entries, so neither timing nor memory dumps of this object
 * reveal a token.
 */
export class Authenticator {
  private readonly entries: Array<{ digest: Buffer; principal: Principal }> = [];

  constructor(tokens: { user?: string[]; admin?: string[] } = {}) {
    for (const [role, list] of [["user", tokens.user ?? []], ["admin", tokens.admin ?? []]] as const) {
      for (const t of list) {
        const d = digest(t);
        this.entries.push({ digest: d, principal: { id: d.toString("hex").slice(0, 8), role } });
      }
    }
  }

  get configured(): boolean {
    return this.entries.length > 0;
  }

  static fromEnv(env: Record<string, string | undefined>): Authenticator {
    const split = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return new Authenticator({ user: split(env["GATEWAY_API_KEYS"]), admin: split(env["GATEWAY_ADMIN_KEYS"]) });
  }

  authenticate(header: string | undefined): Principal | undefined {
    if (!header) return undefined;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m) return undefined;
    const d = digest(m[1]!);
    let found: Principal | undefined;
    for (const e of this.entries) {
      if (timingSafeEqual(d, e.digest) && !found) found = e.principal; // no early exit
    }
    return found;
  }
}
