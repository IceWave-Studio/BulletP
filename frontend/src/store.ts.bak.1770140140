// src/store.ts
import { create } from "zustand";
import { api } from "./api";
import type { ApiNode } from "./api";

export type UiNode = {
  id: string;
  parentId: string | null;
  content: string; // HTML string (store as backend text)
  orderIndex: number;
  children: string[]; // ordered children ids
  hasChildren?: boolean; // hint from backend
  isCollapsed?: boolean; // UI-only
};

const AUTH_KEY = "bulletp_auth_v1";

type Store = {
  // ========== auth ==========
  userId: string | null; // 登录后的 user_id
  email: string | null; // 仅用于展示/调试（可选）

  hydrateAuth: () => void;
  setAuth: (userId: string, homeId: string, email?: string) => void;
  clearAuth: () => void;

  // ✅ 每次 login/logout 都会 +1，用于让 in-flight async 自动失效
  sessionNonce: number;

  // ========== data ==========
  nodes: Record<string, UiNode>;
  rootId: string;
  homeId: string | null; // ✅ 复用为当前用户的 home bullet id
  focusedId: string | null;

  // ✅ sidebar refresh signal
  sidebarVersion: number;
  bumpSidebar: () => void;

  // caret helpers for delete empty line behavior
  caretToEndId: string | null;
  setCaretToEndId: (id: string | null) => void;

  // init + sync
  init: () => Promise<void>;
  hydrateNode: (n: ApiNode) => void;
  loadChildren: (parentId: string) => Promise<void>;

  // ensure node (single fetch) for breadcrumb/title stability
  ensureNodeLoaded: (id: string) => Promise<void>;
  _inflightNodeFetch: Record<string, Promise<void>>;

  // navigation
  setRootId: (id: string) => void;
  setFocusedId: (id: string | null) => void;
  getPathToRoot: (id: string) => string[];

  // UI-only collapse
  toggleCollapse: (id: string) => void;

  // content
  updateContent: (id: string, html: string) => Promise<void>;

  // creation / deletion compatible with NodeItem
  appendChild: (parentId: string) => Promise<void>;
  createAfter: (id: string) => Promise<void>;
  deleteIfEmpty: (id: string) => Promise<void>;

  // indent/outdent
  indent: (id: string) => Promise<void>;
  outdent: (id: string) => Promise<void>;

  // focus navigation
  moveFocusUp: () => void;
  moveFocusDown: () => void;
};

function upsertFromApi(state: Store, n: ApiNode): UiNode {
  const existing = state.nodes[n.id];

  // ✅ 注意：ApiNode 里是 has_children（snake），UiNode 是 hasChildren（camel）
  const hintHasChildren =
    (n as any).has_children !== undefined ? Boolean((n as any).has_children) : undefined;

  // ✅ 如果节点“有孩子但 children 未加载”，默认折叠（箭头朝右）
  const shouldDefaultCollapsed =
    hintHasChildren === true && (existing?.children?.length ?? 0) === 0;

  return {
    id: n.id,
    parentId: n.parent_id,
    content: n.text ?? existing?.content ?? "",
    orderIndex: n.order_index ?? existing?.orderIndex ?? 0,

    // ✅ 永远保留旧 children（因为 getNode/patchNode 不会给 children）
    children: existing?.children ?? [],

    // ✅ hasChildren：优先用后端 hint；否则保留旧值
    hasChildren: hintHasChildren ?? existing?.hasChildren,

    // ✅ isCollapsed：保留旧值；否则按 “有孩子且未加载” 默认 true
    isCollapsed:
      existing?.isCollapsed !== undefined ? existing.isCollapsed : shouldDefaultCollapsed,
  };
}

/** Return previous sibling id under same parent */
function getPrevSiblingId(state: Store, id: string): string | null {
  const node = state.nodes[id];
  if (!node) return null;
  const pid = node.parentId;
  if (!pid) return null;
  const parent = state.nodes[pid];
  const arr = parent?.children ?? [];
  const idx = arr.indexOf(id);
  if (idx <= 0) return null;
  return arr[idx - 1] ?? null;
}

