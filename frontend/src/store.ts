// src/store.ts
import { create } from "zustand";
import { api } from "./api";
import type { ApiNode } from "./api";

/* =========================
 * Types
 * ========================= */

export type UiNode = {
  id: string;
  parentId: string | null;
  content: string; // HTML string
  orderIndex: number;
  children: string[];
  hasChildren?: boolean;
  isCollapsed?: boolean;
};

const AUTH_KEY = "bulletp_auth_v1";

/* =========================
 * Store shape
 * ========================= */

type Store = {
  // ---------- auth ----------
  userId: string | null;
  email: string | null;
  homeId: string | null;

  hydrateAuth: () => void;
  setAuth: (userId: string, homeId: string, email?: string) => void;
  clearAuth: () => void;

  // bump on every login/logout to invalidate in-flight async
  sessionNonce: number;

  // ---------- data ----------
  nodes: Record<string, UiNode>;
  rootId: string;
  focusedId: string | null;

  // ✅ sidebar refresh signal
  sidebarVersion: number;
  bumpSidebar: () => void;

  // focus / caret helpers
  caretToEndId: string | null;
  setCaretToEndId: (id: string | null) => void;

  init: () => Promise<void>;
  hydrateNode: (n: ApiNode) => void;
  loadChildren: (parentId: string) => Promise<void>;

  ensureNodeLoaded: (id: string) => Promise<void>;
  _inflightNodeFetch: Record<string, Promise<void> | undefined>;

  setRootId: (id: string) => void;
  setFocusedId: (id: string | null) => void;
  getPathToRoot: (id: string) => string[];

  toggleCollapse: (id: string) => void;

  // ✅ pending text to prevent older fetches overriding local edit
  pendingText: Record<string, string | undefined>;

  updateContent: (id: string, html: string) => Promise<void>;
  appendChild: (parentId: string) => Promise<void>;
  createAfter: (id: string) => Promise<void>;
  deleteIfEmpty: (id: string) => Promise<void>;
  indent: (id: string) => Promise<void>;
  outdent: (id: string) => Promise<void>;

  moveFocusUp: () => void;
  moveFocusDown: () => void;
};

/* =========================
 * Helpers
 * ========================= */

function normalizeHasChildren(n: any, existing?: UiNode) {
  const hint = n?.has_children !== undefined ? Boolean(n.has_children) : existing?.hasChildren;
  return hint;
}

/**
 * ✅ upsertFromApi respects pendingText:
 * pendingText > api.text > existing.content
 */
function upsertFromApi(state: Store, n: ApiNode): UiNode {
  const existing = state.nodes[n.id];
  const pending = state.pendingText[n.id];

  const hasChildrenHint = normalizeHasChildren(n as any, existing);

  const shouldDefaultCollapsed =
    hasChildrenHint === true && (existing?.children?.length ?? 0) === 0;

  return {
    id: n.id,
    parentId: n.parent_id,
    content: pending !== undefined ? pending : n.text ?? existing?.content ?? "",
    orderIndex: n.order_index ?? existing?.orderIndex ?? 0,
    children: existing?.children ?? [],
    hasChildren: hasChildrenHint,
    isCollapsed:
      existing?.isCollapsed !== undefined ? existing.isCollapsed : shouldDefaultCollapsed,
  };
}

function isHttp404(err: any) {
  const msg = String(err?.message || "");
  return msg.includes("HTTP 404");
}

function safeGetErrorMessage(err: any) {
  return String(err?.message || err || "");
}

/**
 * ✅ Merge helper:
 * PATCH text 回包不要覆盖 parentId/orderIndex（避免与 indent/outdent 竞态）
 */
function mergeTextOnly(existing: UiNode | undefined, updated: ApiNode): UiNode {
  if (!existing) {
    return {
      id: updated.id,
      parentId: updated.parent_id,
      content: updated.text ?? "",
      orderIndex: updated.order_index ?? 0,
      children: [],
      hasChildren: (updated as any).has_children ?? false,
      isCollapsed: false,
    };
  }

  return {
    ...existing,
    content: updated.text ?? existing.content,
    // ✅ 不动 parentId / orderIndex / children（以当前 UI 为准）
  };
}

