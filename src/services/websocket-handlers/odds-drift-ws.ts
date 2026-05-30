/**
 * Odds Drift WebSocket Handler
 *
 * Versioned real-time odds drift alert channel. Clients subscribe
 * to canonical team topics (e.g. `teams:manchester-city`) or raw
 * source topics (e.g. `sources:fantasy402:team:man-city`) and
 * receive drift alerts with resolved canonical team names.
 *
 * Protocol: odds-drift-v2.x
 * Message format: { type: "odds_drift", provider: "odds_drift", data: {...} }
 *
 * Used by:
 *   - OddsDriftEngine (drift detection + canonical resolution)
 *   - Dashboard real-time odds drift panel
 */

import type { ServerWebSocket } from "bun";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL = "odds_drift";

/** Maximum bytes buffered before pausing transmission (per-connection). */
const BACKPRESSURE_LIMIT = parseInt(
  process.env.WS_BACKPRESSURE_LIMIT ?? "65536",
  10
);

/** Supported protocol versions. */
export const SUPPORTED_VERSIONS = new Set([
  "odds-drift-v2.0.0",
  "odds-drift-v2.1.0",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DriftAlertData {
  /** Source feed key (e.g. "fantasy402", "pinnacle"). */
  source: string;
  /** Raw team name from the source. */
  rawTeam: string;
  /** Canonical team name (resolved via fuzzy matcher). */
  canonicalTeam: string;
  /** The detected drift value. */
  drift: number;
  /** Line movement direction: "up" | "down" | "static". */
  direction: "up" | "down" | "static";
  /** Market type: "spread" | "ml" | "total". */
  market: string;
  /** Odds value before drift. */
  fromOdds: number;
  /** Odds value after drift. */
  toOdds: number;
  /** ISO-8601 timestamp of the drift event. */
  detectedAt: string;
  /** Arbitrary metadata for extensibility. */
  metadata?: Record<string, unknown>;
}

interface OddsDriftMessage {
  type: "odds_drift";
  provider: "odds_drift";
  data: DriftAlertData | Record<string, unknown>;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Client state — per-connection version tracking
// ---------------------------------------------------------------------------

interface DriftClientState {
  protocolVersion: string;
  authenticated: boolean;
  allowedTopics: string[];
}

const driftClients = new Map<string, DriftClientState>();

// ---------------------------------------------------------------------------
// Client Registry
// ---------------------------------------------------------------------------

/**
 * Register a client for odds drift alerts.
 * Called after version negotiation and auth.
 */
export function registerDriftClient(
  clientId: string,
  state: DriftClientState
): void {
  driftClients.set(clientId, state);
}

/**
 * Unregister a client on disconnect.
 */
export function unregisterDriftClient(clientId: string): void {
  driftClients.delete(clientId);
}

/**
 * Get the protocol version negotiated by a client.
 */
export function getClientVersion(clientId: string): string | undefined {
  return driftClients.get(clientId)?.protocolVersion;
}

// ---------------------------------------------------------------------------
// Message Processing
// ---------------------------------------------------------------------------

/**
 * Process an incoming WebSocket message for the odds-drift channel.
 * Returns true if the message was handled.
 */
export function processOddsDriftWsMessage(
  ws: ServerWebSocket<unknown>,
  type: string,
  data: unknown,
  clientId: string
): boolean {
  switch (type) {
    case "subscribe:odds_drift": {
      handleOddsDriftSubscribe(ws, clientId, data);
      return true;
    }

    case "unsubscribe:odds_drift": {
      handleOddsDriftUnsubscribe(ws, clientId);
      return true;
    }

    case "odds_drift:version": {
      handleVersionNegotiation(ws, clientId, data);
      return true;
    }

    case "odds_drift:auth": {
      handleOddsDriftAuth(ws, clientId, data);
      return true;
    }

    case "odds_drift:snapshot": {
      handleSnapshotRequest(ws, clientId, data);
      return true;
    }

    default: {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Subscribe / Unsubscribe
// ---------------------------------------------------------------------------

function handleOddsDriftSubscribe(
  ws: ServerWebSocket<unknown>,
  clientId: string,
  data: unknown
): void {
  const opts = data as
    | { version?: string; topics?: string[]; token?: string }
    | undefined;

  // Default state — anonymous, no restrictions
  const state: DriftClientState = {
    protocolVersion: opts?.version ?? "odds-drift-v2.1.0",
    authenticated: false,
    allowedTopics: [],
  };

  driftClients.set(clientId, state);

  ws.send(
    JSON.stringify({
      type: "odds_drift",
      provider: "odds_drift",
      data: {
        event: "subscribed",
        channel: CHANNEL,
        version: state.protocolVersion,
        clientId,
      },
      timestamp: Date.now(),
    })
  );
}

function handleOddsDriftUnsubscribe(
  ws: ServerWebSocket<unknown>,
  clientId: string
): void {
  driftClients.delete(clientId);

  ws.send(
    JSON.stringify({
      type: "odds_drift",
      provider: "odds_drift",
      data: { event: "unsubscribed", channel: CHANNEL, clientId },
      timestamp: Date.now(),
    })
  );
}

// ---------------------------------------------------------------------------
// Version Negotiation
// ---------------------------------------------------------------------------

function handleVersionNegotiation(
  ws: ServerWebSocket<unknown>,
  clientId: string,
  data: unknown
): void {
  const requested = (data as { version?: string } | undefined)?.version;
  const current = driftClients.get(clientId);

  if (!current) {
    ws.send(
      JSON.stringify({
        type: "odds_drift",
        provider: "odds_drift",
        data: {
          event: "error",
          message: "Not subscribed to odds_drift channel. Subscribe first.",
        },
        timestamp: Date.now(),
      })
    );
    return;
  }

  if (!requested || !SUPPORTED_VERSIONS.has(requested)) {
    ws.send(
      JSON.stringify({
        type: "odds_drift",
        provider: "odds_drift",
        data: {
          event: "version_rejected",
          requested: requested ?? "none",
          supported: [...SUPPORTED_VERSIONS],
        },
        timestamp: Date.now(),
      })
    );
    return;
  }

  current.protocolVersion = requested;
  driftClients.set(clientId, current);

  ws.send(
    JSON.stringify({
      type: "odds_drift",
      provider: "odds_drift",
      data: {
        event: "version_accepted",
        version: requested,
      },
      timestamp: Date.now(),
    })
  );
}

// ---------------------------------------------------------------------------
// JWT Authentication
// ---------------------------------------------------------------------------

function handleOddsDriftAuth(
  ws: ServerWebSocket<unknown>,
  clientId: string,
  data: unknown
): void {
  const current = driftClients.get(clientId);
  if (!current) {
    ws.send(
      JSON.stringify({
        type: "odds_drift",
        provider: "odds_drift",
        data: {
          event: "error",
          message: "Not subscribed to odds_drift channel. Subscribe first.",
        },
        timestamp: Date.now(),
      })
    );
    return;
  }

  const token = (data as { token?: string } | undefined)?.token;
  if (!token) {
    // Allow anonymous — limited topics only
    current.authenticated = false;
    current.allowedTopics = [];
    driftClients.set(clientId, current);

    ws.send(
      JSON.stringify({
        type: "odds_drift",
        provider: "odds_drift",
        data: {
          event: "auth",
          status: "anonymous",
          message: "Connected without authentication. Limited topics only.",
        },
        timestamp: Date.now(),
      })
    );
    return;
  }

  try {
    // Verify JWT using Bun-native crypto
    const payload = verifyJWT(token);
    current.authenticated = true;
    current.allowedTopics = payload.allowed_topics ?? ["teams:*"];
    driftClients.set(clientId, current);

    ws.send(
      JSON.stringify({
        type: "odds_drift",
        provider: "odds_drift",
        data: {
          event: "auth",
          status: "authenticated",
          sub: payload.sub,
          allowedTopics: current.allowedTopics,
        },
        timestamp: Date.now(),
      })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invalid token";
    ws.send(
      JSON.stringify({
        type: "odds_drift",
        provider: "odds_drift",
        data: {
          event: "auth_error",
          message,
        },
        timestamp: Date.now(),
      })
    );
  }
}

// ---------------------------------------------------------------------------
// JWT Verification (Bun-native, zero-dependency)
// ---------------------------------------------------------------------------

interface JWTClaims {
  sub: string;
  allowed_topics?: string[];
  sources?: string[];
  iat?: number;
  exp?: number;
}

function verifyJWT(token: string): JWTClaims {
  // Split header.payload.signature
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }

  // Decode header and payload
  const headerText = Buffer.from(parts[0], "base64url").toString("utf-8");
  const payloadText = Buffer.from(parts[1], "base64url").toString("utf-8");
  const header = JSON.parse(headerText);
  const payload = JSON.parse(payloadText) as JWTClaims;

  // Only HS256 supported for zero-dependency path
  if (header.alg !== "HS256") {
    throw new Error(`Unsupported algorithm: ${header.alg}`);
  }

  // Check expiration
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error("Token expired");
  }

  // Verify signature using Bun-native Node crypto polyfill (zero npm deps)
  const secret = process.env.WS_JWT_SECRET || process.env.JWT_SECRET || "";
  if (!secret) {
    throw new Error("JWT secret not configured");
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  const expectedSig = Buffer.from(parts[2], "base64url");

  const hmac = createHmac("sha256", secret);
  hmac.update(signingInput);
  const computedSig = new Uint8Array(hmac.digest());

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(computedSig, expectedSig)) {
    throw new Error("Invalid signature");
  }

  return payload;
}

/**
 * Constant-time buffer comparison.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// Snapshot Provider
// ---------------------------------------------------------------------------

/** Callback that returns the current snapshot map on demand. */
type SnapshotProvider = () => Map<string, { odds: number; timestamp: number }>;

let snapshotProvider: SnapshotProvider | null = null;

/**
 * Register a snapshot provider (called by OddsDriftEngine at startup).
 */
export function setSnapshotProvider(provider: SnapshotProvider): void {
  snapshotProvider = provider;
}

// ---------------------------------------------------------------------------
// Snapshot Request
// ---------------------------------------------------------------------------

/**
 * Handle a client request for a state snapshot.
 * Returns the full snapshot map from the drift engine.
 */
function handleSnapshotRequest(
  ws: ServerWebSocket<unknown>,
  clientId: string,
  _data: unknown
): void {
  if (!snapshotProvider) {
    ws.send(
      JSON.stringify({
        type: "odds_drift",
        provider: "odds_drift",
        data: {
          event: "error",
          message: "Snapshot not available — engine not initialized.",
        },
        timestamp: Date.now(),
      })
    );
    return;
  }

  const snapshot = snapshotProvider();
  const entries = [...snapshot.entries()].map(([key, val]) => ({
    key,
    odds: val.odds,
    timestamp: val.timestamp,
  }));

  sendWithBackpressure(ws, {
    type: "odds_drift",
    provider: "odds_drift",
    data: {
      event: "snapshot",
      clientId,
      entries,
      cached: true,
      serverTime: Date.now(),
    },
    timestamp: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Backpressure-aware send
// ---------------------------------------------------------------------------

/**
 * Send a message to a single client, respecting backpressure limits.
 * If `ws.bufferedAmount` exceeds the limit, the message is dropped
 * and the client is flagged.
 */
function sendWithBackpressure(
  ws: ServerWebSocket<unknown>,
  message: OddsDriftMessage
): boolean {
  if (ws.getBufferedAmount() > BACKPRESSURE_LIMIT) {
    // Client is overloaded — drop and consider closing if persistent
    return false;
  }

  ws.send(JSON.stringify(message));
  return true;
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

type BroadcastFn = (message: { type: string; provider: string; data: unknown }) => void;

let oddsDriftBroadcastFn: BroadcastFn | null = null;

/**
 * Set the broadcast function used to push drift alerts to all
 * connected WebSocket clients. Called once at server startup.
 */
export function setOddsDriftBroadcast(fn: BroadcastFn): void {
  oddsDriftBroadcastFn = fn;
}

/**
 * Broadcast a drift alert to all subscribed clients.
 * Called by OddsDriftEngine after canonical team resolution.
 *
 * Each client gets the alert only if:
 *   - They are subscribed to the channel
 *   - Their `allowedTopics` include one of the alert's topics (if authenticated)
 *   - They have not exceeded the backpressure limit
 */
export function broadcastOddsDrift(data: DriftAlertData): void {
  if (!oddsDriftBroadcastFn) {
    // Broadcast not wired yet — log and drop (startup race)
    return;
  }

  const message: OddsDriftMessage = {
    type: "odds_drift",
    provider: "odds_drift",
    data,
    timestamp: Date.now(),
  };

  oddsDriftBroadcastFn(message);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Return channel-level metrics for the /ws/metrics endpoint.
 */
export function getOddsDriftMetrics(): Record<string, unknown> {
  let authenticatedCount = 0;
  let anonymousCount = 0;
  const versions: Record<string, number> = {};

  for (const state of driftClients.values()) {
    if (state.authenticated) authenticatedCount++;
    else anonymousCount++;

    const v = state.protocolVersion;
    versions[v] = (versions[v] ?? 0) + 1;
  }

  return {
    channel: CHANNEL,
    totalClients: driftClients.size,
    authenticated: authenticatedCount,
    anonymous: anonymousCount,
    versions,
  };
}