/** Return next sibling id under same parent */
function getNextSiblingId(state: Store, id: string): string | null {
  const node = state.nodes[id];
  if (!node) return null;
  const pid = node.parentId;
  if (!pid) return null;
  const parent = state.nodes[pid];
  const arr = parent?.children ?? [];
  const idx = arr.indexOf(id);
  if (idx < 0 || idx >= arr.length - 1) return null;
  return arr[idx + 1] ?? null;
}

/** Flatten visible nodes under current root */
function flattenVisible(state: Store, rootId: string): string[] {
  const out: string[] = [];
  const root = state.nodes[rootId];
  if (!root) return out;

  const walk = (id: string) => {
    const n = state.nodes[id];
    if (!n) return;
    out.push(id);
    if (n.isCollapsed) return;
    for (const cid of n.children ?? []) walk(cid);
  };

  for (const cid of root.children ?? []) walk(cid);
  return out;
}

export const useStore = create<Store>((set, get) => ({
  // ===== auth =====
  userId: null,
  email: null,

  // ✅ 初始 nonce
  sessionNonce: 0,

  hydrateAuth: () => {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return;
    try {
      const obj = JSON.parse(raw);
      if (obj?.userId && obj?.homeId) {
        set((s) => ({
          userId: obj.userId,
          email: obj.email ?? null,
          homeId: obj.homeId,
          rootId: obj.homeId,
          sessionNonce: s.sessionNonce + 1, // ✅ hydrate 也视作新 session
        }));
      }
    } catch {
      // ignore
    }
  },

  setAuth: (userId: string, homeId: string, email?: string) => {
    set((s) => ({
      userId,
      email: email ?? null,
      homeId,
      rootId: homeId,
      focusedId: null,
      sessionNonce: s.sessionNonce + 1, // ✅ 关键：让旧请求失效
    }));

    localStorage.setItem(AUTH_KEY, JSON.stringify({ userId, homeId, email: email ?? null }));
  },

  clearAuth: () => {
    localStorage.removeItem(AUTH_KEY);

    // 清理所有树数据，回到未登录态
    set((s) => ({
      userId: null,
      email: null,

      nodes: {},
      rootId: "",
      homeId: null,
      focusedId: null,

      caretToEndId: null,
      _inflightNodeFetch: {},

      sidebarVersion: 0, // ✅ 可选：登出后重置 sidebar 刷新计数
      sessionNonce: s.sessionNonce + 1, // ✅ 关键：让旧请求失效
    }));
  },

  // ===== data =====
  nodes: {},
  rootId: "",
  homeId: null,
  focusedId: null,

  sidebarVersion: 0,
  bumpSidebar: () => set((s) => ({ sidebarVersion: s.sidebarVersion + 1 })),

  caretToEndId: null,
  setCaretToEndId: (id) => set({ caretToEndId: id }),

  _inflightNodeFetch: {},

  init: async () => {
    const nonce = get().sessionNonce;

    const home = await api.getHome();
    if (get().sessionNonce !== nonce) return; // ✅ logout/login 中途发生，丢弃

    set((s) => {
      const next = { ...s.nodes };

      next[home.id] = next[home.id] ?? {
        id: home.id,
        parentId: null,
        content: home.text ?? "Home",
        orderIndex: 0,
        children: [],
        hasChildren: true,
        isCollapsed: false,
      };

      next[home.id] = { ...next[home.id], content: home.text ?? "Home", parentId: null };

      return { nodes: next, homeId: home.id, rootId: home.id };
    });

    await get().loadChildren(home.id);
  },

  hydrateNode: (n: ApiNode) =>
    set((s) => {
      const next = { ...s.nodes };
      next[n.id] = upsertFromApi(s as any, n);
      return { nodes: next };
    }),

  ensureNodeLoaded: async (id: string) => {
    if (!id) return;

    const nonce = get().sessionNonce;
    const st = get();

    // 已经存在就不拉（content 可以是 ""）
    if (st.nodes[id] && st.nodes[id].content !== undefined) return;

    const inflight = st._inflightNodeFetch[id];
    if (inflight) {
      await inflight;
      return;
    }

    const p = (async () => {
      try {
        const n = await api.getNode(id);
        if (get().sessionNonce !== nonce) return; // ✅ 失效保护
        st.hydrateNode(n);
      } catch (e) {
        console.warn("ensureNodeLoaded failed:", id, e);
      } finally {
        // ✅ finally 仍要清 inflight（不受 nonce 影响）
        set((s) => {
          const next = { ...s._inflightNodeFetch };
          delete next[id];
          return { _inflightNodeFetch: next };
        });
      }
    })();

    set((s) => ({
      _inflightNodeFetch: { ...s._inflightNodeFetch, [id]: p },
    }));

    await p;
  },

  loadChildren: async (parentId: string) => {
    const nonce = get().sessionNonce;

    const rows = await api.getChildren(parentId);
    if (get().sessionNonce !== nonce) return; // ✅ 失效保护

    set((s) => {
      const next = { ...s.nodes };
      const childIds: string[] = [];

      if (!next[parentId]) {
        next[parentId] = {
          id: parentId,
          parentId: null,
          content: "",
          orderIndex: 0,
          children: [],
          isCollapsed: false,
        };
      }

      for (const r of rows) {
        const existing = next[r.id];

        const hintHasChildren =
          (r as any).has_children !== undefined ? Boolean((r as any).has_children) : undefined;

        // ✅ 新出现的 child：如果它有孩子但还没加载 grandchildren，默认折叠
        const defaultCollapsed =
          hintHasChildren === true && (existing?.children?.length ?? 0) === 0;

        next[r.id] = {
          id: r.id,
          parentId: r.parent_id,
          content: r.text ?? existing?.content ?? "",
          orderIndex: r.order_index ?? existing?.orderIndex ?? 0,
          children: existing?.children ?? [],
          hasChildren: hintHasChildren ?? existing?.hasChildren,
          isCollapsed:
            existing?.isCollapsed !== undefined ? existing.isCollapsed : defaultCollapsed,
        };

        childIds.push(r.id);
      }

      next[parentId] = {
        ...next[parentId],
        children: childIds,
        hasChildren: childIds.length > 0,
      };

      return { nodes: next };
    });
  },

  setRootId: (id) => {
    set({ rootId: id });
    get().ensureNodeLoaded(id).catch(console.error);
  },

  setFocusedId: (id) => set({ focusedId: id }),

  getPathToRoot: (id: string) => {
    const { nodes, homeId } = get();
    if (!id) return [];
    const path: string[] = [];
    let cur: string | null = id;
    const seen = new Set<string>();

    while (cur && !seen.has(cur)) {
      seen.add(cur);
      path.push(cur);
      cur = nodes[cur]?.parentId ?? null;
    }
    path.reverse();

    if (homeId && path[0] !== homeId) return [homeId, ...path];
    return path;
  },

  toggleCollapse: (id: string) => {
    set((s) => {
      const n = s.nodes[id];
      if (!n) return s;
      return { nodes: { ...s.nodes, [id]: { ...n, isCollapsed: !n.isCollapsed } } };
    });

    const st = get();
    const n = st.nodes[id];

    // ✅ 展开时：如果 children 还没加载，就拉一次
    if (n && n.isCollapsed === false && (n.children?.length ?? 0) === 0) {
      st.loadChildren(id).catch(console.error);
    }
  },

  updateContent: async (id: string, html: string) => {
    const nonce = get().sessionNonce;

    const updated = await api.patchNode(id, { text: html });
    if (get().sessionNonce !== nonce) return;

    set((s) => {
      const next = { ...s.nodes };
      next[id] = upsertFromApi(s as any, updated);
      return { nodes: next };
    });

    get().bumpSidebar();
  },

  appendChild: async (parentId: string) => {
    const nonce = get().sessionNonce;

    await api.createNode({ parent_id: parentId, text: "" });
    if (get().sessionNonce !== nonce) return;

    await get().loadChildren(parentId);
    if (get().sessionNonce !== nonce) return;

    get().bumpSidebar();
  },

  createAfter: async (id: string) => {
    const nonce = get().sessionNonce;

    const st = get();
    const node = st.nodes[id];
    if (!node) return;

    const parentId = node.parentId ?? st.homeId;
    if (!parentId) return;

    const created = await api.createNode({ parent_id: parentId, text: "" });
    if (get().sessionNonce !== nonce) return;

    await st.loadChildren(parentId);
    if (get().sessionNonce !== nonce) return;

    const afterIndex = (st.nodes[parentId]?.children.indexOf(id) ?? -1) + 1;
    const newIndex = Math.max(0, afterIndex);

    await api.moveNode(created.id, { new_parent_id: parentId, new_order_index: newIndex });
    if (get().sessionNonce !== nonce) return;

    await st.loadChildren(parentId);
    if (get().sessionNonce !== nonce) return;

    set({ focusedId: created.id });
    get().bumpSidebar();
  },

  deleteIfEmpty: async (id: string) => {
    const nonce = get().sessionNonce;

    const st = get();
    const node = st.nodes[id];
    if (!node) return;

    const parentId = node.parentId;
    if (!parentId) return;

    const prevId = getPrevSiblingId(st as any, id);
    const nextId = getNextSiblingId(st as any, id);
    const focusTarget = prevId ?? nextId ?? parentId;

    await api.deleteNode(id);
    if (get().sessionNonce !== nonce) return;

    await st.loadChildren(parentId);
    if (get().sessionNonce !== nonce) return;

    set((s) => {
      const next = { ...s.nodes };
      delete next[id];
      return { nodes: next };
    });

    set({ focusedId: focusTarget });
    if (prevId) set({ caretToEndId: prevId });

    get().bumpSidebar();
  },

  indent: async (id: string) => {
    const nonce = get().sessionNonce;

    const st = get();
    const node = st.nodes[id];
    if (!node) return;

    const oldParentId = node.parentId;
    if (!oldParentId) return;

    const updated = await api.indentNode(id);
    if (get().sessionNonce !== nonce) return;

    const newParentId = updated.parent_id;

    st.hydrateNode(updated);

    await st.loadChildren(oldParentId);
    if (get().sessionNonce !== nonce) return;

    if (newParentId) {
      await st.loadChildren(newParentId);
      if (get().sessionNonce !== nonce) return;
    }

    set({ focusedId: id });
    get().bumpSidebar();
  },

  outdent: async (id: string) => {
    const nonce = get().sessionNonce;

    const st = get();
    const node = st.nodes[id];
    if (!node) return;

    const oldParentId = node.parentId;
    if (!oldParentId) return;

    const updated = await api.outdentNode(id);
    if (get().sessionNonce !== nonce) return;

    const newParentId = updated.parent_id;

    st.hydrateNode(updated);

    await st.loadChildren(oldParentId);
    if (get().sessionNonce !== nonce) return;

    if (newParentId) {
      await st.loadChildren(newParentId);
      if (get().sessionNonce !== nonce) return;
    }

    set({ focusedId: id });
    get().bumpSidebar();
  },

  moveFocusUp: () => {
    const st = get();
    const { rootId, focusedId } = st;
    if (!rootId) return;

    const list = flattenVisible(st as any, rootId);
    if (list.length === 0) return;

    if (!focusedId) {
      set({ focusedId: list[0] });
      return;
    }

    const idx = list.indexOf(focusedId);
    if (idx <= 0) return;
    set({ focusedId: list[idx - 1] });
  },

  moveFocusDown: () => {
    const st = get();
    const { rootId, focusedId } = st;
    if (!rootId) return;

    const list = flattenVisible(st as any, rootId);
    if (list.length === 0) return;

    if (!focusedId) {
      set({ focusedId: list[0] });
      return;
    }

    const idx = list.indexOf(focusedId);
    if (idx < 0 || idx >= list.length - 1) return;
    set({ focusedId: list[idx + 1] });
  },
}));
