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

  // ✅ temp 节点落地后写入 serverId（UI id 永不更换）
  serverId?: string;
};

const AUTH_KEY = "bulletp_auth_v1";

/* =========================
 * Store shape
 * ========================= */

type TempPlacement =
  | { mode: "after"; afterId: string }
  | { mode: "end" };

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

  updateContent: (id: string, html: string) => Promise<void>;

  pendingCreate: Record<
    string,
    { parentId: string; canceled: boolean; createdRealId: string | null } | undefined
  >;

  realToTemp: Record<string, string | undefined>;
  tombstoneReal: Record<string, number | undefined>;
  tempPlacement: Record<string, TempPlacement | undefined>;

  pendingOps: Record<
    string,
    | {
        indent?: { fromParentId: string; toParentId: string };
        outdent?: { fromParentId: string; toParentId: string };
      }
    | undefined
  >;

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

function normalizeHtmlEmpty(html: string) {
  const t = html.replace(/\u200B/g, "").trim();
  return t === "" || t === "<br>";
}

/**
 * ✅✅✅ 关键修复：临时 ID 必须永远带 tmp_ 前缀
 * 否则会被当成真实节点 ID 打到后端 → node not found 404（你现在遇到的就是这个）
 */
function newClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `tmp_${(crypto as any).randomUUID()}`;
  }
  return `tmp_${Math.random().toString(16).slice(2)}_${Date.now()}`;
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

function isTombstoned(state: Store, realId: string) {
  const t = state.tombstoneReal[realId];
  if (!t) return false;
  return Date.now() - t < 60_000;
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
      serverId: updated.id,
    };
  }
  return {
    ...existing,
    content: updated.text ?? existing.content,
  };
}

function resolveIdForApi(st: Store, uiId: string): string {
  if (!isTempId(uiId)) return uiId;
  const n = st.nodes[uiId];
  return n?.serverId ?? uiId;
}

function mergeChildrenServerFirst(state: Store, parentId: string, serverUiIds: string[]) {
  const base = serverUiIds.slice();

  const parent = state.nodes[parentId];
  if (!parent) return base;

  const localTemp = (parent.children ?? []).filter((cid) => {
    if (!isTempId(cid)) return false;
    const cn = state.nodes[cid];
    return Boolean(cn) && cn.parentId === parentId;
  });

  for (const tid of localTemp) {
    if (base.includes(tid)) continue;

    const placement = state.tempPlacement[tid];

    if (placement?.mode === "after") {
      const anchor = placement.afterId;
      const idx = base.indexOf(anchor);
      if (idx >= 0) base.splice(idx + 1, 0, tid);
      else base.push(tid);
      continue;
    }

    base.push(tid);
  }

  return base;
}

/* =========================
 * Server-only ops (temp 落地后补打)
 * ========================= */

async function serverIndentOnly(
  uiId: string,
  fromParentId: string,
  toParentId: string,
  nonce: number
) {
  const st = useStore.getState();
  const apiId = resolveIdForApi(st as any, uiId);
  if (isTempId(apiId)) return;

  try {
    await api.indentNode(apiId);
    if (useStore.getState().sessionNonce !== nonce) return;
    void useStore.getState().loadChildren(toParentId).catch(console.error);
    void useStore.getState().loadChildren(fromParentId).catch(console.error);
  } catch (e) {
    console.error("[indent] failed:", safeGetErrorMessage(e));
    void useStore.getState().loadChildren(fromParentId).catch(console.error);
    void useStore.getState().loadChildren(toParentId).catch(console.error);
  }
}

async function serverOutdentOnly(
  uiId: string,
  fromParentId: string,
  toParentId: string,
  nonce: number
) {
  const st = useStore.getState();
  const apiId = resolveIdForApi(st as any, uiId);
  if (isTempId(apiId)) return;

  try {
    await api.outdentNode(apiId);
    if (useStore.getState().sessionNonce !== nonce) return;
    void useStore.getState().loadChildren(fromParentId).catch(console.error);
    void useStore.getState().loadChildren(toParentId).catch(console.error);
  } catch (e) {
    console.error("[outdent] failed:", safeGetErrorMessage(e));
    void useStore.getState().loadChildren(fromParentId).catch(console.error);
    void useStore.getState().loadChildren(toParentId).catch(console.error);
  }
}

