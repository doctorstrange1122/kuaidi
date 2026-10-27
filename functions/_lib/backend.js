/**
 * Cloudflare Pages Functions 后端：多设备快递同步（Pages + D1）
 *
 * 本文件为纯业务逻辑，不依赖具体部署形态。路由入口见 functions/api/[[path]].js。
 *
 * 路由：
 *  POST /api/register        {email,password}            -> {token,userId}
 *  POST /api/login           {email,password}            -> {token,userId}
 *  GET  /api/sync?since=0    (Bearer)                    -> {accounts,express,serverTime}
 *  POST /api/sync            (Bearer) {accounts,express} -> {serverTime}
 *
 * 同步策略：业务主键统一用 client_id（客户端 UUID）；冲突以 updated_at 较大者胜（last-write-wins）。
 *
 * JWT_SECRET 请通过 Cloudflare Pages 控制台「设置 → 环境变量」注入（生产环境），
 * 运行时由 applyEnv() 读取并覆盖下方默认值，切勿把真实密钥写进仓库。
 */

let jwtSecret = "CHANGE_ME_TO_A_LONG_RANDOM_STRING";
const TOKEN_TTL = 60 * 60 * 24 * 30; // 30 天（秒）

// 运行时由入口调用：从 Pages 环境变量注入的 JWT_SECRET 覆盖默认值
export function applyEnv(env) {
  if (env && env.JWT_SECRET) jwtSecret = env.JWT_SECRET;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pbkdf2(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" },
    key, 256
  );
  return b64url(bits);
}
function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hmacSign(data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(jwtSecret), "HMAC", false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(sig);
}
async function signJWT(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const p = b64url(enc.encode(JSON.stringify(header))) + "." + b64url(enc.encode(JSON.stringify(payload)));
  return p + "." + (await hmacSign(p));
}
async function verifyJWT(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const data = parts[0] + "." + parts[1];
    const key = await crypto.subtle.importKey("raw", enc.encode(jwtSecret), "HMAC", false, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(parts[2]), enc.encode(data));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64urlDecode(parts[1])));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}
async function auth(req, env) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  return await verifyJWT(m[1]);
}
function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

/* ----------------------------- 路由 ----------------------------- */
export async function register(req, env) {
  const { email, password } = await req.json();
  if (!email || !password || password.length < 6) return json({ error: "邮箱或密码(≥6位)不合法" }, 400);
  const exist = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
  if (exist) return json({ error: "该邮箱已注册" }, 409);
  const salt = bufToHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await pbkdf2(password, salt);
  const r = await env.DB.prepare(
    "INSERT INTO users (email,password_hash,salt,created_at) VALUES (?,?,?,?)"
  ).bind(email, hash, salt, Date.now()).run();
  const userId = r.meta.last_row_id;
  const token = await signJWT({ uid: userId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL });
  return json({ token, userId });
}

export async function login(req, env) {
  const { email, password } = await req.json();
  const row = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
  if (!row) return json({ error: "邮箱或密码错误" }, 401);
  const hash = await pbkdf2(password, row.salt);
  if (hash !== row.password_hash) return json({ error: "邮箱或密码错误" }, 401);
  const token = await signJWT({ uid: row.id, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL });
  return json({ token, userId: row.id });
}

// 拉取 since 之后(含)的变更
export async function pull(req, env, user) {
  const since = parseInt(new URL(req.url).searchParams.get("since") || "0", 10);
  const acc = await env.DB.prepare(
    "SELECT * FROM accounts WHERE owner_id=? AND updated_at>=? AND deleted=0"
  ).bind(user.uid, since).all();
  const exp = await env.DB.prepare(
    "SELECT * FROM express WHERE owner_id=? AND updated_at>=? AND deleted=0"
  ).bind(user.uid, since).all();
  return json({
    accounts: acc.results || [],
    express: exp.results || [],
    serverTime: Date.now(),
  });
}

// 上传本地变更（upsert，last-write-wins）
export async function push(req, env, user) {
  const body = await req.json().catch(() => ({}));
  const accounts = body.accounts || [];
  const express = body.express || [];
  const now = Date.now();

  for (const a of accounts) {
    if (!a.clientId || !a.name) continue;
    await env.DB.prepare(
      `INSERT INTO accounts (client_id,owner_id,name,created_at,updated_at,deleted)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(client_id) DO UPDATE SET
         name=excluded.name,
         updated_at=excluded.updated_at,
         deleted=excluded.deleted
       WHERE excluded.updated_at > accounts.updated_at`
    ).bind(a.clientId, user.uid, a.name, a.createdAt || now, a.updatedAt || now, a.deleted ? 1 : 0).run();
  }

  for (const e of express) {
    if (!e.clientId) continue;
    await env.DB.prepare(
      `INSERT INTO express (client_id,owner_id,account_client_id,company,tracking_no,status,recipient,phone,address,goods,shop,trajectory,last_update,created_at,updated_at,deleted)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(client_id) DO UPDATE SET
         account_client_id=excluded.account_client_id,
         company=excluded.company, tracking_no=excluded.tracking_no, status=excluded.status,
         recipient=excluded.recipient, phone=excluded.phone, address=excluded.address,
         goods=excluded.goods, shop=excluded.shop, trajectory=excluded.trajectory,
         last_update=excluded.last_update, updated_at=excluded.updated_at,
         deleted=excluded.deleted
       WHERE excluded.updated_at > express.updated_at`
    ).bind(
      e.clientId, user.uid, e.accountClientId || null, e.company || "", e.trackingNo || "",
      e.status || "", e.recipient || "", e.phone || "", e.address || "", e.goods || "",
      e.shop || "", e.trajectory || null, e.lastUpdate || null, e.createdAt || now,
      e.updatedAt || now, e.deleted ? 1 : 0
    ).run();
  }
  return json({ serverTime: now });
}

export async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return cors();

  if (path === "/api/register" && req.method === "POST") return await register(req, env);
  if (path === "/api/login" && req.method === "POST") return await login(req, env);

  if (path === "/api/sync") {
    const user = await auth(req, env);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (req.method === "GET") return await pull(req, env, user);
    if (req.method === "POST") return await push(req, env, user);
  }

  return json({ error: "not found" }, 404);
}
