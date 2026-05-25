/* eslint-disable no-console */
/**
 * Generate a valid JWT access token for an admin user in local dev.
 * Used to bypass the login UI in tests when the admin password is in prod.
 *
 * Usage: pnpm --filter @vizyo/tracky-api exec ts-node prisma/gen-test-token.ts [authUserId]
 *
 * If no authUserId is provided, prints the token for SEED_ADMIN_AUTH_USER_ID.
 */
import * as jwt from 'jsonwebtoken';

const authUserId = process.argv[2] || process.env.SEED_ADMIN_AUTH_USER_ID;
if (!authUserId) {
  throw new Error('authUserId requis (CLI arg ou SEED_ADMIN_AUTH_USER_ID env)');
}

const secret = process.env.VIZYO_AUTH_JWT_ACCESS_SECRET;
const issuer = process.env.VIZYO_AUTH_JWT_ISSUER;
const appId = process.env.VIZYO_AUTH_APP_INTERNAL_ID;
if (!secret || !issuer || !appId) {
  throw new Error('VIZYO_AUTH_JWT_ACCESS_SECRET, VIZYO_AUTH_JWT_ISSUER, VIZYO_AUTH_APP_INTERNAL_ID requis');
}

const token = jwt.sign(
  { sub: authUserId, aud: 'api', typ: 'access', appId },
  secret,
  { expiresIn: '24h', issuer, algorithm: 'HS256' },
);

console.log(token);
