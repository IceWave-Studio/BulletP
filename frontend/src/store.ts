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
  };
}

function newClientId(): string {
  // modern browsers ok
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as any).randomUUID();
  }
  // fallback
  return `tmp_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function normalizeHtmlEmpty(html: string) {
  const t = html.replace(/\u200B/g, "").trim();
  return t === "" || t === "<br>";
}

function removeFromArray(arr: string[], id: string) {
  const idx = arr.indexOf(id);
  if (idx < 0) return arr.slice();
  return [...arr.slice(0, idx), ...arr.slice(idx + 1)];
}

function replaceInArray(arr: string[], from: string, to: string) {
  const idx = arr.indexOf(from);
  if (idx < 0) return arr.slice();
  const next = arr.slice();
  next[idx] = to;
  return next;
}

function insertAfter(arr: string[], afterId: string, newId: string) {
  const idx = arr.indexOf(afterId);
  if (idx < 0) return [...arr, newId];
  return [...arr.slice(0, idx + 1), newId, ...arr.slice(idx + 1)];
}

function recomputeOrderIndices(state: Store, parentId: string) {
  const p = state.nodes[parentId];
  if (!p) return;
  const nextNodes: Record<string, UiNode> = { ...state.nodes };
  const children = p.children;
  for (let i = 0; i < children.length; i++) {
    const cid = children[i];
    const cn = nextNodes[cid];
    if (!cn) continue;
    nextNodes[cid] = { ...cn, orderIndex: i };
  }
  nextNodes[parentId] = { ...p, hasChildren: children.length > 0 };
  return nextNodes;
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

        get().bumpSidebar();
        return;
      }

      console.error("[loadChildren] failed:", safeGetErrorMessage(e));
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

    get().bumpSidebar();
  },

  /**
   * ✅ updateContent 已经是 optimistic，不会阻塞交互
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
    // 这个不是核心交互（可慢），先不动
    const nonce = get().sessionNonce;

    try {
      await api.createNode({ parent_id: parentId, text: "" });
    } catch (e) {
      console.error("[appendChild] create failed:", safeGetErrorMessage(e));
      return;
    }

    if (get().sessionNonce !== nonce) return;
    await get().loadChildren(parentId);
  },

  /**
   * ✅✅ 根治 Enter 延迟：
   * - 本地立即插入一个临时节点（0ms）
   * - 立即 focus 到临时节点（0ms）
   * - 后台调用 createNode(after_id)，成功后把临时 id 替换为真实 id
   * - 后台 loadChildren 校准（不 await，不阻塞）
   */
  createAfter: async (id) => {
    const st0 = get();
    const nonce = st0.sessionNonce;

    const cur = st0.nodes[id];
    if (!cur) return;

    const parentId = cur.parentId ?? st0.homeId;
    if (!parentId) return;

    const parent = st0.nodes[parentId];
    if (!parent) return;

    // 1) 本地立即插入 temp node
    const tempId = newClientId();

    set((s) => {
      const p = s.nodes[parentId];
      if (!p) return s;

      const nextNodes: Record<string, UiNode> = { ...s.nodes };
      nextNodes[tempId] = {
        id: tempId,
        parentId,
        content: "",
        orderIndex: 0,
        children: [],
        hasChildren: false,
        isCollapsed: false,
      };

      nextNodes[parentId] = {
        ...p,
        children: insertAfter(p.children, id, tempId),
        hasChildren: true,
        isCollapsed: false,
      };

      const reordered = recomputeOrderIndices({ ...s, nodes: nextNodes } as any, parentId);
      return {
        nodes: reordered ?? nextNodes,
        focusedId: tempId,
        caretToEndId: tempId,
      };
    });

    get().bumpSidebar();

    // 2) 后台同步到服务器（绝不 await 阻塞 UI）
    void (async () => {
      try {
        const created = await api.createNode({
          parent_id: parentId,
          text: "",
          after_id: id, // ✅ 后端已支持：直接插到 id 后面，彻底消灭 moveNode
        });

        if (get().sessionNonce !== nonce) return;

        // 3) 用真实 id 替换 temp id
        set((s) => {
          const p = s.nodes[parentId];
          const tmp = s.nodes[tempId];
          if (!p || !tmp) return s;

          const nextNodes: Record<string, UiNode> = { ...s.nodes };

          // 删除 temp，写入 real
          delete nextNodes[tempId];
          nextNodes[created.id] = {
            ...tmp,
            id: created.id,
            parentId: created.parent_id,
            orderIndex: created.order_index ?? tmp.orderIndex,
            content: tmp.content ?? "",
          };

          nextNodes[parentId] = {
            ...p,
            children: replaceInArray(p.children, tempId, created.id),
            hasChildren: true,
          };

          const reordered = recomputeOrderIndices({ ...s, nodes: nextNodes } as any, parentId);

          return {
            nodes: reordered ?? nextNodes,
            focusedId: s.focusedId === tempId ? created.id : s.focusedId,
            caretToEndId: s.caretToEndId === tempId ? created.id : s.caretToEndId,
          };
        });

        get().bumpSidebar();

        // 4) 后台校准 children（不阻塞）
        void get().loadChildren(parentId).catch(console.error);
      } catch (e) {
        console.error("[createAfter] create failed:", safeGetErrorMessage(e));

        // 失败：后台校准（并可选择把 temp 留着当离线草稿）
        void get().loadChildren(parentId).catch(console.error);
      }
    })();
  },

  /**
   * ✅✅ 根治 Delete 延迟：
   * - 本地先删 + 先 focus
   * - 后台 delete，失败就 reload 校准
   */
  deleteIfEmpty: async (id) => {
    const st0 = get();
    const nonce = st0.sessionNonce;

    const node = st0.nodes[id];
    const parentId = node?.parentId;
    if (!node || !parentId) return;

    const parent = st0.nodes[parentId];
    if (!parent) return;

    // 只有在真的空内容才删（安全）
    if (!normalizeHtmlEmpty(node.content)) return;

    const idx = parent.children.indexOf(id);
    const fallbackFocus =
      (idx > 0 ? parent.children[idx - 1] : parent.children[idx + 1]) ?? parentId;

    // 1) 本地立即删除
    set((s) => {
      const p = s.nodes[parentId];
      if (!p) return s;

      const nextNodes: Record<string, UiNode> = { ...s.nodes };
      delete nextNodes[id];

      const nextPending = { ...s.pendingText };
      delete nextPending[id];

      nextNodes[parentId] = {
        ...p,
        children: removeFromArray(p.children, id),
        hasChildren: p.children.length - 1 > 0,
      };

      const reordered = recomputeOrderIndices({ ...s, nodes: nextNodes } as any, parentId);

      return {
        nodes: reordered ?? nextNodes,
        pendingText: nextPending,
        focusedId: fallbackFocus,
        caretToEndId: fallbackFocus,
      };
    });

    get().bumpSidebar();

    // 2) 后台删
    void (async () => {
      try {
        await api.deleteNode(id);
        if (get().sessionNonce !== nonce) return;
        // 后台校准
        void get().loadChildren(parentId).catch(console.error);
      } catch (e) {
        if (!isHttp404(e)) {
          console.error("[deleteIfEmpty] delete failed:", safeGetErrorMessage(e));
        }
        // 失败就校准
        void get().loadChildren(parentId).catch(console.error);
      }
    })();
  },

  /**
   * ✅✅ 根治 Tab 延迟（indent）：
   * - 本地先算新 parent 并移动
   * - 后台 indentNode
   * - 失败就 reload 校准
   */
  indent: async (id) => {
    const st0 = get();
    const nonce = st0.sessionNonce;

    const node = st0.nodes[id];
    if (!node) return;

    const oldParentId = node.parentId;
    if (!oldParentId) return;

    const oldParent = st0.nodes[oldParentId];
    if (!oldParent) return;

    const idx = oldParent.children.indexOf(id);
    if (idx <= 0) return; // 没有前一个兄弟，无法缩进

    const newParentId = oldParent.children[idx - 1];
    const newParent = st0.nodes[newParentId];
    if (!newParent) return;

    // 1) 本地立即移动
    set((s) => {
      const op = s.nodes[oldParentId];
      const np = s.nodes[newParentId];
      const n = s.nodes[id];
      if (!op || !np || !n) return s;

      const nextNodes: Record<string, UiNode> = { ...s.nodes };

      nextNodes[oldParentId] = {
        ...op,
        children: removeFromArray(op.children, id),
        hasChildren: op.children.length - 1 > 0,
      };

      nextNodes[newParentId] = {
        ...np,
        children: [...np.children, id],
        hasChildren: true,
        isCollapsed: false,
      };

      nextNodes[id] = { ...n, parentId: newParentId };

      const s1 = recomputeOrderIndices({ ...s, nodes: nextNodes } as any, oldParentId);
      const s2 = recomputeOrderIndices({ ...s, nodes: s1 ?? nextNodes } as any, newParentId);

      return {
        nodes: s2 ?? s1 ?? nextNodes,
        focusedId: id,
      };
    });

    get().bumpSidebar();

    // 2) 后台同步
    void (async () => {
      try {
        await api.indentNode(id);
        if (get().sessionNonce !== nonce) return;

        // 后台校准（不阻塞）
        void get().loadChildren(newParentId).catch(console.error);
        void get().loadChildren(oldParentId).catch(console.error);
      } catch (e) {
        console.error("[indent] failed:", safeGetErrorMessage(e));
        // 失败就校准
        void get().loadChildren(oldParentId).catch(console.error);
        void get().loadChildren(newParentId).catch(console.error);
      }
    })();
  },

  /**
   * ✅✅ 根治 Tab 延迟（outdent）：
   * - 本地把节点移到 grandParent（插在 parent 后面）
   * - 后台 outdentNode
   * - 失败就 reload 校准
   */
  outdent: async (id) => {
    const st0 = get();
    const nonce = st0.sessionNonce;

    const node = st0.nodes[id];
    if (!node) return;

    const parentId = node.parentId;
    if (!parentId) return;

    const parent = st0.nodes[parentId];
    if (!parent) return;

    const grandParentId = parent.parentId;
    if (!grandParentId) return; // parent 已经是 root 级，无法反缩进

    const grand = st0.nodes[grandParentId];
    if (!grand) return;

    // 在 grandParent.children 里插到 parent 后面
    const afterId = parentId;

    // 1) 本地立即移动
    set((s) => {
      const p = s.nodes[parentId];
      const g = s.nodes[grandParentId];
      const n = s.nodes[id];
      if (!p || !g || !n) return s;

      const nextNodes: Record<string, UiNode> = { ...s.nodes };

      nextNodes[parentId] = {
        ...p,
        children: removeFromArray(p.children, id),
        hasChildren: p.children.length - 1 > 0,
      };

      nextNodes[grandParentId] = {
        ...g,
        children: insertAfter(g.children, afterId, id),
        hasChildren: true,
        isCollapsed: false,
      };

      nextNodes[id] = { ...n, parentId: grandParentId };

      const s1 = recomputeOrderIndices({ ...s, nodes: nextNodes } as any, parentId);
      const s2 = recomputeOrderIndices({ ...s, nodes: s1 ?? nextNodes } as any, grandParentId);

      return {
        nodes: s2 ?? s1 ?? nextNodes,
        focusedId: id,
      };
    });

    get().bumpSidebar();

    // 2) 后台同步
    void (async () => {
      try {
        await api.outdentNode(id);
        if (get().sessionNonce !== nonce) return;

        void get().loadChildren(parentId).catch(console.error);
        void get().loadChildren(grandParentId).catch(console.error);
      } catch (e) {
        console.error("[outdent] failed:", safeGetErrorMessage(e));
        void get().loadChildren(parentId).catch(console.error);
        void get().loadChildren(grandParentId).catch(console.error);
      }
    })();
  },

  moveFocusUp: () => {},
  moveFocusDown: () => {},
}));
