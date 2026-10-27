-- Cloudflare D1 表结构
-- 执行：在 Cloudflare 控制台 D1 的 express_sync 数据库「Console」里粘贴本文件内容运行；
--       或用 wrangler：wrangler d1 execute express_sync --remote --file=./schema.sql
-- 注：业务主键统一用 client_id（客户端生成的 UUID），避免多设备自增 id 冲突。

CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- 淘宝账号分组（属于某个 App 登录用户）
CREATE TABLE IF NOT EXISTS accounts (
  client_id  TEXT PRIMARY KEY,
  owner_id   INTEGER NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER DEFAULT 0
);

-- 快递记录
CREATE TABLE IF NOT EXISTS express (
  client_id         TEXT PRIMARY KEY,
  owner_id          INTEGER NOT NULL,
  account_client_id TEXT,
  company     TEXT,
  tracking_no  TEXT,
  status       TEXT,
  recipient    TEXT,
  phone        TEXT,
  address      TEXT,
  goods        TEXT,
  shop         TEXT,
  trajectory   TEXT,
  last_update  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted      INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_express_owner ON express(owner_id);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_id);
