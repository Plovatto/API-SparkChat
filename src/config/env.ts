import 'dotenv/config';
import { z } from 'zod';
import { validateWebPushEnv } from './web-push-env.js';

const optionalSecret = z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  TURSO_DATABASE_URL: z.string().optional(),
  TURSO_AUTH_TOKEN: z.string().optional(),
  RECOVERY_FILE_SECRET: z.string().min(32),
  PASSWORD_SCRYPT_COST: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce
      .number()
      .int()
      .min(2 ** 14)
      .max(2 ** 17)
      .refine((value) => (value & (value - 1)) === 0, 'PASSWORD_SCRYPT_COST must be a power of two')
      .default(2 ** 16),
  ),
  GEMINI_API_KEY: z.string().min(1),
  AI_ASSISTANT_PRIVATE_KEY: z.string().min(1),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  R2_PUBLIC_BASE_URL: z.string().url(),
  CLOUDFLARE_TURN_KEY_ID: optionalSecret,
  CLOUDFLARE_TURN_API_TOKEN: optionalSecret,
  WEB_PUSH_VAPID_PUBLIC_KEY: optionalSecret,
  WEB_PUSH_VAPID_PRIVATE_KEY: optionalSecret,
  WEB_PUSH_SUBJECT: optionalSecret,
}).refine((value) => Boolean(value.CLOUDFLARE_TURN_KEY_ID) === Boolean(value.CLOUDFLARE_TURN_API_TOKEN), {
  message: 'CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN must be set together',
  path: ['CLOUDFLARE_TURN_API_TOKEN'],
}).superRefine((value, ctx) => {
  const issue = validateWebPushEnv(value);
  if (issue) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: [issue.path] });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten());
  throw new Error('Invalid environment variables');
}

export const env = parsed.data;
