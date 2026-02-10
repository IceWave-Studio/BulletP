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

  // ✅ 防乱序 PATCH 回包（旧回包不得覆盖新内容）
  pendingTextRev: Record<string, number | undefined>;

  // ✅ tempId -> realId redirect（解决 temp 被替换后仍有 flush/patch）
  idRedirect: Record<string, string | undefined>;

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

function isTempId(id: string) {
  return id.startsWith("tmp_");
}

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
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as any).randomUUID();
  }
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

function resolveId(state: Store, id: string): string {
  // follow redirects (temp -> real), prevent loops
  let cur = id;
  for (let i = 0; i < 8; i++) {
    const nxt = state.idRedirect[cur];
    if (!nxt) break;
    cur = nxt;
  }
  return cur;
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
      pendingTextRev: {},
      idRedirect: {},
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
      pendingTextRev: {},
      idRedirect: {},
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
  pendingTextRev: {},
  idRedirect: {},

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

    const rid = resolveId(st, id);
    if (st.nodes[rid]?.content !== undefined) return;

    if (st._inflightNodeFetch[rid]) {
      await st._inflightNodeFetch[rid];
      return;
    }

    const p = (async () => {
      try {
        const n = await api.getNode(rid);
        if (get().sessionNonce !== nonce) return;
        st.hydrateNode(n);
      } catch (e) {
        if (isHttp404(e)) {
          console.warn("[ensureNodeLoaded] node not found:", rid);
          set((s2) => {
            const next = { ...s2.nodes };
            delete next[rid];
            return { nodes: next };
          });
          return;
        }
        console.error(e);
      } finally {
        set((s2) => {
          const next = { ...s2._inflightNodeFetch };
          delete next[rid];
          return { _inflightNodeFetch: next };
        });
      }
    })();

    set((s2) => ({
      _inflightNodeFetch: { ...s2._inflightNodeFetch, [rid]: p },
    }));

    await p;
  },

  loadChildren: async (parentId) => {
    if (!parentId) return;

    const nonce = get().sessionNonce;
    const st0 = get();
    const pid = resolveId(st0, parentId);

    let rows: ApiNode[];
    try {
      rows = await api.getChildren(pid);
    } catch (e) {
      if (isHttp404(e)) {
        console.warn("[loadChildren] parent not found:", pid);

        const st = get();
        if (st.rootId === pid && st.homeId) {
          set({ rootId: st.homeId });
        }

        set((s) => {
          const next = { ...s.nodes };
          delete next[pid];
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

      const existingParent = next[pid];
      next[pid] = {
        id: pid,
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
    let cur: string | null = resolveId(get(), id);

    while (cur) {
      path.push(cur);
      cur = nodes[cur]?.parentId ?? null;
    }

    path.reverse();
    return homeId && path[0] !== homeId ? [homeId, ...path] : path;
  },

  toggleCollapse: (id) => {
    const st0 = get();
    const rid = resolveId(st0, id);

    set((s) => {
      const n = s.nodes[rid];
      if (!n) return s;
      return { nodes: { ...s.nodes, [rid]: { ...n, isCollapsed: !n.isCollapsed } } };
    });

    const n = get().nodes[rid];
    if (n && !n.isCollapsed && n.children.length === 0) {
      void get().loadChildren(rid).catch(console.error);
    }

    get().bumpSidebar();
  },

  /**
   * ✅✅ 根治“丢字 / 冒字 / 404 乱序”：
   * - idRedirect：tempId late flush 自动写到 realId
   * - pendingTextRev：旧 PATCH 回包直接丢弃
   * - 404 node not found：生命周期结束信号，吞掉不回滚
   */
  updateContent: async (id, html) => {
    const st0 = get();
    const rid = resolveId(st0, id);
    if (!rid) return;

    const nonce = get().sessionNonce;
    let myRev = 0;

    set((s) => {
      const realId = resolveId(s, id);
      const n = s.nodes[realId];
      if (!n) return s;

      const prev = s.pendingTextRev[realId] ?? 0;
      myRev = prev + 1;

      return {
        nodes: { ...s.nodes, [realId]: { ...n, content: html } },
        pendingText: { ...s.pendingText, [realId]: html },
        pendingTextRev: { ...s.pendingTextRev, [realId]: myRev },
      };
    });

    get().bumpSidebar();

    try {
      const updated = await api.patchNode(rid, { text: html });
      if (get().sessionNonce !== nonce) return;

      set((s) => {
        const realId = resolveId(s, id);
        if ((s.pendingTextRev[realId] ?? 0) !== myRev) return s;

        const nextPending = { ...s.pendingText };
        const nextRev = { ...s.pendingTextRev };
        delete nextPending[realId];
        delete nextRev[realId];

        const existing = s.nodes[realId];
        return {
          pendingText: nextPending,
          pendingTextRev: nextRev,
          nodes: { ...s.nodes, [realId]: mergeTextOnly(existing, updated) },
        };
      });
    } catch (e) {
      // ✅ 404 = 节点生命周期已结束（被 delete / temp 替换 / move），吞掉不回滚
      if (isHttp404(e)) return;
      console.error("[updateContent] failed:", safeGetErrorMessage(e));
    }
  },

  appendChild: async (parentId) => {
    const nonce = get().sessionNonce;
    const pid = resolveId(get(), parentId);

    try {
      await api.createNode({ parent_id: pid, text: "" });
    } catch (e) {
      console.error("[appendChild] create failed:", safeGetErrorMessage(e));
      return;
    }

    if (get().sessionNonce !== nonce) return;
    await get().loadChildren(pid);
  },

  /**
   * ✅✅ 根治 Enter 延迟 + “新建后快速输入会消失”
   * - 本地插 temp（0ms）
   * - focus temp（0ms）
   * - 后台 createNode 成功后：
   *   - 设置 idRedirect[temp] = real（关键）
   *   - 把 temp 的 content/pendingText/pendingRev 全迁移到 real（关键）
   *   - children 里把 temp 替换成 real
   */
  createAfter: async (id) => {
    const st0 = get();
    const nonce = st0.sessionNonce;

    const rid = resolveId(st0, id);
    const cur = st0.nodes[rid];
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
        children: insertAfter(p.children, rid, tempId),
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

    // 2) 后台同步（不阻塞）
    void (async () => {
      try {
        // ✅ after_id 必须是后端真实存在的 id；tempId 不允许
        const afterId = isTempId(rid) ? null : rid;

        let created: ApiNode;
        try {
          created = await api.createNode({
            parent_id: parentId,
            text: "",
            ...(afterId ? { after_id: afterId } : {}),
          });
        } catch (e) {
          // ✅ after not found：退化为不带 after_id
          // ✅ after not found: 退化为不带 after_id
          const msg = safeGetErrorMessage(e);
          if (msg.includes("after not found")) {
            created = await api.createNode({ parent_id: parentId, text: "" });
          } else {
            throw e;
          }
        }

        if (get().sessionNonce !== nonce) return;

        set((s) => {
          const p = s.nodes[parentId];
          const tmp = s.nodes[tempId];
          if (!p || !tmp) return s;

          const nextNodes: Record<string, UiNode> = { ...s.nodes };
          const nextPending = { ...s.pendingText };
          const nextRev = { ...s.pendingTextRev };
          const nextRedirect = { ...s.idRedirect };

          // ✅ 建立 redirect：temp 的任何晚到更新都写入 real
          nextRedirect[tempId] = created.id;

          // ✅ 把 temp 的最新 store 内容迁移到 real（关键）
          const tempContent = tmp.content ?? "";
          const tempPending = nextPending[tempId];
          const tempRev = nextRev[tempId];

          // 删除 temp node（渲染层会卸载 temp DOM）
          delete nextNodes[tempId];

          // 写入 real node：优先用 pendingText（如果 temp 有未确认内容）
          const finalContent = tempPending !== undefined ? tempPending : tempContent;

          nextNodes[created.id] = {
            ...tmp,
            id: created.id,
            parentId: created.parent_id,
            orderIndex: created.order_index ?? tmp.orderIndex,
            content: finalContent,
          };

          // parent children 替换 temp -> real
          nextNodes[parentId] = {
            ...p,
            children: replaceInArray(p.children, tempId, created.id),
            hasChildren: true,
          };

          // 迁移 pendingText/pendingRev
          if (tempPending !== undefined) {
            nextPending[created.id] = tempPending;
            delete nextPending[tempId];
          }
          if (tempRev !== undefined) {
            nextRev[created.id] = tempRev;
            delete nextRev[tempId];
          }

          // ✅ 强制把 real 标记为 pending（避免 loadChildren 覆盖）
          if (finalContent !== "") {
            nextPending[created.id] = finalContent;
            nextRev[created.id] = (nextRev[created.id] ?? 0) + 1;
          }

          const reordered = recomputeOrderIndices(
            { ...s, nodes: nextNodes, pendingText: nextPending, pendingTextRev: nextRev } as any,
            parentId
          );

          return {
            nodes: reordered ?? nextNodes,
            pendingText: nextPending,
            pendingTextRev: nextRev,
            idRedirect: nextRedirect,
            focusedId: s.focusedId === tempId ? created.id : s.focusedId,
            caretToEndId: s.caretToEndId === tempId ? created.id : s.caretToEndId,
          };
        });

        get().bumpSidebar();
        void get().loadChildren(parentId).catch(console.error);
      } catch (e) {
        console.error("[createAfter] create failed:", safeGetErrorMessage(e));
        void get().loadChildren(parentId).catch(console.error);
      }
    })();
  },

  /**
   * ✅✅ 删除空行：本地先删，后台删，失败校准
   * - 同时清理 pendingTextRev / redirect
   */
  deleteIfEmpty: async (id) => {
    const st0 = get();
    const nonce = st0.sessionNonce;

    const rid = resolveId(st0, id);
    const node = st0.nodes[rid];
    const parentId = node?.parentId;
    if (!node || !parentId) return;

    const parent = st0.nodes[parentId];
    if (!parent) return;

    if (!normalizeHtmlEmpty(node.content)) return;

    const idx = parent.children.indexOf(rid);
    const fallbackFocus =
      (idx > 0 ? parent.children[idx - 1] : parent.children[idx + 1]) ?? parentId;

    set((s) => {
      const p = s.nodes[parentId];
      if (!p) return s;

      const nextNodes: Record<string, UiNode> = { ...s.nodes };
      delete nextNodes[rid];

      const nextPending = { ...s.pendingText };
      delete nextPending[rid];

      const nextRev = { ...s.pendingTextRev };
      delete nextRev[rid];

      const nextRedirect = { ...s.idRedirect };
      delete nextRedirect[rid];

      nextNodes[parentId] = {
        ...p,
        children: removeFromArray(p.children, rid),
        hasChildren: p.children.length - 1 > 0,
      };

      const reordered = recomputeOrderIndices(
        { ...s, nodes: nextNodes, pendingText: nextPending, pendingTextRev: nextRev } as any,
        parentId
      );

      return {
        nodes: reordered ?? nextNodes,
        pendingText: nextPending,
        pendingTextRev: nextRev,
        idRedirect: nextRedirect,
        focusedId: fallbackFocus,
        caretToEndId: fallbackFocus,
      };
    });

    get().bumpSidebar();

    void (async () => {
      try {
        await api.deleteNode(rid);
        if (get().sessionNonce !== nonce) return;
        void get().loadChildren(parentId).catch(console.error);
      } catch (e) {
        if (!isHttp404(e)) console.error("[deleteIfEmpty] delete failed:", safeGetErrorMessage(e));
        void get().loadChildren(parentId).catch(console.error);
      }
    })();
  },

  /**
   * ✅ indent：本地移动 + 后台校准
   * - 所有 id 先 resolve，避免对 tempId 操作
   */
  indent: async (id) => {
    const st0 = get();
    const nonce = st0.sessionNonce;

    const rid = resolveId(st0, id);
    const node = st0.nodes[rid];
    if (!node) return;

    const oldParentId = node.parentId;
    if (!oldParentId) return;

    const oldParent = st0.nodes[oldParentId];
    if (!oldParent) return;

    const idx = oldParent.children.indexOf(rid);
    if (idx <= 0) return;

    const newParentId = resolveId(st0, oldParent.children[idx - 1]);
    const newParent = st0.nodes[newParentId];
    if (!newParent) return;

    set((s) => {
      const op = s.nodes[oldParentId];
      const np = s.nodes[newParentId];
      const n = s.nodes[rid];
      if (!op || !np || !n) return s;

      const nextNodes: Record<string, UiNode> = { ...s.nodes };

      nextNodes[oldParentId] = {
        ...op,
        children: removeFromArray(op.children, rid),
        hasChildren: op.children.length - 1 > 0,
      };

      nextNodes[newParentId] = {
        ...np,
        children: [...np.children, rid],
        hasChildren: true,
        isCollapsed: false,
      };

      nextNodes[rid] = { ...n, parentId: newParentId };

      const s1 = recomputeOrderIndices({ ...s, nodes: nextNodes } as any, oldParentId);
      const s2 = recomputeOrderIndices({ ...s, nodes: s1 ?? nextNodes } as any, newParentId);

      return { nodes: s2 ?? s1 ?? nextNodes, focusedId: rid };
    });

    get().bumpSidebar();

    void (async () => {
      try {
        await api.indentNode(rid);
        if (get().sessionNonce !== nonce) return;
        void get().loadChildren(newParentId).catch(console.error);
        void get().loadChildren(oldParentId).catch(console.error);
      } catch (e) {
        console.error("[indent] failed:", safeGetErrorMessage(e));
        void get().loadChildren(oldParentId).catch(console.error);
        void get().loadChildren(newParentId).catch(console.error);
      }
    })();
  },

  /**
   * ✅ outdent：本地移动 + 后台校准
   * - 所有 id 先 resolve，避免对 tempId 操作
   */
  outdent: async (id) => {
    const st0 = get();
    const nonce = st0.sessionNonce;

    const rid = resolveId(st0, id);
    const node = st0.nodes[rid];
    if (!node) return;

    const parentId = node.parentId;
    if (!parentId) return;

    const parent = st0.nodes[parentId];
    if (!parent) return;

    const grandParentId = parent.parentId;
    if (!grandParentId) return;

    const grand = st0.nodes[grandParentId];
    if (!grand) return;

    const afterId = parentId;

    set((s) => {
      const p = s.nodes[parentId];
      const g = s.nodes[grandParentId];
      const n = s.nodes[rid];
      if (!p || !g || !n) return s;

      const nextNodes: Record<string, UiNode> = { ...s.nodes };

      nextNodes[parentId] = {
        ...p,
        children: removeFromArray(p.children, rid),
        hasChildren: p.children.length - 1 > 0,
      };

      nextNodes[grandParentId] = {
        ...g,
        children: insertAfter(g.children, afterId, rid),
        hasChildren: true,
        isCollapsed: false,
      };

      nextNodes[rid] = { ...n, parentId: grandParentId };

      const s1 = recomputeOrderIndices({ ...s, nodes: nextNodes } as any, parentId);
      const s2 = recomputeOrderIndices({ ...s, nodes: s1 ?? nextNodes } as any, grandParentId);

      return { nodes: s2 ?? s1 ?? nextNodes, focusedId: rid };
    });

    get().bumpSidebar();

    void (async () => {
      try {
        await api.outdentNode(rid);
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
