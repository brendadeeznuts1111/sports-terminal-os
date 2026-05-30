/**
 * PM2 Ecosystem Configuration — Sports Terminal OS
 *
 * Defines 4 processes:
 *   1. st-api        — Main Bun.serve API server
 *   2. st-risk-bot   — Risk alert Telegram bot worker
 *   3. st-payment-bot — Payment event Telegram bot worker
 *   4. st-agent-bot  — Agent event Telegram bot worker
 *
 * Features:
 *   - Auto-restart on crash
 *   - Memory limits with auto-restart
 *   - Log rotation per process
 *   - Environment variables per process
 *   - Separate log files for each process
 */

const DB_PATH = process.env.DB_PATH || "/data/sports-terminal.db";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

module.exports = {
  apps: [
    // ─── Main API Server ───────────────────────────────────────────────────
    {
      name: "st-api",
      script: "bun",
      args: "run src/index.ts",
      cwd: ".",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      kill_timeout: 10000,
      listen_timeout: 10000,
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        DB_PATH,
        REDIS_URL,
      },
      log_file: "./logs/api.log",
      out_file: "./logs/api.out.log",
      error_file: "./logs/api.error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS",
      merge_logs: true,
    },

    // ─── Risk Bot Worker ───────────────────────────────────────────────────
    {
      name: "st-risk-bot",
      script: "bun",
      args: "run workers/TelegramBotWorker.ts",
      cwd: ".",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      kill_timeout: 15000,
      env: {
        NODE_ENV: "production",
        BOT_ID: "risk_bot",
        STREAMS: "risk_alerts",
        DB_PATH,
        REDIS_URL,
        BLOCK_TIMEOUT_MS: "5000",
        HEARTBEAT_INTERVAL_MS: "30000",
        STALE_CLAIM_INTERVAL_MS: "30000",
        MAX_BATCH_SIZE: "10",
      },
      log_file: "./logs/risk-bot.log",
      out_file: "./logs/risk-bot.out.log",
      error_file: "./logs/risk-bot.error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS",
      merge_logs: true,
    },

    // ─── Payment Bot Worker ────────────────────────────────────────────────
    {
      name: "st-payment-bot",
      script: "bun",
      args: "run workers/TelegramBotWorker.ts",
      cwd: ".",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      kill_timeout: 15000,
      env: {
        NODE_ENV: "production",
        BOT_ID: "payment_bot",
        STREAMS: "payment_events",
        DB_PATH,
        REDIS_URL,
        BLOCK_TIMEOUT_MS: "5000",
        HEARTBEAT_INTERVAL_MS: "30000",
        STALE_CLAIM_INTERVAL_MS: "30000",
        MAX_BATCH_SIZE: "10",
      },
      log_file: "./logs/payment-bot.log",
      out_file: "./logs/payment-bot.out.log",
      error_file: "./logs/payment-bot.error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS",
      merge_logs: true,
    },

    // ─── Agent Bot Worker ──────────────────────────────────────────────────
    {
      name: "st-agent-bot",
      script: "bun",
      args: "run workers/TelegramBotWorker.ts",
      cwd: ".",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      kill_timeout: 15000,
      env: {
        NODE_ENV: "production",
        BOT_ID: "agent_bot",
        STREAMS: "agent_events",
        DB_PATH,
        REDIS_URL,
        BLOCK_TIMEOUT_MS: "5000",
        HEARTBEAT_INTERVAL_MS: "30000",
        STALE_CLAIM_INTERVAL_MS: "30000",
        MAX_BATCH_SIZE: "10",
      },
      log_file: "./logs/agent-bot.log",
      out_file: "./logs/agent-bot.out.log",
      error_file: "./logs/agent-bot.error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS",
      merge_logs: true,
    },
  ],
};
