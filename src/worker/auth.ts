import type { Env } from './types';

const PBKDF2_ITER = 100000;
const SESSION_DAYS = 7;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60000;

function b64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
async function pbkdf2(pw: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITER }, key, 256);
  return b64(bits);
}
function randHex(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
function validName(n: string): boolean {
  return /^[a-zA-Z0-9 \-_.]{2,24}$/.test(n) && n.trim().length >= 2;
}

export interface AuthResult { ok: boolean; error?: string; token?: string; name?: string; role?: string }

export async function authRegister(env: Env, name: string, password: string): Promise<AuthResult> {
  if (!validName(name)) return { ok: false, error: 'NAME: 2-24 chars, letters/numbers only' };
  if (password.length < 6) return { ok: false, error: 'PASSWORD: minimum 6 characters' };
  const salt = randHex(16);
  const hash = await pbkdf2(password, salt);
  try {
    // First user becomes admin automatically
    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM users').first<{ n: number }>();
    const role = (count?.n ?? 0) === 0 ? 'admin' : 'operator';
    await env.DB.prepare('INSERT INTO users(name, pass_hash, salt, role, created_at) VALUES(?,?,?,?,?)')
      .bind(name.trim(), hash, salt, role, Date.now()).run();
    return await authLogin(env, name, password);
  } catch (e: any) {
    if (String(e?.message || '').includes('UNIQUE')) return { ok: false, error: 'OPERATOR NAME ALREADY TAKEN' };
    return { ok: false, error: 'REGISTRATION FAILED' };
  }
}

export async function authLogin(env: Env, name: string, password: string): Promise<AuthResult> {
  if (!validName(name)) return { ok: false, error: 'INVALID OPERATOR NAME' };
  const row = await env.DB.prepare('SELECT id, pass_hash, salt, role, login_attempts, locked_until FROM users WHERE name = ?')
    .bind(name.trim()).first<{ id: number; pass_hash: string; salt: string; role: string | null; login_attempts: number; locked_until: number | null }>();
  if (!row) return { ok: false, error: 'OPERATOR NOT FOUND - SIGN UP FIRST' };
  if (row.locked_until && Date.now() < row.locked_until) {
    return { ok: false, error: `LOCKED - TRY AGAIN IN ${Math.ceil((row.locked_until - Date.now()) / 60000)} MIN` };
  }
  const hash = await pbkdf2(password, row.salt);
  if (hash !== row.pass_hash) {
    const att = (row.login_attempts || 0) + 1;
    const lock = att >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : null;
    await env.DB.prepare('UPDATE users SET login_attempts=?, locked_until=? WHERE id=?').bind(att, lock, row.id).run();
    if (lock) return { ok: false, error: `TOO MANY FAILURES - LOCKED 15 MIN` };
    return { ok: false, error: `WRONG PASSWORD (${MAX_ATTEMPTS - att} LEFT)` };
  }
  await env.DB.prepare('UPDATE users SET login_attempts=0, locked_until=NULL WHERE id=?').bind(row.id).run();
  const token = randHex(32);
  await env.DB.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)')
    .bind(token, row.id, Date.now(), Date.now() + SESSION_DAYS * 86400000).run();
  return { ok: true, token, name: name.trim(), role: row.role || 'operator' };
}

/* tiers: admin (everything) · pro (Pro desks while pro_until is empty or in the future) · free.
   roles are set only by an admin (Admin → Users). role 'operator' = free account. */
export type Tier = 'admin' | 'pro' | 'free';
export interface AuthUser { valid: boolean; id?: number; name?: string; role?: string; tier?: Tier; proUntil?: number | null }

export function tierOf(role: string | null | undefined, proUntil: number | null | undefined, now = Date.now()): Tier {
  if (role === 'admin') return 'admin';
  if (role === 'pro' && (proUntil == null || proUntil > now)) return 'pro';
  return 'free';
}

export async function authVerify(env: Env, token: string): Promise<AuthUser> {
  if (!token || token.length !== 64) return { valid: false };
  let row: { id: number; name: string; role: string | null; pro_until?: number | null } | null;
  try {
    row = await env.DB.prepare(
      'SELECT u.id, u.name, u.role, u.pro_until FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>?'
    ).bind(token, Date.now()).first();
  } catch {
    // pro_until not migrated yet: old shape, everybody non-admin is free
    row = await env.DB.prepare(
      'SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token=? AND s.expires_at>?'
    ).bind(token, Date.now()).first();
  }
  if (!row) return { valid: false };
  const role = row.role || 'operator';
  return { valid: true, id: row.id, name: row.name, role, tier: tierOf(role, row.pro_until ?? null), proUntil: row.pro_until ?? null };
}

export async function authLogout(env: Env, token: string): Promise<void> {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(token).run();
}

/* ---- middleware: verify session from request ---- */
export async function requireAuth(req: Request, env: Env): Promise<AuthUser> {
  const token = req.headers.get('x-session') || new URL(req.url).searchParams.get('token') || '';
  return authVerify(env, token);
}
