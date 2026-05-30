/**
 * Buckeye Session Management
 *
 * Handles creation, retrieval, renewal, and cleanup of Buckeye sessions.
 * Sessions are stored in the buckeye_sessions table and used for proxying
 * requests to the upstream Buckeye API (fantasy402.com:443).
 *
 * A session consists of:
 *   - session_id: UUID for the session
 *   - token: JWT from Buckeye (encrypted at rest)
 *   - cf_clearance: Cloudflare clearance cookie
 *   - expires_at: Unix epoch when the session expires
 */

import { getDb } from "@db/index";
import { signSessionToken } from "./jwt";
import { logDebug, logError } from "@utils/logger";
import { logBuckeye } from "@utils/tableLogger";
import { AuthError } from "@utils/errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionData {
  sessionId: string;
  token: string;
  expiresAt: number;
  cfToken?: string;
  userAgent?: string;
  ipAddress?: string;
  isActive: boolean;
  metadata?: Record<string, unknown>;
}

export interface SessionCreateInput {
  token: string;
  expiresAt?: number;
  cfToken?: string;
  userAgent?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new Buckeye session record.
 */
export function createSession(input: SessionCreateInput): SessionData {
  const db = getDb();
  const sessionId = crypto.randomUUID();
  const expiresAt = input.expiresAt || Math.floor(Date.now() / 1000) + 86400;

  try {
    db.run(
      `INSERT INTO buckeye_sessions (
        session_id, token, expires_at, cf_token, user_agent, ip_address, metadata_json, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        sessionId,
        input.token,
        expiresAt,
        input.cfToken || null,
        input.userAgent || null,
        input.ipAddress || null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ]
    );

    logBuckeye({
      endpoint: "/api/proxy/auth",
      method: "POST",
      statusCode: 200,
      sessionId,
    });

    return {
      sessionId,
      token: input.token,
      expiresAt,
      cfToken: input.cfToken,
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
      isActive: true,
      metadata: input.metadata,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logError("BuckeyeAudit", "Failed to create session", { error: message });
    throw new AuthError("Failed to create session", "SESSION_CREATE_ERROR");
  }
}

/**
 * Get a session by its ID.
 * Returns null if not found or expired.
 */
export function getSession(sessionId: string): SessionData | null {
  const db = getDb();

  try {
    const row = db
      .query(
        `SELECT session_id, token, expires_at, cf_token, user_agent, ip_address,
                metadata_json, is_active
         FROM buckeye_sessions
         WHERE session_id = ? AND is_active = 1`
      )
      .get(sessionId) as
      | {
          session_id: string;
          token: string;
          expires_at: number;
          cf_token: string | null;
          user_agent: string | null;
          ip_address: string | null;
          metadata_json: string | null;
          is_active: number;
        }
      | undefined;

    if (!row) return null;

    // Check expiration
    if (row.expires_at < Math.floor(Date.now() / 1000)) {
      // Auto-deactivate expired session
      deactivateSession(sessionId);
      return null;
    }

    return {
      sessionId: row.session_id,
      token: row.token,
      expiresAt: row.expires_at,
      cfToken: row.cf_token || undefined,
      userAgent: row.user_agent || undefined,
      ipAddress: row.ip_address || undefined,
      isActive: row.is_active === 1,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logError("BuckeyeAudit", "Failed to get session", { error: message, sessionId });
    return null;
  }
}

/**
 * Renew a session by extending its expiration.
 */
export function renewSession(
  sessionId: string,
  newToken?: string,
  newExpiresAt?: number
): SessionData | null {
  const db = getDb();
  const expiresAt = newExpiresAt || Math.floor(Date.now() / 1000) + 86400;

  try {
    const existing = getSession(sessionId);
    if (!existing) return null;

    db.run(
      `UPDATE buckeye_sessions
       SET token = COALESCE(?, token),
           expires_at = ?,
           updated_at = strftime('%s','now')
       WHERE session_id = ?`,
      [newToken || existing.token, expiresAt, sessionId]
    );

    logBuckeye({
      endpoint: "/api/proxy/renewToken",
      method: "POST",
      statusCode: 200,
      sessionId,
    });

    return {
      ...existing,
      token: newToken || existing.token,
      expiresAt,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logError("BuckeyeAudit", "Failed to renew session", { error: message, sessionId });
    return null;
  }
}

/**
 * Deactivate a session (soft delete).
 */
export function deactivateSession(sessionId: string): boolean {
  const db = getDb();

  try {
    db.run(
      `UPDATE buckeye_sessions
       SET is_active = 0, updated_at = strftime('%s','now')
       WHERE session_id = ?`,
      [sessionId]
    );

    logDebug("BuckeyeAudit", `Session deactivated: ${sessionId}`);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logError("BuckeyeAudit", "Failed to deactivate session", { error: message, sessionId });
    return false;
  }
}

/**
 * Clean up expired sessions from the database.
 * Called by the sandbox janitor cron job.
 */
export function cleanupExpiredSessions(): number {
  const db = getDb();

  try {
    const result = db.run(
      `DELETE FROM buckeye_sessions
       WHERE expires_at < strftime('%s','now') - 86400
       AND is_active = 0`,
      []
    );

    const deleted = result.changes || 0;
    if (deleted > 0) {
      logDebug("BuckeyeAudit", `Cleaned up ${deleted} expired sessions`);
    }
    return deleted;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logError("BuckeyeAudit", "Failed to cleanup sessions", { error: message });
    return 0;
  }
}

/**
 * Get the most recent active session for an agent.
 */
export function getLatestSessionForAgent(agentLogin: string): SessionData | null {
  const db = getDb();

  try {
    const row = db
      .query(
        `SELECT session_id, token, expires_at, cf_token, user_agent, ip_address,
                metadata_json, is_active
         FROM buckeye_sessions
         WHERE is_active = 1
         AND (metadata_json LIKE ? OR ip_address IS NOT NULL)
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(`%"agentLogin":"${agentLogin}"%`) as
      | {
          session_id: string;
          token: string;
          expires_at: number;
          cf_token: string | null;
          user_agent: string | null;
          ip_address: string | null;
          metadata_json: string | null;
          is_active: number;
        }
      | undefined;

    if (!row) return null;

    return {
      sessionId: row.session_id,
      token: row.token,
      expiresAt: row.expires_at,
      cfToken: row.cf_token || undefined,
      userAgent: row.user_agent || undefined,
      ipAddress: row.ip_address || undefined,
      isActive: row.is_active === 1,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Update the cf_clearance cookie for an active session.
 * Called by the Shadow Agent Worker after extracting fresh Cloudflare cookies.
 */
export function updateSessionCfToken(
  sessionId: string,
  cfToken: string,
  expiresAt?: number
): boolean {
  const db = getDb();
  const expiry = expiresAt || Math.floor(Date.now() / 1000) + 1800; // 30 min default

  try {
    const result = db.run(
      `UPDATE buckeye_sessions
       SET cf_token = ?, expires_at = MAX(expires_at, ?), updated_at = strftime('%s','now')
       WHERE session_id = ? AND is_active = 1`,
      [cfToken, expiry, sessionId]
    );

    if (result.changes === 0) {
      logError("BuckeyeAudit", "CfToken update: session not found or inactive", { sessionId });
      return false;
    }

    logBuckeye({
      endpoint: "/api/internal/update-cookies",
      method: "POST",
      statusCode: 200,
      sessionId,
    });

    logDebug("BuckeyeAudit", `CfToken updated for session ${sessionId} (expires ~${new Date(expiry * 1000).toISOString()})`);
    return true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logError("BuckeyeAudit", "Failed to update cf_token", { error: message, sessionId });
    return false;
  }
}

/**
 * List IDs of all active, non-expired sessions.
 * Used by the internal cookie endpoint to validate incoming sessionId.
 */
export function listActiveSessions(): Array<{ sessionId: string; expiresAt: number }> {
  const db = getDb();

  try {
    const rows = db
      .query(
        `SELECT session_id, expires_at FROM buckeye_sessions
         WHERE is_active = 1 AND expires_at > strftime('%s','now')
         ORDER BY expires_at ASC`
      )
      .all() as Array<{ session_id: string; expires_at: number }>;

    return rows.map((r) => ({
      sessionId: r.session_id,
      expiresAt: r.expires_at,
    }));
  } catch {
    return [];
  }
}

/**
 * Count active sessions.
 */
export function countActiveSessions(): number {
  const db = getDb();

  try {
    const row = db
      .query(
        `SELECT COUNT(*) as count FROM buckeye_sessions WHERE is_active = 1 AND expires_at > strftime('%s','now')`
      )
      .get() as { count: number } | undefined;
    return row?.count || 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Session-aware proxy helper
// ---------------------------------------------------------------------------

/**
 * Build headers for proxying a request to Buckeye.
 * Includes the session token and cf_clearance cookie.
 */
export function buildProxyHeaders(
  session: SessionData,
  extraHeaders?: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.token}`,
    ...extraHeaders,
  };

  if (session.cfToken) {
    headers["Cookie"] = `cf_clearance=${session.cfToken}`;
  }

  return headers;
}
