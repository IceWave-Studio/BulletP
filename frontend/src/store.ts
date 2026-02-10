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

  // ✅ 如果这是 UI temp 节点，serverId 记录真实 id
  serverId?: string;
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
  pendingTextRev: Record<string, number | undefined>;

  // ✅ tempId -> realId（仅用于 API resolve，不用于 UI 替换 key）
  idRedirect: Record<string, string | undefined>;
  // ✅ realId -> tempId（用于 loadChildren 去重/稳定 key）
  realToTemp: Record<string, string | undefined>;

  // ✅ create 管理：temp 创建中 + 是否被取消
  pendingCreate: Record<
    string,
    { parentId: string; canceled: boolean; createdRealId?: string | null } | undefined
  >;

  // ✅ temp 节点结构操作队列（Enter 后秒 Tab）
  pendingOps: Record<string, { indent?: boolean; outdent?: boolean } | undefined>;

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

function isHttp404(err: any) {
  const msg = String(err?.message || "");
  return msg.includes("HTTP 404");
}

function safeGetErrorMessage(err: any) {
  return String(err?.message || err || "");
}

function newClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `tmp_${(crypto as any).randomUUID()}`;
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

/**
 * ✅ resolveId：把 UI id 映射到真实 server id（仅用于 API）
 * - 如果是 temp node 且有 serverId：用 serverId
 * - 如果有 idRedirect：继续 resolve
 */
function resolveIdForApi(state: Store, uiId: string): string {
  let cur = uiId;

  // 优先用 node.serverId
  const n = state.nodes[cur];
  if (n?.serverId) cur = n.serverId;

  for (let i = 0; i < 8; i++) {
    const nxt = state.idRedirect[cur];
    if (!nxt) break;
    cur = nxt;
  }
  return cur;
}

/**
 * ✅ upsert：支持把「API realId」写入到「UI tempId」上（保证 key 稳定）
 */
function upsertFromApiToUiId(state: Store, uiId: string, apiNode: ApiNode): UiNode {
  const existing = state.nodes[uiId];
  const pending = state.pendingText[uiId];

  const hasChildrenHint = normalizeHasChildren(apiNode as any, existing);

  const shouldDefaultCollapsed =
    hasChildrenHint === true && (existing?.children?.length ?? 0) === 0;

  return {
    id: uiId,
    parentId: apiNode.parent_id,
    content: pending !== undefined ? pending : apiNode.text ?? existing?.content ?? "",
    orderIndex: apiNode.order_index ?? existing?.orderIndex ?? 0,
    children: existing?.children ?? [],
    hasChildren: hasChildrenHint,
    isCollapsed:
      existing?.isCollapsed !== undefined ? existing.isCollapsed : shouldDefaultCollapsed,

    // 如果 existing 是 temp，保留 serverId
    serverId: existing?.serverId,
  };
}

