import type { ConnectedApp, Scope } from "@heedwork/core";
import {
  equalSecretHashes,
  hashSecret,
  newTokenSecret,
} from "./token-secrets.js";

type ClientAuth = "none" | "client_secret_basic" | "client_secret_post";

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  authMethod: ClientAuth;
  secretHash: string | null;
  refresh: boolean;
}

export interface OAuthAuthorization {
  client: Pick<
    OAuthClient,
    "id" | "name" | "authMethod" | "secretHash" | "refresh"
  >;
  redirectUri: string;
  challenge: string;
  resource: string;
  state: string | null;
}

type ConsentDecision = { label: string; scope: Scope } | null;

export interface OAuthExchange {
  clientId: string;
  authMethod: ClientAuth;
  clientSecretHash: string | null;
  resource: string;
  secret: string;
  grant:
    | { type: "code"; redirectUri: string; challenge: string }
    | { type: "refresh"; scope: string | null };
}

type GrantRow = {
  id: string;
  scope: Scope;
  authorization: string;
  resource: string;
  code_expires_at: number;
  refresh_expires_at: number | null;
};

const ACCESS_SECONDS = 60 * 60;
const REFRESH_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;
export const CONSENT_SECONDS = 10 * 60;

export class OAuthStorage {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly workspaceId: string | undefined,
  ) {}

  register(client: OAuthClient) {
    this.storage.sql.exec(
      "INSERT INTO oauth_clients (id, registration) VALUES (?, ?)",
      client.id,
      JSON.stringify(client),
    );
  }

  findClient(id: string): OAuthClient | null {
    const row = this.storage.sql
      .exec<{ registration: string }>(
        "SELECT registration FROM oauth_clients WHERE id = ?",
        id,
      )
      .toArray()[0];
    return row ? JSON.parse(row.registration) : null;
  }

  async beginConsent(
    csrf: string,
    userId: string,
    request: OAuthAuthorization,
  ) {
    const hash = await hashSecret(csrf);
    const now = Date.now();
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "DELETE FROM oauth_consents WHERE expires_at <= ?",
        now,
      );
      this.storage.sql.exec(
        "INSERT INTO oauth_consents (hash, user_id, request, expires_at) VALUES (?, ?, ?, ?)",
        hash,
        userId,
        JSON.stringify(request),
        now + CONSENT_SECONDS * 1000,
      );
    });
  }

  async finishConsent(
    csrf: string,
    userId: string,
    resource: string,
    decision: ConsentDecision,
  ) {
    const code = newTokenSecret();
    const [csrfHash, codeHash] = await Promise.all([
      hashSecret(csrf),
      hashSecret(code),
    ]);
    const { sql } = this.storage;
    const now = Date.now();
    return this.storage.transactionSync(() => {
      const pending = sql
        .exec<{ request: string }>(
          "SELECT request FROM oauth_consents WHERE hash = ? AND user_id = ? AND expires_at > ?",
          csrfHash,
          userId,
          now,
        )
        .toArray()[0];
      if (!pending) return null;
      const authorization: OAuthAuthorization = JSON.parse(pending.request);
      if (authorization.resource !== resource) return null;
      sql.exec("DELETE FROM oauth_consents WHERE hash = ?", csrfHash);
      if (!decision) return { authorization, code: null };

      sql.exec(
        `DELETE FROM tokens WHERE id IN (
          SELECT id FROM oauth_grants WHERE COALESCE(refresh_expires_at, access_expires_at, code_expires_at) <= ?
        )`,
        now,
      );
      const id = crypto.randomUUID();
      sql.exec(
        "INSERT INTO tokens (id, label, scope, secret_hash) VALUES (?, ?, ?, ?)",
        id,
        decision.label,
        decision.scope,
        "",
      );
      sql.exec(
        `INSERT INTO oauth_grants (id, client_name, authorization, resource, code_hash, code_expires_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        authorization.client.name,
        JSON.stringify(authorization),
        resource,
        codeHash,
        now + CODE_MS,
      );
      return { authorization, code: `heed-code_${this.workspaceId}_${code}` };
    });
  }

  async exchange(input: OAuthExchange) {
    const access = newTokenSecret();
    const refresh = newTokenSecret();
    const [hash, accessHash, refreshHash] = await Promise.all(
      [input.secret, access, refresh].map(hashSecret),
    );
    const { sql } = this.storage;
    const now = Date.now();

    return this.storage.transactionSync(() => {
      const isCode = input.grant.type === "code";
      const grant = sql
        .exec<GrantRow>(
          `SELECT g.*, t.scope FROM oauth_grants g JOIN tokens t ON t.id = g.id
          WHERE g.${isCode ? "code_hash" : "refresh_hash"} = ?`,
          hash,
        )
        .toArray()[0];

      const used =
        !grant && !isCode
          ? sql
              .exec<GrantRow>(
                `SELECT g.*, t.scope FROM oauth_used_refresh_tokens r
              JOIN oauth_grants g ON g.id = r.grant_id JOIN tokens t ON t.id = g.id
              WHERE r.hash = ?`,
                hash,
              )
              .toArray()[0]
          : undefined;
      const row = grant ?? used;
      if (!row || row.resource !== input.resource)
        return { error: "invalid_grant" };
      const authorization: OAuthAuthorization = JSON.parse(row.authorization);
      const client = authorization.client;
      if (client.id !== input.clientId) return { error: "invalid_grant" };
      if (
        client.authMethod !== input.authMethod ||
        (client.secretHash !== null &&
          !equalSecretHashes(client.secretHash, input.clientSecretHash ?? ""))
      )
        return { error: "invalid_client" };

      if (input.grant.type === "code") {
        if (
          row.code_expires_at <= now ||
          authorization.redirectUri !== input.grant.redirectUri ||
          !equalSecretHashes(authorization.challenge, input.grant.challenge)
        )
          return { error: "invalid_grant" };
      } else {
        if (!row.refresh_expires_at || row.refresh_expires_at <= now)
          return { error: "invalid_grant" };
        if (used) {
          // A replay invalidates the token family of an already rotated credential.
          this.revoke(row.id);
          return { error: "invalid_grant" };
        }
        if (input.grant.scope !== null && input.grant.scope !== row.scope)
          return { error: "invalid_scope" };
        sql.exec(
          "INSERT INTO oauth_used_refresh_tokens (hash, grant_id) VALUES (?, ?)",
          hash,
          row.id,
        );
      }

      const refreshExpiresAt = client.refresh
        ? (row.refresh_expires_at ?? now + REFRESH_MS)
        : null;
      const accessExpiresAt = Math.min(
        now + ACCESS_SECONDS * 1000,
        refreshExpiresAt ?? Infinity,
      );
      sql.exec(
        "UPDATE tokens SET secret_hash = ? WHERE id = ?",
        accessHash,
        row.id,
      );
      sql.exec(
        `UPDATE oauth_grants SET code_hash = NULL, access_expires_at = ?,
           refresh_hash = ?, refresh_expires_at = ? WHERE id = ?`,
        accessExpiresAt,
        client.refresh ? refreshHash : null,
        refreshExpiresAt,
        row.id,
      );

      return {
        access_token: `heed_${this.workspaceId}_${access}`,
        token_type: "Bearer",
        expires_in: Math.floor((accessExpiresAt - now) / 1000),
        ...(client.refresh && {
          refresh_token: `heed-refresh_${this.workspaceId}_${refresh}`,
        }),
        scope: row.scope,
      };
    });
  }

  list(): ConnectedApp[] {
    return this.storage.sql
      .exec<ConnectedApp>(
        `SELECT t.id, g.client_name, t.label, t.scope, t.last_used_at
        FROM tokens t JOIN oauth_grants g ON g.id = t.id
        WHERE COALESCE(g.refresh_expires_at, g.access_expires_at, g.code_expires_at) > ?
        ORDER BY t.created_at, t.id`,
        Date.now(),
      )
      .toArray();
  }

  revoke(id: string): boolean {
    return (
      this.storage.sql.exec(
        "DELETE FROM tokens WHERE id = ? AND EXISTS (SELECT 1 FROM oauth_grants WHERE id = ?)",
        id,
        id,
      ).rowsWritten > 0
    );
  }
}