/* =========================
 * Store
 * ========================= */

export const useStore = create<Store>((set, get) => ({
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
      pendingCreate: {},
      realToTemp: {},
      tombstoneReal: {},
      tempPlacement: {},
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
      pendingCreate: {},
      realToTemp: {},
      tombstoneReal: {},
      tempPlacement: {},
      pendingOps: {},
      rootId: "",
      focusedId: null,
      caretToEndId: null,
      _inflightNodeFetch: {},
      sidebarVersion: 0,
      sessionNonce: s.sessionNonce + 1,
    }));
  },

  nodes: {},
  pendingText: {},
  pendingTextRev: {},

  pendingCreate: {},
  realToTemp: {},
  tombstoneReal: {},
  tempPlacement: {},
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
        serverId: home.id,
      };
      return { nodes: next, homeId: home.id, rootId: home.id };
    });

    await get().loadChildren(home.id);
  },

  hydrateNode: (n) =>
    set((s) => {
      const uiId = s.realToTemp[n.id] ?? n.id;
      const nextNode = upsertFromApiToUiId(s as any, uiId, n);
      return { nodes: { ...s.nodes, [uiId]: { ...nextNode, serverId: n.id } } };
    }),

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
        const apiId = resolveIdForApi(get(), id);
        if (isTempId(apiId)) return;

        const n = await api.getNode(apiId);
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
    const st0 = get();

    const apiParent = resolveIdForApi(st0 as any, parentId);
    if (isTempId(apiParent)) return;

    let rows: ApiNode[];
    try {
      rows = await api.getChildren(apiParent);
    } catch (e) {
      if (isHttp404(e)) {
        console.warn("[loadChildren] parent not found:", apiParent);

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
      const serverChildUiIds: string[] = [];

      for (const r of rows) {
        if (isTombstoned(s as any, r.id)) continue;

        const uiChildId = s.realToTemp[r.id] ?? r.id;

        next[uiChildId] = upsertFromApiToUiId(s as any, uiChildId, r);
        next[uiChildId] = { ...next[uiChildId], serverId: r.id };

        serverChildUiIds.push(uiChildId);
      }

      const existingParent = next[parentId];

      const mergedChildren = mergeChildrenServerFirst(
        { ...(s as any), nodes: next } as any,
        parentId,
        serverChildUiIds
      );

      next[parentId] = {
        id: parentId,
        parentId: existingParent?.parentId ?? null,
        content: existingParent?.content ?? "",
        orderIndex: existingParent?.orderIndex ?? 0,
        children: mergedChildren,
        hasChildren: mergedChildren.length > 0,
        isCollapsed: existingParent?.isCollapsed ?? false,
        serverId: existingParent?.serverId ?? apiParent,
      };

      const reordered = recomputeOrderIndices({ ...(s as any), nodes: next } as any, parentId);
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

    if (isTempId(id) && !n1?.serverId) return;

    const apiId = resolveIdForApi(st1 as any, id);
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
    const st0 = get();
    const nonce = st0.sessionNonce;

    if (!parentId) return;

    const p = st0.nodes[parentId];
    if (!p) return;

    const tempId = newClientId();

    set((s) => {
      const parent = s.nodes[parentId];
      if (!parent) return s;

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
        ...parent,
        children: [...parent.children, tempId],
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
        tempPlacement: { ...s.tempPlacement, [tempId]: { mode: "end" } },
        focusedId: tempId,
        caretToEndId: tempId,
      };
    });

    get().bumpSidebar();

    void (async () => {
      try {
        const apiParent = resolveIdForApi(get() as any, parentId);
        if (isTempId(apiParent)) return;

        const created = await api.createNode({ parent_id: apiParent, text: "" });
        if (get().sessionNonce !== nonce) return;

        const st1 = get();
        const pc = st1.pendingCreate[tempId];
        const canceled = pc?.canceled === true;
        const tempStillExists = Boolean(st1.nodes[tempId]);

        if (canceled || !tempStillExists) {
          set((s) => ({
            tombstoneReal: { ...s.tombstoneReal, [created.id]: Date.now() },
          }));
          try {
            await api.deleteNode(created.id);
          } catch {}
          void get().loadChildren(parentId).catch(console.error);
          return;
        }

        set((s) => ({
          nodes: {
            ...s.nodes,
            [tempId]: { ...s.nodes[tempId], serverId: created.id },
          },
          realToTemp: { ...s.realToTemp, [created.id]: tempId },
          pendingCreate: {
            ...s.pendingCreate,
            [tempId]: { parentId, canceled: false, createdRealId: created.id },
          },
        }));

        get().bumpSidebar();

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
          } catch {}
        }

        void get().loadChildren(parentId).catch(console.error);
      } catch (e) {
        console.error("[appendChild] create failed:", safeGetErrorMessage(e));
        void get().loadChildren(parentId).catch(console.error);
      }
    })();
  },

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
        tempPlacement: { ...s.tempPlacement, [tempId]: { mode: "after", afterId: id } },
        focusedId: tempId,
        caretToEndId: tempId,
      };
    });

    get().bumpSidebar();

    void (async () => {
      try {
        const apiParent = resolveIdForApi(get() as any, parentId);
        if (isTempId(apiParent)) return;

        let created: ApiNode;
        try {
          const apiAfter = resolveIdForApi(get() as any, id);
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

        if (canceled || !tempStillExists) {
          set((s) => ({
            tombstoneReal: { ...s.tombstoneReal, [created.id]: Date.now() },
          }));
          try {
            await api.deleteNode(created.id);
          } catch {}
          void get().loadChildren(parentId).catch(console.error);
          return;
        }

        set((s) => ({
          nodes: {
            ...s.nodes,
            [tempId]: { ...s.nodes[tempId], serverId: created.id },
          },
          realToTemp: { ...s.realToTemp, [created.id]: tempId },
          pendingCreate: {
            ...s.pendingCreate,
            [tempId]: { parentId, canceled: false, createdRealId: created.id },
          },
        }));

        get().bumpSidebar();

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
          } catch {}
        }

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

    if (isTempId(id)) {
      set((s) => {
        const pc = s.pendingCreate[id];
        if (!pc) return s;
        return { pendingCreate: { ...s.pendingCreate, [id]: { ...pc, canceled: true } } };
      });
    }

    const realId = resolveIdForApi(st0 as any, id);
    if (!isTempId(realId)) {
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

      const nextPlacement = { ...s.tempPlacement };
      delete nextPlacement[id];

      nextNodes[parentId] = {
        ...p,
        children: removeFromArray(p.children, id),
        hasChildren: p.children.length - 1 > 0,
      };

      const reordered = recomputeOrderIndices({ ...(s as any), nodes: nextNodes } as any, parentId);

      return {
        nodes: reordered ?? nextNodes,
        pendingText: nextPending,
        pendingTextRev: nextRev,
        tempPlacement: nextPlacement,
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

      const nextPlacement = { ...s.tempPlacement };
      if (isTempId(id)) nextPlacement[id] = { mode: "end" };

      const s1 = recomputeOrderIndices({ ...(s as any), nodes: nextNodes } as any, oldParentId);
      const s2 = recomputeOrderIndices({ ...(s as any), nodes: s1 ?? nextNodes } as any, newParentId);

      return {
        nodes: s2 ?? s1 ?? nextNodes,
        tempPlacement: nextPlacement,
        focusedId: id,
      };
    });

    get().bumpSidebar();

    const st1 = get();
    const apiId = resolveIdForApi(st1 as any, id);

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

      const nextPlacement = { ...s.tempPlacement };
      if (isTempId(id)) nextPlacement[id] = { mode: "after", afterId };

      const s1 = recomputeOrderIndices({ ...(s as any), nodes: nextNodes } as any, parentId);
      const s2 = recomputeOrderIndices({ ...(s as any), nodes: s1 ?? nextNodes } as any, grandParentId);

      return {
        nodes: s2 ?? s1 ?? nextNodes,
        tempPlacement: nextPlacement,
        focusedId: id,
      };
    });

    get().bumpSidebar();

    const st1 = get();
    const apiId = resolveIdForApi(st1 as any, id);

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
}));
