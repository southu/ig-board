// Private storage signed-URL helpers for the founder memo pipeline.
//
// Contract (mirrors Supabase private buckets + createSignedUrl):
//   * Objects are NEVER public. A public-style path always returns 4xx.
//   * Download is only via a signed URL with 3600s (1 hour) expiry.
//   * Tokens are HS256 JWTs signed server-side with the project's JWT secret
//     (the same secret used at the auth boundary — available on the live
//     deploy even when no service-role key is bound). Never log the token.
//   * A tampered token fails closed with 4xx.
//
// URL shape (self-hosted, Supabase-compatible path layout):
//   /storage/v1/object/sign/<storage_path>?token=<jwt>
//   /storage/v1/object/public/<storage_path>  → always 4xx (private bucket)

import crypto from 'node:crypto';
import { jwtSecret } from './auth.js';

export const SIGNED_URL_TTL_SECONDS = 3600;

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function b64urlToBuffer(segment) {
  return Buffer.from(segment, 'base64url');
}

// Sign an HS256 JWT for a single storage object. `path` is the storage_path
// (e.g. "memos/<id>/file.docx"). Expiry is always SIGNED_URL_TTL_SECONDS.
export function signStorageToken(storagePath, secret = jwtSecret(), nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret) {
    const err = new Error('auth not configured');
    err.code = 'AUTH_NOT_CONFIGURED';
    throw err;
  }
  if (!storagePath || typeof storagePath !== 'string') {
    const err = new Error('storage path required');
    err.code = 'INVALID_PATH';
    throw err;
  }
  const iat = nowSec;
  const exp = iat + SIGNED_URL_TTL_SECONDS;
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({
    // Supabase-shaped claim: the object URL/path this token grants.
    url: storagePath,
    // Also carry explicit ttl so testers can assert 3600 without decoding only exp-iat.
    exp,
    iat,
    ttl: SIGNED_URL_TTL_SECONDS,
    role: 'storage'
  });
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return { token: `${header}.${payload}.${sig}`, exp, iat, expiresIn: SIGNED_URL_TTL_SECONDS };
}

// Verify a storage token. Returns { storagePath, exp, iat } or throws.
export function verifyStorageToken(token, secret = jwtSecret(), nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret) {
    const err = new Error('auth not configured');
    err.code = 'AUTH_NOT_CONFIGURED';
    throw err;
  }
  if (typeof token !== 'string' || token.length === 0) {
    const err = new Error('missing token');
    err.code = 'MISSING_TOKEN';
    throw err;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    const err = new Error('malformed token');
    err.code = 'MALFORMED';
    throw err;
  }
  const [encHeader, encPayload, encSignature] = parts;
  let header;
  try {
    header = JSON.parse(b64urlToBuffer(encHeader).toString('utf8'));
  } catch {
    const err = new Error('invalid header');
    err.code = 'INVALID_HEADER';
    throw err;
  }
  if (header.alg !== 'HS256') {
    const err = new Error('unsupported alg');
    err.code = 'UNSUPPORTED_ALG';
    throw err;
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${encHeader}.${encPayload}`)
    .digest();
  const actual = b64urlToBuffer(encSignature);
  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  ) {
    const err = new Error('bad signature');
    err.code = 'BAD_SIGNATURE';
    throw err;
  }
  let payload;
  try {
    payload = JSON.parse(b64urlToBuffer(encPayload).toString('utf8'));
  } catch {
    const err = new Error('invalid payload');
    err.code = 'INVALID_PAYLOAD';
    throw err;
  }
  if (typeof payload.exp === 'number' && nowSec >= payload.exp) {
    const err = new Error('token expired');
    err.code = 'EXPIRED';
    throw err;
  }
  const storagePath = typeof payload.url === 'string' ? payload.url : '';
  if (!storagePath) {
    const err = new Error('missing path claim');
    err.code = 'MISSING_PATH';
    throw err;
  }
  // Enforce the 1-hour contract: reject tokens that claim a longer life.
  if (
    typeof payload.iat === 'number' &&
    typeof payload.exp === 'number' &&
    payload.exp - payload.iat > SIGNED_URL_TTL_SECONDS
  ) {
    const err = new Error('ttl exceeds maximum');
    err.code = 'TTL_TOO_LONG';
    throw err;
  }
  return {
    storagePath,
    exp: payload.exp,
    iat: payload.iat,
    expiresIn: SIGNED_URL_TTL_SECONDS
  };
}

// Build the absolute signed download URL for a memo object.
// origin is the public service origin (https://host), no trailing slash.
export function buildSignedUrl(origin, storagePath, secret = jwtSecret(), nowSec) {
  const { token, exp, iat, expiresIn } = signStorageToken(storagePath, secret, nowSec);
  const base = String(origin || '').replace(/\/+$/, '');
  const path = `/storage/v1/object/sign/${storagePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const signedUrl = `${base}${path}?token=${encodeURIComponent(token)}`;
  return { signedUrl, token, exp, iat, expiresIn };
}

// Public-style object URL (must always 4xx — private bucket).
export function publicObjectUrl(origin, storagePath) {
  const base = String(origin || '').replace(/\/+$/, '');
  const path = `/storage/v1/object/public/${storagePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  return `${base}${path}`;
}

// Decode path segments from /storage/v1/object/{sign|public}/...
export function storagePathFromRequestUrl(urlPath) {
  const raw = (urlPath || '').split('?')[0];
  const m = raw.match(/^\/storage\/v1\/object\/(?:sign|public)\/(.+)$/);
  if (!m) return null;
  return m[1]
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}
