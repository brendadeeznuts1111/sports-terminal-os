/**
 * Authentication Middleware
 *
 * Handles all authentication modes for incoming requests:
 *   1. API Key (X-API-Key header) — validates against ADMIN_API_TOKEN
 *   2. JWT Bearer token — verifies with jose
 *   3. Session cookie — validates Buckeye session
 *   4. Dev bypass — development mode auto-auth
 *
 * Decision flow (from system-architecture.md §7.2):
 *   Has X-API-Key? -> Validate -> pass
 *   Has Authorization? -> Verify JWT -> pass
 *   Has session cookie? -> Validate -> pass
 *   DEV_BYPASS_JWT=true? -> dev user -> pass
 *   None? -> 401 Unauthorized
 */

import { verifyToken, extractBearerToken, verifyTokenSafe } from "./jwt";
import { getSession } from "./session";
import { env } from "@utils/env";
import { logDebug, logError } from "@utils/logger";
import { AuthError, ForbiddenError } from "@utils/errors";
import type { AuthenticatedUser, AuthContext, UserRole } from "@utils/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MiddlewareResult {
  success: boolean;
  user?: AuthenticatedUser;
  method?: string;
  error?: AuthError;
}

// ---------------------------------------------------------------------------
// Helper: Generate request ID
// ---------------------------------------------------------------------------

