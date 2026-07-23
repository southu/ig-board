// Unit tests for the browser-safe public-config assembly (src/publicConfig.js).
//
// Locks in the mission-critical guarantees:
//   - the anon key is a valid HS256 JWT (role: "anon") signed with the JWT secret
//   - an explicitly-provisioned SUPABASE_ANON_KEY wins over minting
//   - the service-role key / JWT secret NEVER leak into the browser-safe output
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  projectRef,
  mintAnonKey,
  publicSupabaseConfig
} from '../src/publicConfig.js';

const SECRET = 'test-jwt-secret';

function decodeJwt(token) {
  const [h, p, sig] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
    signingInput: `${h}.${p}`,
    signature: sig
  };
}

test('projectRef extracts the ref from a Supabase URL, else empty', () => {
  assert.equal(projectRef('https://abc123.supabase.co'), 'abc123');
  assert.equal(projectRef('https://abc123.supabase.co/'), 'abc123');
  assert.equal(projectRef('https://self-hosted.example.com'), '');
  assert.equal(projectRef(''), '');
  assert.equal(projectRef(undefined), '');
});

test('mintAnonKey returns a valid HS256 anon JWT signed with the secret', () => {
  const iat = 1_700_000_000;
  const token = mintAnonKey(SECRET, 'https://abc123.supabase.co', iat);
  const { header, payload, signingInput, signature } = decodeJwt(token);

  assert.equal(header.alg, 'HS256');
  assert.equal(payload.role, 'anon');
  assert.equal(payload.iss, 'supabase');
  assert.equal(payload.ref, 'abc123');
  assert.equal(payload.iat, iat);
  assert.ok(payload.exp > iat, 'exp is in the future');

  // The signature verifies against the JWT secret (so Supabase's gateway accepts it).
  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(signingInput)
    .digest('base64url');
  assert.equal(signature, expected);

  // A different secret must NOT verify.
  const wrong = crypto
    .createHmac('sha256', 'other')
    .update(signingInput)
    .digest('base64url');
  assert.notEqual(signature, wrong);
});

test('mintAnonKey returns empty string when the secret is absent', () => {
  assert.equal(mintAnonKey('', 'https://abc123.supabase.co', 1), '');
});

test('publicSupabaseConfig mints the anon key from the JWT secret', () => {
  const cfg = publicSupabaseConfig({
    SUPABASE_URL: 'https://abc123.supabase.co/',
    SUPABASE_JWT_SECRET: SECRET
  });
  assert.equal(cfg.supabaseUrl, 'https://abc123.supabase.co'); // trailing slash stripped
  const { payload } = decodeJwt(cfg.supabaseAnonKey);
  assert.equal(payload.role, 'anon');
});

test('publicSupabaseConfig prefers an explicit SUPABASE_ANON_KEY over minting', () => {
  const cfg = publicSupabaseConfig({
    SUPABASE_URL: 'https://abc123.supabase.co',
    SUPABASE_ANON_KEY: 'explicit-anon-key',
    SUPABASE_JWT_SECRET: SECRET
  });
  assert.equal(cfg.supabaseAnonKey, 'explicit-anon-key');
});

test('publicSupabaseConfig reads the NEXT_PUBLIC_ spellings when the bare names are absent', () => {
  const cfg = publicSupabaseConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'https://abc123.supabase.co/',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'next-public-anon-key'
  });
  assert.equal(cfg.supabaseUrl, 'https://abc123.supabase.co'); // trailing slash stripped
  assert.equal(cfg.supabaseAnonKey, 'next-public-anon-key');
});

test('publicSupabaseConfig prefers the bare SUPABASE_ names over the NEXT_PUBLIC_ ones', () => {
  const cfg = publicSupabaseConfig({
    SUPABASE_URL: 'https://bare.supabase.co',
    SUPABASE_ANON_KEY: 'bare-anon-key',
    NEXT_PUBLIC_SUPABASE_URL: 'https://nextpublic.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'next-public-anon-key'
  });
  assert.equal(cfg.supabaseUrl, 'https://bare.supabase.co');
  assert.equal(cfg.supabaseAnonKey, 'bare-anon-key');
});

test('publicSupabaseConfig mints the anon key from a NEXT_PUBLIC_ URL + JWT secret', () => {
  const cfg = publicSupabaseConfig({
    NEXT_PUBLIC_SUPABASE_URL: 'https://abc123.supabase.co',
    SUPABASE_JWT_SECRET: SECRET
  });
  const { payload } = decodeJwt(cfg.supabaseAnonKey);
  assert.equal(payload.role, 'anon');
  assert.equal(payload.ref, 'abc123');
});

test('publicSupabaseConfig is empty when nothing is configured', () => {
  assert.deepEqual(publicSupabaseConfig({}), {
    supabaseUrl: '',
    supabaseAnonKey: ''
  });
});

test('the service-role key and JWT secret never appear in the public output', () => {
  const cfg = publicSupabaseConfig({
    SUPABASE_URL: 'https://abc123.supabase.co',
    SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-should-never-leak'
  });
  const blob = JSON.stringify(cfg);
  assert.ok(!blob.includes('service-role-should-never-leak'));
  // The JWT secret is the signing key, never a payload value: it must not appear
  // verbatim in the emitted token.
  assert.ok(!blob.includes(SECRET));
});
