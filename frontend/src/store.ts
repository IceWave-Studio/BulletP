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

  // ✅ temp 节点落地后对应的真实 id（UI 仍用 temp id 做 key，避免重挂载丢光标）
  serverId?: string;
};

const AUTH_KEY = "bulletp_auth_v1";

/* =========================
 * Store shape
 * ========================= */

type PendingOp = {
  indent?: { fromParentId: string; toParentId: string };
  outdent?: { fromParentId: string; toParentId: string };
};

type Store = {
  // ---------- auth ----------
  userId: string | null;
  email: string | null;
  homeId: string | null;

  hydrateAuth: () => void;
  setAuth: (userId: string, homeId: string, email?: string) => void;
  clearAuth: () => void;

  sessionNonce: number;

  // ---------- data ----------
  nodes: Record<string, UiNode>;
  rootId: string;
  focusedId: string | null;

  sidebarVersion: number;
  bumpSidebar: () => void;

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

  pendingText: Record<string, string | undefined>;
  pendingTextRev: Record<string, number | undefined>;

  // tempId -> realId (API resolve)
  idRedirect: Record<string, string | undefined>;
  // realId -> tempId (UI stable key)
  realToTemp: Record<string, string | undefined>;

  // temp create 状态（用于取消）
  pendingCreate: Record<
    string,
    { parentId: string; canceled: boolean; createdRealId?: string | null } | undefined
  >;

  pendingOps: Record<string, PendingOp | undefined>;

  // realId 墓碑，避免 loadChildren 把“已删的 real”拉回
  tombstoneReal: Record<string, number | undefined>;

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

function isHttp404(err: any) {
  const msg = String(err?.message || "");
  return msg.includes("HTTP 404");
}

function safeGetErrorMessage(err: any) {
  return String(err?.message || err || "");
}

function normalizeHasChildren(n: any, existing?: UiNode) {
  const hint = n?.has_children !== undefined ? Boolean(n.has_children) : existing?.hasChildren;
  return hint;
}

function upsertFromApiToUiId(state: Store, uiId: string, n: ApiNode): UiNode {
  const existing = state.nodes[uiId];
  const pending = state.pendingText[uiId];

  const hasChildrenHint = normalizeHasChildren(n as any, existing);

  const shouldDefaultCollapsed =
    hasChildrenHint === true && (existing?.children?.length ?? 0) === 0;

  return {
    id: uiId,
    parentId: n.parent_id,
    content: pending !== undefined ? pending : n.text ?? existing?.content ?? "",
    orderIndex: n.order_index ?? existing?.orderIndex ?? 0,
    children: existing?.children ?? [],
    hasChildren: hasChildrenHint,
    isCollapsed:
      existing?.isCollapsed !== undefined ? existing.isCollapsed : shouldDefaultCollapsed,
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
 * ✅ resolveIdForApi：把 uiId 映射到真实 serverId（仅用于 API）
 */
function resolveIdForApi(state: Store, uiId: string): string {
  let cur = uiId;

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
 * ✅ tombstone：短时间内忽略已经“本地删掉”的 realId，避免 loadChildren 拉回
 */
function isTombstoned(state: Store, realId: string) {
  const t = state.tombstoneReal[realId];
  if (!t) return false;
  return Date.now() - t < 5 * 60 * 1000;
}

/**
 * ✅ children 合并：核心修复
 * 规则：
 * 1) 本地 children 里只要节点还存在，就保留（尤其 temp）
 * 2) server 返回的 realId 先映射到 tempId（realToTemp）再合并
 * 3) 最终顺序：本地顺序优先 + 补齐 server 有但本地没有的
 */
function mergeChildrenPreserveLocal_FIXED(
  state: Store,
  uiParentId: string,
  serverChildUiIds: string[]
): string[] {
  const p = state.nodes[uiParentId];
  const local = (p?.children ?? []).filter((cid) => Boolean(state.nodes[cid]));

  const serverSet = new Set(serverChildUiIds);

  const kept: string[] = [];
  for (const cid of local) {
    if (isTempId(cid)) {
      // ✅ temp 只要还在 nodes 里，就永远保留（根治：不再依赖 pendingCreate）
      kept.push(cid);
      continue;
    }
    if (serverSet.has(cid)) kept.push(cid);
  }

  for (const sid of serverChildUiIds) {
    if (!kept.includes(sid)) kept.push(sid);
  }

  return kept;
}

/* =========================
 * Store
 * ========================= */

export const useStore = create<Store>((set, get) => {
  // ✅ 只打服务端，不重复 UI 移动
  const serverIndentOnly = async (
    uiId: string,
    fromParentId: string,
    toParentId: string,
    nonce: number
  ) => {
    const st = get();
    const apiId = resolveIdForApi(st, uiId);
    if (isTempId(apiId)) return;

    try {
      await api.indentNode(apiId);
      if (get().sessionNonce !== nonce) return;
      void get().loadChildren(toParentId).catch(console.error);
      void get().loadChildren(fromParentId).catch(console.error);
    } catch (e) {
      if (!isHttp404(e)) console.error("[indent/serverOnly] failed:", safeGetErrorMessage(e));
      void get().loadChildren(fromParentId).catch(console.error);
      void get().loadChildren(toParentId).catch(console.error);
    }
  };

  const serverOutdentOnly = async (
    uiId: string,
    fromParentId: string,
    toParentId: string,
    nonce: number
  ) => {
    const st = get();
    const apiId = resolveIdForApi(st, uiId);
    if (isTempId(apiId)) return;

    try {
      await api.outdentNode(apiId);
      if (get().sessionNonce !== nonce) return;
      void get().loadChildren(fromParentId).catch(console.error);
      void get().loadChildren(toParentId).catch(console.error);
    } catch (e) {
      if (!isHttp404(e)) console.error("[outdent/serverOnly] failed:", safeGetErrorMessage(e));
      void get().loadChildren(fromParentId).catch(console.error);
      void get().loadChildren(toParentId).catch(console.error);
    }
  };

  return {
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
        tombstoneReal: {},
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
        tombstoneReal: {},
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
    tombstoneReal: {},

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
        const uiId = s.realToTemp[n.id] ?? n.id;
        const next = { ...s.nodes };
        next[uiId] = upsertFromApiToUiId(s as any, uiId, n);
        if (uiId !== n.id) next[uiId] = { ...next[uiId], serverId: n.id };
        return { nodes: next };
      }),

    ensureNodeLoaded: async (id) => {
      if (!id) return;

      const nonce = get().sessionNonce;
      const st0 = get();

      const apiId = resolveIdForApi(st0, id);
      if (isTempId(apiId)) return;

      const uiId = st0.realToTemp[apiId] ?? id;

      if (st0.nodes[uiId]?.content !== undefined) return;

      if (st0._inflightNodeFetch[apiId]) {
        await st0._inflightNodeFetch[apiId];
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
      if (isTempId(apiParentId)) return;

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
        const serverChildUiIds: string[] = [];

        for (const r of rows) {
          if (isTombstoned(s, r.id)) continue;

          const uiChildId = s.realToTemp[r.id] ?? r.id;

          next[uiChildId] = upsertFromApiToUiId(s as any, uiChildId, r);
          if (uiChildId !== r.id) {
            next[uiChildId] = { ...next[uiChildId], serverId: r.id };
          }

          serverChildUiIds.push(uiChildId);
        }

        const existingParent = next[uiParentId];

        const mergedChildren = mergeChildrenPreserveLocal_FIXED(
          { ...(s as any), nodes: next } as any,
          uiParentId,
          serverChildUiIds
        );

        next[uiParentId] = {
          id: uiParentId,
          parentId: existingParent?.parentId ?? null,
          content: existingParent?.content ?? "",
          orderIndex: existingParent?.orderIndex ?? 0,
          children: mergedChildren,
          hasChildren: mergedChildren.length > 0,
          isCollapsed: existingParent?.isCollapsed ?? false,
          serverId: existingParent?.serverId,
        };

        const reordered = recomputeOrderIndices({ ...(s as any), nodes: next } as any, uiParentId);
        return { nodes: reordered ?? next };
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

      const st1 = get();
      const n1 = st1.nodes[id];

      // temp 未落地：先不打 patch（由 create 落地后补发最后文本）
      if (isTempId(id) && !n1?.serverId) return;

      const apiId = resolveIdForApi(st1, id);
      if (isTempId(apiId)) return;

      try {
        const updated = await api.patchNode(apiId, { text: html });
        if (get().sessionNonce !== nonce) return;

        set((s) => {
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
      // 非核心交互，不动
      const nonce = get().sessionNonce;
      try {
        await api.createNode({ parent_id: resolveIdForApi(get(), parentId), text: "" });
      } catch (e) {
        console.error("[appendChild] create failed:", safeGetErrorMessage(e));
        return;
      }
      if (get().sessionNonce !== nonce) return;
      await get().loadChildren(parentId);
    },

    createAfter: async (id) => {
      const st0 = get();
      const nonce = st0.sessionNonce;

      const cur = st0.nodes[id];
      if (!cur) return;

      const parentId = cur.parentId ?? st0.homeId;
      if (!parentId) return;

      const tempId = newClientId();

      // 1) UI 立刻插入 temp（0ms）
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

        const reordered = recomputeOrderIndices({ ...(s as any), nodes: nextNodes } as any, parentId);
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
          const apiParent = resolveIdForApi(get(), parentId);
          if (isTempId(apiParent)) return;

          let created: ApiNode;

          try {
            const apiAfter = resolveIdForApi(get(), id);
            created = await api.createNode({
              parent_id: apiParent,
              text: "",
              after_id: isTempId(apiAfter) ? undefined : apiAfter,
            });
          } catch (e: any) {
            const msg = safeGetErrorMessage(e);
            if (msg.includes("after not found")) {
              created = await api.createNode({ parent_id: apiParent, text: "" });
            } else {
              throw e;
            }
          }

          if (get().sessionNonce !== nonce) return;

          const st1 = get();
          const pc = st1.pendingCreate[tempId];
          const canceled = pc?.canceled === true;
          const tempStillExists = Boolean(st1.nodes[tempId]);

          // 如果用户在 create 回来前已经删了 temp：直接删 real，并 tombstone
          if (canceled || !tempStillExists) {
            set((s) => ({
              tombstoneReal: { ...s.tombstoneReal, [created.id]: Date.now() },
            }));
            try {
              await api.deleteNode(created.id);
            } catch {
              /* ignore */
            }
            void get().loadChildren(parentId).catch(console.error);
            return;
          }

          // 绑定 realId 到 temp 节点（UI id 不变！）
          set((s) => ({
            nodes: {
              ...s.nodes,
              [tempId]: { ...s.nodes[tempId], serverId: created.id },
            },
            idRedirect: { ...s.idRedirect, [tempId]: created.id },
            realToTemp: { ...s.realToTemp, [created.id]: tempId },
            pendingCreate: {
              ...s.pendingCreate,
              [tempId]: { parentId, canceled: false, createdRealId: created.id },
            },
          }));

          get().bumpSidebar();

          // 补发最后一次输入
          const st2 = get();
          const latestHtml = st2.pendingText[tempId] ?? st2.nodes[tempId]?.content ?? "";
          if (latestHtml !== undefined) {
            try {
              await api.patchNode(created.id, { text: latestHtml });
              set((s) => {
                const nextPending = { ...s.pendingText };
                const nextRev = { ...s.pendingTextRev };
                delete nextPending[tempId];
                delete nextRev[tempId];
                return { pendingText: nextPending, pendingTextRev: nextRev };
              });
            } catch {
              /* ignore */
            }
          }

          // flush pendingOps（只 server-only）
          const op = get().pendingOps[tempId];
          if (op?.indent) {
            set((s) => {
              const next = { ...s.pendingOps };
              delete next[tempId];
              return { pendingOps: next };
            });
            void serverIndentOnly(tempId, op.indent.fromParentId, op.indent.toParentId, nonce);
          } else if (op?.outdent) {
            set((s) => {
              const next = { ...s.pendingOps };
              delete next[tempId];
              return { pendingOps: next };
            });
            void serverOutdentOnly(tempId, op.outdent.fromParentId, op.outdent.toParentId, nonce);
          } else {
            set((s) => {
              const next = { ...s.pendingOps };
              delete next[tempId];
              return { pendingOps: next };
            });
          }

          void get().loadChildren(parentId).catch(console.error);
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

      const idx = parent.children.indexOf(id);
      const fallbackFocus =
        (idx > 0 ? parent.children[idx - 1] : parent.children[idx + 1]) ?? parentId;

      const realId = resolveIdForApi(st0, id);
      const isReal = !isTempId(realId);

      if (isTempId(id)) {
        set((s) => {
          const pc = s.pendingCreate[id];
          if (!pc) return s;
          return { pendingCreate: { ...s.pendingCreate, [id]: { ...pc, canceled: true } } };
        });
      }

      if (isReal) {
        set((s) => ({ tombstoneReal: { ...s.tombstoneReal, [realId]: Date.now() } }));
      }

      set((s) => {
        const p = s.nodes[parentId];
        if (!p) return s;

        const nextNodes: Record<string, UiNode> = { ...s.nodes };
        delete nextNodes[id];

        const nextPending = { ...s.pendingText };
        delete nextPending[id];

        const nextRev = { ...s.pendingTextRev };
        delete nextRev[id];

        const nextRealToTemp = { ...s.realToTemp };
        const maybeReal = s.nodes[id]?.serverId;
        if (maybeReal) delete nextRealToTemp[maybeReal];

        nextNodes[parentId] = {
          ...p,
          children: removeFromArray(p.children, id),
          hasChildren: p.children.length - 1 > 0,
        };

        const reordered = recomputeOrderIndices(
          { ...(s as any), nodes: nextNodes } as any,
          parentId
        );

        return {
          nodes: reordered ?? nextNodes,
          pendingText: nextPending,
          pendingTextRev: nextRev,
          realToTemp: nextRealToTemp,
          focusedId: fallbackFocus,
          caretToEndId: fallbackFocus,
        };
      });

      get().bumpSidebar();

      void (async () => {
        try {
          if (!isTempId(realId)) {
            await api.deleteNode(realId);
          }
          if (get().sessionNonce !== nonce) return;
          void get().loadChildren(parentId).catch(console.error);
        } catch (e) {
          if (!isHttp404(e)) console.error("[deleteIfEmpty] delete failed:", safeGetErrorMessage(e));
          void get().loadChildren(parentId).catch(console.error);
        }
      })();
    },

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

      // UI 立即移动
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

        const s1 = recomputeOrderIndices({ ...(s as any), nodes: nextNodes } as any, oldParentId);
        const s2 = recomputeOrderIndices({ ...(s as any), nodes: s1 ?? nextNodes } as any, newParentId);

        return { nodes: s2 ?? s1 ?? nextNodes, focusedId: id };
      });

      get().bumpSidebar();

      const st1 = get();
      const apiId = resolveIdForApi(st1, id);

      if (isTempId(id) && !st1.nodes[id]?.serverId) {
        set((s) => ({
          pendingOps: {
            ...s.pendingOps,
            [id]: {
              ...(s.pendingOps[id] ?? {}),
              indent: { fromParentId: oldParentId, toParentId: newParentId },
            },
          },
        }));
        return;
      }

      if (isTempId(apiId)) return;

      void serverIndentOnly(id, oldParentId, newParentId, nonce);
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

      // UI 立即移动
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

        const s1 = recomputeOrderIndices({ ...(s as any), nodes: nextNodes } as any, parentId);
        const s2 = recomputeOrderIndices({ ...(s as any), nodes: s1 ?? nextNodes } as any, grandParentId);

        return { nodes: s2 ?? s1 ?? nextNodes, focusedId: id };
      });

      get().bumpSidebar();

      const st1 = get();
      const apiId = resolveIdForApi(st1, id);

      if (isTempId(id) && !st1.nodes[id]?.serverId) {
        set((s) => ({
          pendingOps: {
            ...s.pendingOps,
            [id]: {
              ...(s.pendingOps[id] ?? {}),
              outdent: { fromParentId: parentId, toParentId: grandParentId },
            },
          },
        }));
        return;
      }

      if (isTempId(apiId)) return;

      void serverOutdentOnly(id, parentId, grandParentId, nonce);
    },

    moveFocusUp: () => {},
    moveFocusDown: () => {},
  };
});
