/**
 * JWT Sign/Verify using jose library
 *
 * Provides HS256 token creation and verification.
 * Used by the auth middleware to authenticate requests.
 *
 * Environment:
 *   JWT_SECRET — Required, minimum 32 characters
 *   DEV_BYPASS_JWT — When true, skips verification (dev only)
 */

import { SignJWT, jwtVerify, JWTPayload } from "jose";
import { env } from "@utils/env";
import { logError, logDebug } from "@utils/logger";
import { AuthError } from "@utils/errors";

// ---------------------------------------------------------------------------
// Key setup
// ---------------------------------------------------------------------------

const getSecret = (): Uint8Array => {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    throw new AuthError(
      "JWT_SECRET must be set and at least 32 characters long",
      "JWT_SECRET_MISSING"
    );
  }
  return new TextEncoder().encode(env.JWT_SECRET);
};

// ---------------------------------------------------------------------------
// Token signing
// ---------------------------------------------------------------------------

/**
 * Sign a JWT token with HS256.
 *
 * @param payload — Claims to include in the token
 * @param expiresIn — Token lifetime in seconds (default: 24 hours)
 * @returns Signed JWT string
 */
export async function signToken(
  payload: Record<string, unknown>,
  expiresIn: number = 86400
): Promise<string> {
  try {
    const secret = getSecret();
    const jwt = new SignJWT(payload as unknown as JWTPayload)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
      .setJti(crypto.randomUUID());

    const token = await jwt.sign(secret);
    logDebug("JWT", "Token signed", { sub: payload.sub as string, jti: payload.jti as string });
    return token;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logError("JWT", "Token signing failed", { error: message });
    throw new AuthError("Failed to sign token", "TOKEN_SIGN_ERROR");
  }
}

/**
 * Sign a token specifically for Buckeye session emulation.
 */
export async function signSessionToken(
  userId: string,
  login: string,
  role: string,
  extras?: Record<string, unknown>
): Promise<{ token: string; expiresAt: number }> {
  const expiresIn = 86400; // 24 hours
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  const token = await signToken(
    {
      sub: userId,
      login,
      role,
      ...extras,
    },
    expiresIn
  );

  return { token, expiresAt };
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

/**
 * Verify a JWT token.
 *
 * @param token — JWT string to verify
 * @returns Decoded payload if valid
 * @throws AuthError if invalid or expired
 */
export async function verifyToken(token: string): Promise<JWTPayload> {
  // Dev bypass — skip verification in development
  if (env.DEV_BYPASS_JWT) {
    logDebug("JWT", "Dev bypass active — skipping verification");
    return parseDevToken(token);
  }

  try {
    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret, {
      clockTolerance: 60, // 1 minute clock skew tolerance
      maxTokenAge: "24h",
    });

    logDebug("JWT", "Token verified", { sub: payload.sub as string });
    return payload;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    logError("JWT", "Token verification failed", { error: message });

    if (message.includes("expired")) {
      throw new AuthError("Token has expired", "TOKEN_EXPIRED");
    }
    if (message.includes("signature")) {
      throw new AuthError("Invalid token signature", "TOKEN_INVALID");
    }
    throw new AuthError("Invalid token", "TOKEN_INVALID");
  }
}

/**
 * Verify a token without throwing — returns null on failure.
 */
export async function verifyTokenSafe(token: string): Promise<JWTPayload | null> {
  try {
    return await verifyToken(token);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract Bearer token from Authorization header.
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Parse a token in dev mode (no verification).
 * Extracts claims from the JWT payload segment.
 */
function parseDevToken(token: string): JWTPayload {
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1]));
      logDebug("JWT", "Dev mode — parsed token without verification", {
        sub: payload.sub,
      });
      return payload;
    }
  } catch {
    // Ignore parse errors in dev mode
  }
  // Return a default dev user
  return {
    sub: "dev_user",
    role: "dev",
    login: "dev",
    iat: Math.floor(Date.now() / 1000),
  };
}

/**
 * Check if a token is expired based on its exp claim.
 */
export function isTokenExpired(payload: JWTPayload): boolean {
  if (!payload.exp) return false;
  return payload.exp < Math.floor(Date.now() / 1000);
}

/**
 * Get remaining token lifetime in seconds.
 */
export function getTokenTtl(payload: JWTPayload): number {
  if (!payload.exp) return 0;
  return Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
}