/* =========================
 * Store
 * ========================= */

export const useStore = create<Store>((set, get) => ({
  // ===== auth =====
  userId: null,
  email: null,
  homeId: null,

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
          sessionNonce: s.sessionNonce + 1,
        }));
      }
    } catch {
      /* ignore */
    }
  },

  setAuth: (userId, homeId, email) => {
    localStorage.setItem(AUTH_KEY, JSON.stringify({ userId, homeId, email }));

    set((s) => ({
      userId,
      email: email ?? null,
      homeId,
      rootId: homeId,
      focusedId: null,
      sessionNonce: s.sessionNonce + 1,

      // ✅ 切账号保险：清空缓存，避免旧 id 404 / 白屏
      nodes: {},
      pendingText: {},
      _inflightNodeFetch: {},
      sidebarVersion: 0,
      caretToEndId: null,
    }));
  },

  clearAuth: () => {
    localStorage.removeItem(AUTH_KEY);

    set((s) => ({
      userId: null,
      email: null,
      homeId: null,
      nodes: {},
      pendingText: {},
      rootId: "",
      focusedId: null,
      caretToEndId: null,
      _inflightNodeFetch: {},
      sidebarVersion: 0,
      sessionNonce: s.sessionNonce + 1,
    }));
  },

  // ===== data =====
  nodes: {},
  pendingText: {},

  rootId: "",
  focusedId: null,

  sidebarVersion: 0,
  bumpSidebar: () => set((s) => ({ sidebarVersion: s.sidebarVersion + 1 })),

  caretToEndId: null,
  setCaretToEndId: (id) => set({ caretToEndId: id }),

  _inflightNodeFetch: {},

  init: async () => {
    const { userId } = get();
    if (!userId) return;

    const nonce = get().sessionNonce;

    let home: { id: string; text: string; parent_id: null; user_id: string };
    try {
      home = await api.getHome();
    } catch (e) {
      console.error("[init] getHome failed:", e);
      return;
    }
    if (get().sessionNonce !== nonce) return;

    set((s) => {
      const next = { ...s.nodes };
      next[home.id] = {
        id: home.id,
        parentId: null,
        content: home.text ?? "Home",
        orderIndex: 0,
        children: [],
        hasChildren: true,
        isCollapsed: false,
      };
      return { nodes: next, homeId: home.id, rootId: home.id };
    });

    // ✅ children 拉取完成后会 bumpSidebar（见 loadChildren）
    await get().loadChildren(home.id);
  },

  hydrateNode: (n) =>
    set((s) => ({
      nodes: { ...s.nodes, [n.id]: upsertFromApi(s as any, n) },
    })),

  ensureNodeLoaded: async (id) => {
    if (!id) return;

    const nonce = get().sessionNonce;
    const st = get();

    if (st.nodes[id]?.content !== undefined) return;

    if (st._inflightNodeFetch[id]) {
      await st._inflightNodeFetch[id];
      return;
    }

    const p = (async () => {
      try {
        const n = await api.getNode(id);
        if (get().sessionNonce !== nonce) return;
        st.hydrateNode(n);
      } catch (e) {
        if (isHttp404(e)) {
          console.warn("[ensureNodeLoaded] node not found:", id);
          set((s2) => {
            const next = { ...s2.nodes };
            delete next[id];
            return { nodes: next };
          });
          return;
        }
        console.error(e);
      } finally {
        set((s2) => {
          const next = { ...s2._inflightNodeFetch };
          delete next[id];
          return { _inflightNodeFetch: next };
        });
      }
    })();

    set((s2) => ({
      _inflightNodeFetch: { ...s2._inflightNodeFetch, [id]: p },
    }));

    await p;
  },

  loadChildren: async (parentId) => {
    if (!parentId) return;

    const nonce = get().sessionNonce;

    let rows: ApiNode[];
    try {
      rows = await api.getChildren(parentId);
    } catch (e) {
      if (isHttp404(e)) {
        console.warn("[loadChildren] parent not found:", parentId);

        const st = get();
        if (st.rootId === parentId && st.homeId) {
          set({ rootId: st.homeId });
        }

        set((s) => {
          const next = { ...s.nodes };
          delete next[parentId];
          return { nodes: next };
        });

        // ✅ 重要：sidebar 不订阅 nodes，所以这里也要 bump 一下，避免卡在旧 UI
        get().bumpSidebar();
        return;
      }

      console.error("[loadChildren] failed:", safeGetErrorMessage(e));
      // 同样 bump 一下，避免 sidebar 卡住（可选）
      get().bumpSidebar();
      return;
    }

    if (get().sessionNonce !== nonce) return;

    set((s) => {
      const next = { ...s.nodes };
      const childIds: string[] = [];

      for (const r of rows) {
        next[r.id] = upsertFromApi(s as any, r);
        childIds.push(r.id);
      }

      const existingParent = next[parentId];
      next[parentId] = {
        id: parentId,
        parentId: existingParent?.parentId ?? null,
        content: existingParent?.content ?? "",
        orderIndex: existingParent?.orderIndex ?? 0,
        children: childIds,
        hasChildren: childIds.length > 0,
        isCollapsed: existingParent?.isCollapsed ?? false,
      };

      return { nodes: next };
    });

    // ✅✅ 关键修复：children 拉完后，让 sidebar 重新计算 rows
    get().bumpSidebar();
  },

  setRootId: (id) => {
    if (!id) return;
    set({ rootId: id });
    void get().ensureNodeLoaded(id).catch(console.error);
  },

  setFocusedId: (id) => set({ focusedId: id }),

  getPathToRoot: (id) => {
    const { nodes, homeId } = get();
    const path: string[] = [];
    let cur: string | null = id;

    while (cur) {
      path.push(cur);
      cur = nodes[cur]?.parentId ?? null;
    }

    path.reverse();
    return homeId && path[0] !== homeId ? [homeId, ...path] : path;
  },

  toggleCollapse: (id) => {
    set((s) => {
      const n = s.nodes[id];
      if (!n) return s;
      return { nodes: { ...s.nodes, [id]: { ...n, isCollapsed: !n.isCollapsed } } };
    });

    const n = get().nodes[id];
    if (n && !n.isCollapsed && n.children.length === 0) {
      void get().loadChildren(id).catch(console.error);
    }

    // ✅ 折叠/展开也属于 sidebar 需要更新的动作
    get().bumpSidebar();
  },

  /**
   * ✅ 根治竞态：
   * - optimistic + pendingText
   * - PATCH 成功：只合并 content（不要覆盖 parentId/orderIndex）
   */
  updateContent: async (id, html) => {
    if (!id) return;

    const nonce = get().sessionNonce;

    set((s) => {
      const n = s.nodes[id];
      if (!n) return s;
      return {
        nodes: { ...s.nodes, [id]: { ...n, content: html } },
        pendingText: { ...s.pendingText, [id]: html },
      };
    });

    get().bumpSidebar();

    try {
      const updated = await api.patchNode(id, { text: html });
      if (get().sessionNonce !== nonce) return;

      set((s) => {
        const nextPending = { ...s.pendingText };
        delete nextPending[id];

        const existing = s.nodes[id];
        return {
          pendingText: nextPending,
          nodes: { ...s.nodes, [id]: mergeTextOnly(existing, updated) },
        };
      });
    } catch (e) {
      console.error("[updateContent] failed:", safeGetErrorMessage(e));
    }
  },

  appendChild: async (parentId) => {
    const nonce = get().sessionNonce;

    try {
      await api.createNode({ parent_id: parentId, text: "" });
    } catch (e) {
      console.error("[appendChild] create failed:", safeGetErrorMessage(e));
      return;
    }

    if (get().sessionNonce !== nonce) return;

    await get().loadChildren(parentId);
    // loadChildren 已 bumpSidebar
  },

  createAfter: async (id) => {
    const nonce = get().sessionNonce;
    const st = get();

    const node = st.nodes[id];
    if (!node) return;

    const parentId = node.parentId ?? st.homeId;
    if (!parentId) return;

    let created: ApiNode;
    try {
      created = await api.createNode({ parent_id: parentId, text: "" });
    } catch (e) {
      console.error("[createAfter] create failed:", safeGetErrorMessage(e));
      return;
    }

    if (get().sessionNonce !== nonce) return;

    await st.loadChildren(parentId);

    const latest = get();
    const idx = (latest.nodes[parentId]?.children ?? []).indexOf(id) + 1;

    try {
      await api.moveNode(created.id, {
        new_parent_id: parentId,
        new_order_index: idx,
      });
    } catch (e) {
      console.error("[createAfter] move failed:", safeGetErrorMessage(e));
    }

    await st.loadChildren(parentId);

    set({ focusedId: created.id, caretToEndId: created.id });
    get().bumpSidebar();
  },

  deleteIfEmpty: async (id) => {
    const nonce = get().sessionNonce;
    const st = get();
    const node = st.nodes[id];
    if (!node?.parentId) return;

    try {
      await api.deleteNode(id);
    } catch (e) {
      if (!isHttp404(e)) {
        console.error("[deleteIfEmpty] delete failed:", safeGetErrorMessage(e));
      }
    }

    if (get().sessionNonce !== nonce) return;

    await st.loadChildren(node.parentId);

    set((s) => {
      const next = { ...s.nodes };
      const nextPending = { ...s.pendingText };
      delete next[id];
      delete nextPending[id];
      return { nodes: next, pendingText: nextPending };
    });

    get().bumpSidebar();
  },

  indent: async (id) => {
    const nonce = get().sessionNonce;
    const before = get().nodes[id];
    if (!before) return;

    const oldParentId = before.parentId;
    const keepText = before.content;

    let updated: ApiNode;
    try {
      updated = await api.indentNode(id);
    } catch (e) {
      console.error("[indent] failed:", safeGetErrorMessage(e));
      return;
    }

    if (get().sessionNonce !== nonce) return;

    const newParentId = updated.parent_id!;
    set((s) => {
      const nextNodes = { ...s.nodes };
      nextNodes[id] = upsertFromApi(s as any, updated);
      nextNodes[id] = { ...nextNodes[id], content: s.pendingText[id] ?? keepText };

      const p = nextNodes[newParentId];
      if (p) nextNodes[newParentId] = { ...p, isCollapsed: false };

      return { nodes: nextNodes };
    });

    await get().loadChildren(newParentId);

    if (oldParentId) {
      await get().loadChildren(oldParentId);
    }

    get().bumpSidebar();
  },

  outdent: async (id) => {
    const nonce = get().sessionNonce;
    const before = get().nodes[id];
    if (!before) return;

    const oldParentId = before.parentId;
    const keepText = before.content;

    let updated: ApiNode;
    try {
      updated = await api.outdentNode(id);
    } catch (e) {
      console.error("[outdent] failed:", safeGetErrorMessage(e));
      return;
    }

    if (get().sessionNonce !== nonce) return;

    const newParentId = updated.parent_id!;
    set((s) => {
      const nextNodes = { ...s.nodes };
      nextNodes[id] = upsertFromApi(s as any, updated);
      nextNodes[id] = { ...nextNodes[id], content: s.pendingText[id] ?? keepText };

      const p = nextNodes[newParentId];
      if (p) nextNodes[newParentId] = { ...p, isCollapsed: false };

      return { nodes: nextNodes };
    });

    await get().loadChildren(newParentId);

    if (oldParentId) {
      await get().loadChildren(oldParentId);
    }

    get().bumpSidebar();
  },

  moveFocusUp: () => {},
  moveFocusDown: () => {},
}));
