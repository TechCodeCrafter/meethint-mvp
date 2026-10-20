import type { CodeFile } from "./search";

// A small, realistic sample codebase so the app can be tested instantly.
export const DEMO_FILES: CodeFile[] = [
  {
    path: "src/payments/retry.ts",
    content: `import { stripe } from "./stripeClient";
import { logger } from "../lib/logger";
import { notifyBillingFailure } from "../notifications/email";

/** Maximum number of times we retry a failed charge before giving up. */
export const MAX_PAYMENT_RETRIES = 4;

/** Base delay for exponential backoff between retries (in ms). */
export const RETRY_BASE_DELAY_MS = 2_000;

/** Stripe decline codes that are worth retrying. Hard declines are never retried. */
const RETRYABLE_CODES = new Set(["card_declined", "processing_error", "rate_limit", "api_connection_error"]);

export function backoffDelay(attempt: number): number {
  // 2s, 4s, 8s, 16s ... capped at 60s, plus up to 500ms jitter
  const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), 60_000);
  return delay + Math.floor(Math.random() * 500);
}

/**
 * Charges a customer, retrying transient failures with exponential backoff.
 * After MAX_PAYMENT_RETRIES failed attempts the invoice is marked past_due
 * and the customer receives a billing failure email.
 */
export async function chargeWithRetry(customerId: string, amountCents: number, invoiceId: string) {
  let attempt = 0;
  while (attempt < MAX_PAYMENT_RETRIES) {
    attempt++;
    try {
      const intent = await stripe.paymentIntents.create(
        { customer: customerId, amount: amountCents, currency: "usd", confirm: true, off_session: true },
        { idempotencyKey: \`\${invoiceId}-attempt-\${attempt}\` }
      );
      logger.info("payment.succeeded", { invoiceId, attempt });
      return intent;
    } catch (err: any) {
      const code = err?.code ?? err?.raw?.code;
      if (!RETRYABLE_CODES.has(code)) {
        logger.warn("payment.hard_decline", { invoiceId, code });
        break;
      }
      logger.warn("payment.retrying", { invoiceId, attempt, code });
      await new Promise((r) => setTimeout(r, backoffDelay(attempt)));
    }
  }
  await markInvoicePastDue(invoiceId);
  await notifyBillingFailure(customerId, invoiceId);
  return null;
}

async function markInvoicePastDue(invoiceId: string) {
  const { supabase } = await import("../lib/db");
  await supabase.from("invoices").update({ status: "past_due" }).eq("id", invoiceId);
}
`,
  },
  {
    path: "src/payments/stripeClient.ts",
    content: `import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-06-20",
  maxNetworkRetries: 2, // Stripe SDK-level retries for network errors only
  timeout: 15_000,
});
`,
  },
  {
    path: "src/users/preferences.ts",
    content: `import { supabase } from "../lib/db";

export type UserPreferences = {
  theme: "light" | "dark" | "system";
  emailDigest: "daily" | "weekly" | "off";
  timezone: string;
  language: string;
};

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: "system",
  emailDigest: "weekly",
  timezone: "UTC",
  language: "en",
};

/**
 * User preferences are stored in the user_preferences table (one row per user),
 * as a JSONB column called settings. The client also caches them in localStorage.
 */
export async function getUserPreferences(userId: string): Promise<UserPreferences> {
  const { data } = await supabase.from("user_preferences").select("settings").eq("user_id", userId).single();
  return { ...DEFAULT_PREFERENCES, ...(data?.settings ?? {}) };
}

export async function saveUserPreferences(userId: string, prefs: Partial<UserPreferences>) {
  const current = await getUserPreferences(userId);
  const settings = { ...current, ...prefs };
  await supabase.from("user_preferences").upsert({ user_id: userId, settings, updated_at: new Date().toISOString() });
  return settings;
}
`,
  },
  {
    path: "web/hooks/usePreferences.ts",
    content: `import { useEffect, useState } from "react";

const CACHE_KEY = "prefs:v2";

export function usePreferences() {
  const [prefs, setPrefs] = useState(() => {
    const cached = typeof window !== "undefined" ? localStorage.getItem(CACHE_KEY) : null;
    return cached ? JSON.parse(cached) : null;
  });

  useEffect(() => {
    fetch("/api/me/preferences")
      .then((r) => r.json())
      .then((p) => {
        setPrefs(p);
        localStorage.setItem(CACHE_KEY, JSON.stringify(p));
      });
  }, []);

  return prefs;
}
`,
  },
  {
    path: "src/middleware/rateLimit.ts",
    content: `import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

/** Default limits per API key, per rolling window. */
export const RATE_LIMITS = {
  default: { requests: 100, windowSeconds: 60 },
  search: { requests: 30, windowSeconds: 60 },
  checkout: { requests: 10, windowSeconds: 60 },
};

export async function rateLimit(apiKey: string, bucket: keyof typeof RATE_LIMITS = "default") {
  const { requests, windowSeconds } = RATE_LIMITS[bucket];
  const key = \`rl:\${bucket}:\${apiKey}\`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSeconds);
  return { allowed: count <= requests, remaining: Math.max(0, requests - count), resetIn: windowSeconds };
}
`,
  },
  {
    path: "src/api/routes.ts",
    content: `import { Router } from "express";
import { rateLimit } from "../middleware/rateLimit";
import { chargeWithRetry } from "../payments/retry";
import { getUserPreferences, saveUserPreferences } from "../users/preferences";

export const router = Router();

router.post("/checkout", async (req, res) => {
  const rl = await rateLimit(req.header("x-api-key")!, "checkout");
  if (!rl.allowed) return res.status(429).json({ error: "Too many requests" });
  const result = await chargeWithRetry(req.body.customerId, req.body.amount, req.body.invoiceId);
  res.json({ ok: !!result });
});

router.get("/me/preferences", async (req, res) => {
  res.json(await getUserPreferences(req.user.id));
});

router.put("/me/preferences", async (req, res) => {
  res.json(await saveUserPreferences(req.user.id, req.body));
});
`,
  },
  {
    path: "supabase/migrations/0007_user_preferences.sql",
    content: `CREATE TABLE IF NOT EXISTS user_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own prefs" ON user_preferences FOR ALL USING (auth.uid() = user_id);
`,
  },
  {
    path: "src/notifications/email.ts",
    content: `import { Resend } from "resend";
const resend = new Resend(process.env.RESEND_API_KEY);

export async function notifyBillingFailure(customerId: string, invoiceId: string) {
  // Sent once after all payment retries are exhausted
  await resend.emails.send({
    from: "billing@acme.dev",
    to: await lookupEmail(customerId),
    subject: "Your payment didn't go through",
    html: \`<p>We couldn't charge your card for invoice \${invoiceId}. Please update your payment method.</p>\`,
  });
}

async function lookupEmail(customerId: string) {
  return \`\${customerId}@example.com\`;
}
`,
  },
];
