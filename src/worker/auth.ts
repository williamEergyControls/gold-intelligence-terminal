/* ================================================================
   AUTH SYSTEM - D1-backed, PBKDF2 hashed, SQL injection immune.
   All queries use .bind() parameterization = zero injection risk.
   ================================================================ */
import type { Env } from './types';

const PBKDF2_ITERATIONS = 100000;
const SESSION_DAYS = 7;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function b64encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
function b64decode(s: string): Uint8Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function pbkdf2(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS },
    keyMaterial, 256
  );
  return b64encode(bits);
}
function randomToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}
function randomSalt(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

/* ---- validate name: alphanumeric + spaces + hyphens only ---- */
function validName(n: string): boolean {
  return /^[a-zA-Z0-9 \-_.]{2,24}$/.test(n) && n.trim().length >= 2;
}

export interface AuthResult { ok: boolean; error?: string; token?: string; name?: string }

export async function authRegister(env: Env, name: string, password: string): Promise<AuthResult> {
  if (!validName(name)) return { ok: false, error: 'NAME: 2-24 chars, letters/numbers/spaces only' };
  if (password.length < 6) return { ok: false, error: 'PASSWORD: minimum 6 characters' };
  if (password.length > 128) return { ok: false, error: 'PASSWORD: maximum 128 characters' };
  const salt = randomSalt();
  const hash = await pbkdf2(password, salt);
  try {
    // .bind() = parameterized = SQL injection impossible
    const r = await env.DB.prepare('INSERT INTO users(name, pass_hash, salt, created_at) VALUES(?,?,?,?)')
      .bind(name.trim(), hash, salt, Date.now()).run();
    if (!r.success) return { ok: false, error: 'REGISTRATION FAILED' };
  } catch (e: any) {
    if (String(e?.message || '').includes('UNIQUE')) return { ok: false, error: 'OPERATOR NAME ALREADY TAKEN' };
    return { ok: false, error: 'REGISTRATION FAILED' };
  }
  return authLogin(env, name, password);
}

export async function authLogin(env: Env, name: string, password: string): Promise<AuthResult> {
  if (!validName(name)) return { ok: false, error: 'INVALID OPERATOR NAME' };
  if (password.length < 1) return { ok: false, error: 'ENTER PASSWORD' };
  const row = await env.DB.prepare('SELECT id, pass_hash, salt, login_attempts, locked_until FROM users WHERE name = ?')
    .bind(name.trim()).first<{ id: number; pass_hash: string; salt: string; login_attempts: number; locked_until: number | null }>();
  if (!row) return { ok: false, error: 'OPERATOR NOT FOUND - SIGN UP FIRST' };
  if (row.locked_until && Date.now() < row.locked_until) {
    const mins = Math.ceil((row.locked_until - Date.now()) / 60000);
    return { ok: false, error: `ACCOUNT LOCKED - TRY AGAIN IN ${mins} MIN` };
  }
  const hash = await pbkdf2(password, row.salt);
  if (hash !== row.pass_hash) {
    const attempts = (row.login_attempts || 0) + 1;
    const lock = attempts >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MINUTES * 60000 : null;
    await env.DB.prepare('UPDATE users SET login_attempts = ?, locked_until = ? WHERE id = ?')
      .bind(attempts, lock, row.id).run();
    if (lock) return { ok: false, error: `TOO MANY FAILED ATTEMPTS - LOCKED ${LOCKOUT_MINUTES} MIN` };
    return { ok: false, error: `INCORRECT PASSWORD (${MAX_ATTEMPTS - attempts} ATTEMPTS REMAINING)` };
  }
  // success: reset attempts, create session
  await env.DB.prepare('UPDATE users SET login_attempts = 0, locked_until = NULL WHERE id = ?')
    .bind(row.id).run();
  const token = randomToken();
  const expires = Date.now() + SESSION_DAYS * 86400000;
  await env.DB.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)')
    .bind(token, row.id, Date.now(), expires).run();
  return { ok: true, token, name: name.trim() };
}

export async function authVerify(env: Env, token: string): Promise<{ valid: boolean; name?: string }> {
  if (!token || token.length !== 64) return { valid: false };
  const row = await env.DB.prepare(
    'SELECT s.token, s.expires_at, u.name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ?'
  ).bind(token, Date.now()).first<{ token: string; expires_at: number; name: string }>();
  if (!row) return { valid: false };
  return { valid: true, name: row.name };
}

export async function authLogout(env: Env, token: string): Promise<void> {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}
