// src/api.ts

/** =========================
 * Types
 * ========================= */

export type ApiNode = {
  id: string;
  parent_id: string | null;
  text: string;
  order_index: number;
  has_children?: boolean;
};

export type ApiTreeNode = ApiNode & {
  has_children: boolean;
  children: ApiTreeNode[];
};

/** ---------- Auth ---------- */
export type EmailStartRes = {
  ok: boolean;
  expires_in: number;
};

export type EmailVerifyRes = {
  user_id: string;
  home_id: string;
};

/** =========================
 * Config
 * ========================= */

// 本地默认走 Vite proxy（API_BASE=""）
// 生产环境可用 VITE_API_BASE=https://api.xxx.com
const API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "";

// 与 store.ts 约定的 key
const AUTH_KEY = "bulletp_auth_v1";

/** =========================
 * Helpers
 * ========================= */

// 从 localStorage 里取 userId
function getStoredUserId(): string | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj?.userId ?? null;
  } catch {
    return null;
  }
}

// 对需要“用户隔离”的 API 自动拼 user_id
function withUserId(path: string): string {
  // ❌ auth / dev 接口不需要 user_id
  if (path.startsWith("/api/auth/") || path.startsWith("/api/dev/")) {
    return path;
  }

  const userId = getStoredUserId();
  if (!userId) return path;

  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}user_id=${encodeURIComponent(userId)}`;
}

async function readErrorBody(res: Response): Promise<string> {
  const ct = res.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) {
      const j = await res.json();
      return JSON.stringify(j);
    }
    return await res.text();
  } catch {
    return "";
  }
}

/** =========================
 * Low-level request helper
 * ========================= */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const finalPath = withUserId(path);
  const url = `${API_BASE}${finalPath}`;

  // ✅ 只在需要时设置 Content-Type，避免 GET 也触发 preflight（Edge 更容易出坑）
  const headers: Record<string, string> = {
    ...(init?.headers as any),
  };

  if (init?.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    ...init,
    headers,
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(`HTTP ${res.status} ${url}${body ? ` :: ${body}` : ""}`);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;

  // 有些接口可能返回 text/plain（比如 CORS OK），这里兜底一下
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    return (await res.text()) as T;
  }

  return (await res.json()) as T;
}

/** =========================
 * API surface
 * ========================= */

export const api = {
  /* ---------- Auth (Email OTP) ---------- */
  emailStart: (payload: { email: string }) =>
    request<EmailStartRes>("/api/auth/email/start", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  emailVerify: (payload: { email: string; code: string }) =>
    request<EmailVerifyRes>("/api/auth/email/verify", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /* ---------- Home ---------- */
  getHome: () =>
    request<{ id: string; text: string; parent_id: null; user_id: string }>("/api/home"),

  /* ---------- Single node ---------- */
  getNode: (id: string) => request<ApiNode>(`/api/nodes/${id}`),

  /* ---------- Children ---------- */
  getChildren: (parentId: string) => request<ApiNode[]>(`/api/nodes/${parentId}/children`),

  /* ---------- Subtree ---------- */
  getSubtree: (rootId: string, depth = 5) =>
    request<ApiTreeNode>(`/api/nodes/${rootId}/subtree?depth=${depth}`),

  /* ---------- CRUD ---------- */
  createNode: (payload: { parent_id?: string | null; text: string }) =>
    request<ApiNode>("/api/nodes", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  patchNode: (id: string, payload: { text: string }) =>
    request<ApiNode>(`/api/nodes/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  deleteNode: (id: string) =>
    request<{ ok: true }>(`/api/nodes/${id}`, {
      method: "DELETE",
    }),

  /* ---------- Move / Reorder ---------- */
  moveNode: (id: string, payload: { new_parent_id: string; new_order_index: number }) =>
    request<ApiNode>(`/api/nodes/${id}/move`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /* ---------- Indent / Outdent ---------- */
  indentNode: (id: string) =>
    request<ApiNode>(`/api/nodes/${id}/indent`, {
      method: "POST",
    }),

  outdentNode: (id: string) =>
    request<ApiNode>(`/api/nodes/${id}/outdent`, {
      method: "POST",
    }),
};
