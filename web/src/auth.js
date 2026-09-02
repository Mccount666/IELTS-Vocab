// 认证模块：PBKDF2 密码哈希 + D1 会话 + HttpOnly cookie
// 约定：数据库里只存 token 的 SHA-256 与密码的 PBKDF2 结果，明文只出现在 cookie / 请求参数里。

import { HttpError } from "./integrations.js";

// Workers 免费版有 CPU 时间限制，10 万次 PBKDF2 在边缘硬件（SHA-NI 加速）下实测可用；
// 若部署后注册/登录报 1102（CPU 超限），把这里降到 50000 即可。
const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_MS = 30 * 86400_000;
export const SESSION_COOKIE = "iv_session";

const enc = new TextEncoder();

function nowIso() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function b64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256B64(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return b64(new Uint8Array(digest)); // token_hash 用 base64 存，等长且免 hex 转换
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// 密码哈希格式：pbkdf2:<iterations>:<salt b64>:<hash b64>（迭代次数随存储走，方便日后整体升级）
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return `pbkdf2:${PBKDF2_ITERATIONS}:${b64(salt)}:${b64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iterStr, saltB64, hashB64] = String(stored || "").split(":");
  if (scheme !== "pbkdf2" || !iterStr || !saltB64 || !hashB64) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: b64ToBytes(saltB64), iterations: Number(iterStr) },
    key,
    256
  );
  return timingSafeEqual(new Uint8Array(bits), b64ToBytes(hashB64));
}

// ---------------------------------------------------------------------------

export async function createSession(env, userId) {
  // 顺手清理过期会话，避免表无限增长
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowIso()).run();
  const token = b64(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString().replace("T", " ").slice(0, 19);
  await env.DB
    .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256B64(token), userId, nowIso(), expires)
    .run();
  return token;
}

export async function deleteSession(request, env) {
  const token = readSessionToken(request);
  if (!token) return;
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256B64(token)).run();
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function readSessionToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;\\s]+)`));
  return m ? m[1] : null;
}

// 会话有效 → 返回 {id, username, is_admin}；否则 null
export async function getUser(request, env) {
  const token = readSessionToken(request);
  if (!token) return null;
  return await env.DB
    .prepare(
      `SELECT u.id, u.username, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .bind(await sha256B64(token), nowIso())
    .first();
}

export async function requireUser(request, env) {
  const user = await getUser(request, env);
  if (!user) throw new HttpError(401, "未登录或登录已过期");
  return user;
}