/**
 * PATCH text 回包只改 content，不碰 parent/order/children
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
      realToTemp: {},
      pendingCreate: {},
      pendingOps: {},
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
      realToTemp: {},
      pendingCreate: {},
      pendingOps: {},
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
  realToTemp: {},
  pendingCreate: {},
  pendingOps: {},

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
    set((s) => {
      // 如果这是 server realId，但我们已有 temp 映射，则写回 temp
      const uiId = s.realToTemp[n.id] ?? n.id;
      return { nodes: { ...s.nodes, [uiId]: upsertFromApiToUiId(s as any, uiId, n) } };
    }),

  ensureNodeLoaded: async (id) => {
    if (!id) return;

    const nonce = get().sessionNonce;
    const st = get();

    const apiId = resolveIdForApi(st, id);
    const uiId = st.realToTemp[apiId] ?? id;

    if (st.nodes[uiId]?.content !== undefined) return;

    if (st._inflightNodeFetch[apiId]) {
      await st._inflightNodeFetch[apiId];
      return;
    }

    const p = (async () => {
      try {
        const n = await api.getNode(apiId);
        if (get().sessionNonce !== nonce) return;
        get().hydrateNode(n);
      } catch (e) {
        if (isHttp404(e)) {
          set((s2) => {
            const next = { ...s2.nodes };
            delete next[uiId];
            return { nodes: next };
          });
          return;
        }
        console.error(e);
      } finally {
        set((s2) => {
          const next = { ...s2._inflightNodeFetch };
          delete next[apiId];
          return { _inflightNodeFetch: next };
        });
      }
    })();

    set((s2) => ({
      _inflightNodeFetch: { ...s2._inflightNodeFetch, [apiId]: p },
    }));

    await p;
  },

  loadChildren: async (parentId) => {
    if (!parentId) return;

    const nonce = get().sessionNonce;
    const st0 = get();

    const apiParentId = resolveIdForApi(st0, parentId);
    const uiParentId = st0.realToTemp[apiParentId] ?? parentId;

    let rows: ApiNode[];
    try {
      rows = await api.getChildren(apiParentId);
    } catch (e) {
      if (isHttp404(e)) {
        const st = get();
        if (st.rootId === uiParentId && st.homeId) {
          set({ rootId: st.homeId });
        }

        set((s) => {
          const next = { ...s.nodes };
          delete next[uiParentId];
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
        // ✅ server 返回 realId，如果已有 temp 映射，用 tempId 作为 UI id
        const uiChildId = s.realToTemp[r.id] ?? r.id;

        // ✅ 把 API 节点写入对应 UI id（避免出现 real+temp 两份导致闪烁）
        next[uiChildId] = upsertFromApiToUiId(s as any, uiChildId, r);

        // 如果这个 UI 节点是 temp，但还没写 serverId，这里补一下
        if (uiChildId !== r.id) {
          next[uiChildId] = { ...next[uiChildId], serverId: r.id };
        }

        childIds.push(uiChildId);
      }

      const existingParent = next[uiParentId];
      next[uiParentId] = {
        id: uiParentId,
        parentId: existingParent?.parentId ?? null,
        content: existingParent?.content ?? "",
        orderIndex: existingParent?.orderIndex ?? 0,
        children: childIds,
        hasChildren: childIds.length > 0,
        isCollapsed: existingParent?.isCollapsed ?? false,
        serverId: existingParent?.serverId,
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

  updateContent: async (id, html) => {
    if (!id) return;

    const nonce = get().sessionNonce;
    let myRev = 0;

    set((s) => {
      const n = s.nodes[id];
      if (!n) return s;

      const prev = s.pendingTextRev[id] ?? 0;
      myRev = prev + 1;

      return {
        nodes: { ...s.nodes, [id]: { ...n, content: html } },
        pendingText: { ...s.pendingText, [id]: html },
        pendingTextRev: { ...s.pendingTextRev, [id]: myRev },
      };
    });

    get().bumpSidebar();

    const apiId = resolveIdForApi(get(), id);

    try {
      const updated = await api.patchNode(apiId, { text: html });
      if (get().sessionNonce !== nonce) return;

      set((s) => {
        // ✅ 只认最新 rev，旧回包不允许覆盖（防止“最后几个字母消失又回来”）
        if ((s.pendingTextRev[id] ?? 0) !== myRev) return s;

        const nextPending = { ...s.pendingText };
        const nextRev = { ...s.pendingTextRev };
        delete nextPending[id];
        delete nextRev[id];

        const existing = s.nodes[id];
        return {
          pendingText: nextPending,
          pendingTextRev: nextRev,
          nodes: { ...s.nodes, [id]: mergeTextOnly(existing, updated) },
        };
      });
    } catch (e) {
      if (isHttp404(e)) return;
      console.error("[updateContent] failed:", safeGetErrorMessage(e));
    }
  },

  appendChild: async (parentId) => {
    const nonce = get().sessionNonce;
    const apiParentId = resolveIdForApi(get(), parentId);

    try {
      await api.createNode({ parent_id: apiParentId, text: "" });
    } catch (e) {
      console.error("[appendChild] create failed:", safeGetErrorMessage(e));
      return;
    }

    if (get().sessionNonce !== nonce) return;
    await get().loadChildren(parentId);
  },

  /**
   * ✅✅ 根治 Enter + 光标丢失：
   * - UI 永远用 tempId 渲染，不做 temp->real key 替换
   * - 只记录映射：tempId.serverId / idRedirect / realToTemp
   * - loadChildren 会自动把 real 映射回 temp，避免闪烁和重复
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

    const tempId = newClientId();

    // 1) UI 立即插入 temp
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
        pendingCreate: {
          ...s.pendingCreate,
          [tempId]: { parentId, canceled: false, createdRealId: null },
        },
        focusedId: tempId,
        caretToEndId: tempId,
      };
    });

    get().bumpSidebar();

    // 2) 后台 create（不阻塞 UI）
    void (async () => {
      try {
        let created: ApiNode;

        try {
          created = await api.createNode({
            parent_id: resolveIdForApi(get(), parentId),
            text: "",
            after_id: resolveIdForApi(get(), id),
          });
        } catch (e: any) {
          const msg = safeGetErrorMessage(e);
          if (msg.includes("after not found")) {
            created = await api.createNode({
              parent_id: resolveIdForApi(get(), parentId),
              text: "",
            });
          } else {
            throw e;
          }
        }

        if (get().sessionNonce !== nonce) return;

        const st1 = get();
        const pc = st1.pendingCreate[tempId];
        const tempStillExists = Boolean(st1.nodes[tempId]);
        const canceled = pc?.canceled === true;

        // 如果 temp 被秒删：创建成功也要立即删 real（防止“过一会节点又出现”）
        if (canceled || !tempStillExists) {
          try {
            await api.deleteNode(created.id);
          } catch {
            /* ignore */
          }
          void get().loadChildren(parentId).catch(console.error);

          set((s) => {
            const next = { ...s.pendingCreate };
            delete next[tempId];
            return { pendingCreate: next };
          });

          return;
        }

        // ✅ 关键：不替换 tempId！只记录映射 & 把 serverId 写到 temp 节点上
        set((s) => {
          const tmp = s.nodes[tempId];
          if (!tmp) return s;

          return {
            nodes: {
              ...s.nodes,
              [tempId]: { ...tmp, serverId: created.id },
            },
            idRedirect: {
              ...s.idRedirect,
              [tempId]: created.id,
            },
            realToTemp: {
              ...s.realToTemp,
              [created.id]: tempId,
            },
            pendingCreate: {
              ...s.pendingCreate,
              [tempId]: { parentId, canceled: false, createdRealId: created.id },
            },
          };
        });

        get().bumpSidebar();

        // 如果用户在 temp 上秒按 Tab，我们这里自动执行队列（但 UI 不会再闪）
        const st2 = get();
        const op = st2.pendingOps[tempId];
        if (op) {
          set((s) => {
            const next = { ...s.pendingOps };
            delete next[tempId];
            return { pendingOps: next };
          });

          if (op.indent) void get().indent(tempId).catch(console.error);
          if (op.outdent) void get().outdent(tempId).catch(console.error);
        }

        // 背景校准（不会造成 key 替换，所以不会丢光标）
        void get().loadChildren(parentId).catch(console.error);

        set((s) => {
          const next = { ...s.pendingCreate };
          delete next[tempId];
          return { pendingCreate: next };
        });
      } catch (e) {
        console.error("[createAfter] create failed:", safeGetErrorMessage(e));
        void get().loadChildren(parentId).catch(console.error);
      }
    })();
  },

  deleteIfEmpty: async (id) => {
    const st0 = get();
    const nonce = st0.sessionNonce;

    const node = st0.nodes[id];
    const parentId = node?.parentId;
    if (!node || !parentId) return;

    const parent = st0.nodes[parentId];
    if (!parent) return;

    if (!normalizeHtmlEmpty(node.content)) return;

    // temp 秒删：标记 canceled，让 create 成功后自动删 real
    if (isTempId(id)) {
      set((s) => {
        const pc = s.pendingCreate[id];
        if (!pc) return s;
        return { pendingCreate: { ...s.pendingCreate, [id]: { ...pc, canceled: true } } };
      });
    }

    const idx = parent.children.indexOf(id);
    const fallbackFocus =
      (idx > 0 ? parent.children[idx - 1] : parent.children[idx + 1]) ?? parentId;

    // UI 立即删除
    set((s) => {
      const p = s.nodes[parentId];
      if (!p) return s;

      const nextNodes: Record<string, UiNode> = { ...s.nodes };
      delete nextNodes[id];

      const nextPending = { ...s.pendingText };
      delete nextPending[id];

      const nextRev = { ...s.pendingTextRev };
      delete nextRev[id];

      const nextRedirect = { ...s.idRedirect };
      delete nextRedirect[id];

      // 如果这是 temp 且有 serverId，把 reverse map 也删掉
      const realId = s.nodes[id]?.serverId;
      const nextRealToTemp = { ...s.realToTemp };
      if (realId) delete nextRealToTemp[realId];

      nextNodes[parentId] = {
        ...p,
        children: removeFromArray(p.children, id),
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
        realToTemp: nextRealToTemp,
        focusedId: fallbackFocus,
        caretToEndId: fallbackFocus,
      };
    });

    get().bumpSidebar();

    // 后台删除：若 temp 没落地会 404，忽略即可
    const apiId = resolveIdForApi(get(), id);

    void (async () => {
      try {
        await api.deleteNode(apiId);
        if (get().sessionNonce !== nonce) return;
        void get().loadChildren(parentId).catch(console.error);
      } catch (e) {
        if (!isHttp404(e)) {
          console.error("[deleteIfEmpty] delete failed:", safeGetErrorMessage(e));
        }
        void get().loadChildren(parentId).catch(console.error);
      }
    })();
  },

  /**
   * ✅✅ Tab 缩进：
   * - UI 立即移动（即使是 temp）
   * - 若 temp 未落地：只记录 pendingOps，等落地后再打 API（不会 404）
   * - 若已落地：直接打 API + 背景校准
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
    if (idx <= 0) return;

    const newParentId = oldParent.children[idx - 1];
    const newParent = st0.nodes[newParentId];
    if (!newParent) return;

    // 1) UI 立即移动（不管是否 temp）
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

    // 2) 若 temp 未落地：排队，不打 API（防 404）
    const st1 = get();
    const apiId = resolveIdForApi(st1, id);
    if (isTempId(id) && !st1.nodes[id]?.serverId && apiId === id) {
      set((s) => ({
        pendingOps: {
          ...s.pendingOps,
          [id]: { ...(s.pendingOps[id] ?? {}), indent: true },
        },
      }));
      return;
    }

    // 3) 后台同步
    void (async () => {
      try {
        await api.indentNode(resolveIdForApi(get(), id));
        if (get().sessionNonce !== nonce) return;

        void get().loadChildren(newParentId).catch(console.error);
        void get().loadChildren(oldParentId).catch(console.error);
      } catch (e) {
        if (!isHttp404(e)) console.error("[indent] failed:", safeGetErrorMessage(e));
        void get().loadChildren(oldParentId).catch(console.error);
        void get().loadChildren(newParentId).catch(console.error);
      }
    })();
  },

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
    if (!grandParentId) return;

    const grand = st0.nodes[grandParentId];
    if (!grand) return;

    const afterId = parentId;

    // 1) UI 立即移动
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

      return { nodes: s2 ?? s1 ?? nextNodes, focusedId: id };
    });

    get().bumpSidebar();

    // 2) temp 未落地：排队
    const st1 = get();
    const apiId = resolveIdForApi(st1, id);
    if (isTempId(id) && !st1.nodes[id]?.serverId && apiId === id) {
      set((s) => ({
        pendingOps: {
          ...s.pendingOps,
          [id]: { ...(s.pendingOps[id] ?? {}), outdent: true },
        },
      }));
      return;
    }

    // 3) 后台同步
    void (async () => {
      try {
        await api.outdentNode(resolveIdForApi(get(), id));
        if (get().sessionNonce !== nonce) return;

        void get().loadChildren(parentId).catch(console.error);
        void get().loadChildren(grandParentId).catch(console.error);
      } catch (e) {
        if (!isHttp404(e)) console.error("[outdent] failed:", safeGetErrorMessage(e));
        void get().loadChildren(parentId).catch(console.error);
        void get().loadChildren(grandParentId).catch(console.error);
      }
    })();
  },

  moveFocusUp: () => {},
  moveFocusDown: () => {},
}));
