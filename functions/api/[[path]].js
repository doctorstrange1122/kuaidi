// Pages Functions 通配入口：匹配 /api/* 下所有请求
// 下划线目录 _lib 不会被当作路由，仅作模块复用。
import { applyEnv, handle } from "../_lib/backend.js";

export function onRequest(context) {
  // 从 Pages 环境变量注入 JWT_SECRET（在控制台「设置 → 环境变量」配置）
  applyEnv(context.env);
  return handle(context.request, context.env);
}