function generateRequestId(): string {
  return `req_${Bun.randomUUIDv7().slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// Auth mode handlers
// ---------------------------------------------------------------------------

/**
 * Check API key authentication.
 * Validates X-API-Key header against ADMIN_API_TOKEN env var.
 */
async function checkApiKey(req: Request): Promise<MiddlewareResult> {
  const apiKey = req.headers.get("X-API-Key");
  if (!apiKey) return { success: false };

  if (!env.ADMIN_API_TOKEN) {
    logError("Auth", "API key auth attempted but ADMIN_API_TOKEN not configured");
    return { success: false, error: new AuthError("API key auth not configured", "API_KEY_NOT_CONFIGURED") };
  }

  if (apiKey !== env.ADMIN_API_TOKEN) {
    logDebug("Auth", "Invalid API key provided");
    return { success: false, error: new AuthError("Invalid API key", "INVALID_API_KEY") };
  }

  return {
    success: true,
    user: {
      id: "api_key_user",
      role: "admin",
      login: "api_key",
    },
    method: "apikey",
  };
}

/**
 * Check JWT Bearer token authentication.
 */
async function checkJwt(req: Request): Promise<MiddlewareResult> {
  const authHeader = req.headers.get("Authorization");
  const token = extractBearerToken(authHeader);
  if (!token) return { success: false };

  try {
    const payload = await verifyToken(token);
    return {
      success: true,
      user: {
        id: (payload.sub as string) || "unknown",
        login: (payload.login as string) || (payload.sub as string) || "unknown",
        role: (payload.role as UserRole) || "user",
        displayName: (payload.displayName as string) || undefined,
        email: (payload.email as string) || undefined,
        permissions: (payload.permissions as string[]) || undefined,
        jti: (payload.jti as string) || undefined,
        exp: payload.exp || undefined,
      },
      method: "jwt",
    };
  } catch (err: unknown) {
    if (err instanceof AuthError) {
      return { success: false, error: err };
    }
    return { success: false, error: new AuthError("Invalid token", "TOKEN_INVALID") };
  }
}

/**
 * Check session cookie authentication (Buckeye session).
 * Validates against buckeye_sessions table — must be active and non-expired.
 */
async function checkSession(req: Request): Promise<MiddlewareResult> {
  const sessionId = extractSessionCookie(req);
  if (!sessionId) return { success: false };

  try {
    const session = getSession(sessionId);
    if (!session) {
      logDebug("Auth", `Session ${sessionId.slice(0, 8)}... not found or expired`);
      return { success: false };
    }

    logDebug("Auth", `Session ${sessionId.slice(0, 8)}... validated (expires ${new Date(session.expiresAt * 1000).toISOString()})`);

    return {
      success: true,
      user: {
        id: session.sessionId,
        role: "user" as UserRole,
        displayName: "Buckeye Session",
        iat: Math.floor(Date.now() / 1000),
        exp: session.expiresAt,
      },
      method: "session",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Session lookup error";
    logError("Auth", `Session validation failed: ${msg}`);
    return { success: false };
  }
}

/**
 * Check dev bypass mode.
 */
function checkDevBypass(): MiddlewareResult {
  if (!env.DEV_BYPASS_JWT) return { success: false };

  logDebug("Auth", "Dev bypass active — authenticating as dev user");
  return {
    success: true,
    user: {
      id: "dev",
      login: "dev",
      role: "dev",
      displayName: "Developer",
    },
    method: "dev_bypass",
  };
}

// ---------------------------------------------------------------------------
// Main authentication function
// ---------------------------------------------------------------------------

/**
 * Authenticate an incoming request.
 * Tries each auth method in order and returns the first successful result.
 *
 * @returns AuthContext if authentication succeeds
 * @throws AuthError if all methods fail
 */
export async function authenticate(req: Request): Promise<AuthContext> {
  const requestId = generateRequestId();

  // Order matches the auth decision flow in system-architecture.md
  const methods: Array<() => Promise<MiddlewareResult> | MiddlewareResult> = [
    () => checkApiKey(req),
    () => checkJwt(req),
    () => checkSession(req),
    checkDevBypass,
  ];

  for (const method of methods) {
    try {
      const result = await method();
      if (result.success && result.user) {
        logDebug("Auth", `Authenticated via ${result.method}`, {
          userId: result.user.id,
          role: result.user.role,
          requestId,
        });
        return {
          user: result.user,
          method: (result.method || "unknown") as AuthContext["method"],
          requestId,
        };
      }
      if (result.error) {
        // This method was attempted but failed — continue to next
        continue;
      }
    } catch {
      // Method threw — continue to next
    }
  }

  // All methods failed
  throw new AuthError("Authentication required", "UNAUTHORIZED");
}

/**
 * Authenticate but don't throw — returns null if not authenticated.
 * Useful for public endpoints that optionally use auth.
 */
export async function authenticateOptional(req: Request): Promise<AuthContext | null> {
  try {
    return await authenticate(req);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

/**
 * Check if the authenticated user has one of the required roles.
 * @throws ForbiddenError if the user doesn't have permission
 */
export function requireRoles(
  auth: AuthContext,
  allowedRoles: UserRole[]
): void {
  if (!allowedRoles.includes(auth.user.role)) {
    throw new ForbiddenError(
      `Required role: ${allowedRoles.join(" or ")}`,
      "FORBIDDEN",
      { requiredRoles: allowedRoles, userRole: auth.user.role }
    );
  }
}

/**
 * Check if the authenticated user has admin-level access.
 */
export function requireAdmin(auth: AuthContext): void {
  requireRoles(auth, ["admin", "superadmin", "dev"]);
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function extractSessionCookie(req: Request): string | null {
  const cookieHeader = req.headers.get("Cookie");
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const sessionCookie = cookies.find((c) =>
    c.startsWith("buckeye_session=") || c.startsWith("session=")
  );
  return sessionCookie ? sessionCookie.split("=").slice(1).join("=") : null;
}

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------

/**
 * Get CORS headers for responses.
 */
export function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "*";
  const isDev = env.NODE_ENV === "development";

  return {
    "Access-Control-Allow-Origin": isDev ? origin : env.HOST === "0.0.0.0" ? "*" : origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Admin-Token, X-Request-ID",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * Handle CORS preflight OPTIONS requests.
 */
export function handleCorsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Admin-Token, X-Request-ID",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
    },
  });
}
