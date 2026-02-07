import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "./store";
import { NodeItem } from "./components/NodeItem";
import { Home, ArrowLeft, ArrowRight, Menu } from "lucide-react";
import Sidebar from "./components/Sidebar";
import AccountMenu from "./components/AccountMenu";

function htmlToText(html: string) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

// ====== Title helpers (caret-stable) ======
function cleanupZwsp(html: string) {
  return html.replace(/\u200B/g, "");
}

function applyBold(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return;

  if (range.collapsed) {
    const strong = document.createElement("strong");
    strong.appendChild(document.createTextNode("\u200B"));
    range.insertNode(strong);

    const r = document.createRange();
    r.setStart(strong.firstChild as Text, 1);
    r.collapse(true);

    sel.removeAllRanges();
    sel.addRange(r);
    return;
  }

  const strong = document.createElement("strong");
  const frag = range.extractContents();
  strong.appendChild(frag);
  range.insertNode(strong);

  const r = document.createRange();
  r.setStartAfter(strong);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

export default function MainApp() {
  // ✅ auth (用于 init 保护)
  const userId = useStore((s) => s.userId);
  const homeId = useStore((s) => s.homeId);

  const nodes = useStore((s) => s.nodes);
  const rootId = useStore((s) => s.rootId);
  const setRootId = useStore((s) => s.setRootId);
  const getPathToRoot = useStore((s) => s.getPathToRoot);
  const appendChild = useStore((s) => s.appendChild);

  const init = useStore((s) => s.init);
  const loadChildren = useStore((s) => s.loadChildren);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const SIDEBAR_W = 290;

  // ✅✅ 关键：只在“已登录态”跑 init（logout 后不会继续跑）
  useEffect(() => {
    if (!userId || !homeId) return;
    init().catch(console.error);
  }, [init, userId, homeId]);

  useEffect(() => {
    if (!rootId) return;
    loadChildren(rootId).catch(console.error);
  }, [rootId, loadChildren]);

  // history (back/forward)
  const historyRef = useRef<string[]>([""]);
  const historyIndexRef = useRef<number>(0);

  useEffect(() => {
    if (!rootId) return;
    const hist = historyRef.current;
    const idx = historyIndexRef.current;

    if (hist.length === 1 && hist[0] === "") {
      hist[0] = rootId;
      historyIndexRef.current = 0;
      return;
    }

    if (hist[idx] === rootId) return;

    hist.splice(idx + 1);
    hist.push(rootId);
    historyIndexRef.current = hist.length - 1;
  }, [rootId]);

  const canBack = historyIndexRef.current > 0;
  const canForward = historyIndexRef.current < historyRef.current.length - 1;

  const goBack = () => {
    if (!canBack) return;
    historyIndexRef.current -= 1;
    setRootId(historyRef.current[historyIndexRef.current]);
  };

  const goForward = () => {
    if (!canForward) return;
    historyIndexRef.current += 1;
    setRootId(historyRef.current[historyIndexRef.current]);
  };

  const breadcrumbIds = useMemo(() => {
    if (!rootId) return [];
    return getPathToRoot(rootId);
  }, [getPathToRoot, rootId]);

  const isHome = !!homeId && rootId === homeId;
  const rootNode = rootId ? nodes[rootId] : undefined;
  const children = rootNode?.children ?? [];

  const grayLight = "#D1D5DB";
  const gray = "#9CA3AF";
  const black = "#111827";

  const navBarH = 56;
  const ICON = 22;

  // ✅ 让正文让位
  const leftPad = sidebarOpen ? SIDEBAR_W : 0;

  // ✅✅ 关键：让顶部导航栏也让位（否则会被 fixed sidebar 盖住）
  const navLeftPad = sidebarOpen ? SIDEBAR_W : 0;

  return (
    <div className="h-screen w-screen overflow-hidden bg-white text-gray-900 font-sans">
      {/* ✅ Sidebar fixed (不占文档流) */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          height: "100vh",
          width: sidebarOpen ? SIDEBAR_W : 0,
          overflow: "hidden",
          transition: "width 260ms ease",
          zIndex: 30,
        }}
      >
        <div style={{ width: SIDEBAR_W, height: "100%" }}>
          <Sidebar onSelect={(id) => setRootId(id)} onClose={() => setSidebarOpen(false)} />
        </div>
      </div>

      {/* ✅✅ 分割线：fixed（永远从顶到底，不会被 sticky header 遮住） */}
      {sidebarOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: SIDEBAR_W - 1,
            width: 1,
            height: "100vh",
            background: "rgba(0,0,0,0.10)",
            pointerEvents: "none",
            zIndex: 1000,
          }}
        />
      )}

      {/* ✅ Main scroll area */}
      <main className="h-screen overflow-y-auto">
        {/* ✅ Sticky NavBar */}
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 25,
            height: navBarH,
            background: "white",
            borderBottom: "1px solid rgba(0,0,0,0.08)",
          }}
        >
          {/* ✅✅ 关键：nav 内容整体平移（paddingLeft） */}
          <div
            style={{
              height: navBarH,
              display: "flex",
              alignItems: "center",
              gap: 14,
              color: gray,
              userSelect: "none",
              paddingLeft: 14 + navLeftPad,
              paddingRight: 14,
              transition: "padding-left 260ms ease",
            }}
          >
            {/* hamburger：sidebar 收起时显示（浅灰） */}
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                aria-label="Open sidebar"
                title="Open sidebar"
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >
                <Menu size={ICON} color={grayLight} />
              </button>
            )}

            {/* Back / Forward / Home */}
            <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
              <button
                onClick={goBack}
                disabled={!canBack}
                aria-label="Back"
                title="Back"
                style={{
                  opacity: canBack ? 1 : 0.35,
                  cursor: canBack ? "pointer" : "default",
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onMouseEnter={(e) => {
                  if (!canBack) return;
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >
                <ArrowLeft size={ICON} color={grayLight} />
              </button>

              <button
                onClick={goForward}
                disabled={!canForward}
                aria-label="Forward"
                title="Forward"
                style={{
                  opacity: canForward ? 1 : 0.35,
                  cursor: canForward ? "pointer" : "default",
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onMouseEnter={(e) => {
                  if (!canForward) return;
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >
                <ArrowRight size={ICON} color={grayLight} />
              </button>

              <button
                onClick={() => homeId && setRootId(homeId)}
                disabled={!homeId}
                aria-label="Home"
                title="Home"
                style={{
                  opacity: homeId ? 1 : 0.35,
                  cursor: homeId ? "pointer" : "default",
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                onMouseEnter={(e) => {
                  if (!homeId) return;
                  (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                }}
              >
                <Home size={ICON} color={grayLight} />
              </button>
            </div>

            {/* Breadcrumbs */}
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                minWidth: 0,
                flexWrap: "nowrap",
                overflow: "hidden",
                flex: 1,
              }}
            >
              {breadcrumbIds.map((nodeId) => {
                const isActive = nodeId === rootId;
                if (homeId && nodeId === homeId) return null;

                const label = htmlToText(nodes[nodeId]?.content || "Untitled");

                return (
                  <span
                    key={nodeId}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      minWidth: 0,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span style={{ margin: "0 12px", color: grayLight }}>{">"}</span>
                    <button
                      onClick={() => setRootId(nodeId)}
                      title={label}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        minWidth: 0,
                        color: isActive ? black : gray,
                        fontWeight: isActive ? 700 : 400,
                        cursor: "pointer",
                      }}
                    >
                      <span
                        style={{
                          maxWidth: 520,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {label}
                      </span>
                    </button>
                  </span>
                );
              })}
            </div>

            {/* ✅ Right side: Account menu */}
            <AccountMenu
              onLogout={() => {
                historyRef.current = [""];
                historyIndexRef.current = 0;
                setSidebarOpen(true);
              }}
            />
          </div>
        </div>

        {/* ✅ Content：只在这里让位给 sidebar */}
        <div style={{ paddingLeft: leftPad, transition: "padding-left 260ms ease" }}>
          <div className="min-h-screen bg-white text-gray-900 font-sans">
            <div className="mx-auto px-10" style={{ maxWidth: 1200, paddingTop: 28 }}>
              {!isHome && rootId && (
                <div style={{ marginTop: 70, marginBottom: 40 }}>
                  <EditableTitle nodeId={rootId} />
                </div>
              )}

              <div style={{ marginTop: isHome ? 120 : 0, display: "flex", justifyContent: "center" }}>
                <div style={{ width: 720 }}>
                  {children.map((childId) => (
                    <NodeItem key={childId} id={childId} level={0} />
                  ))}

                  <div style={{ marginTop: children.length ? 18 : 0, paddingLeft: 0 }}>
                    <button
                      onClick={() => {
                        if (!rootId) return;
                        void appendChild(rootId).catch(console.error);
                      }}
                      title="Add"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 28,
                        height: 28,
                        color: "#9CA3AF",
                        cursor: "pointer",
                        fontSize: 28,
                        lineHeight: "28px",
                      }}
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ height: 80 }} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function EditableTitle({ nodeId }: { nodeId: string }) {
  const nodes = useStore((s) => s.nodes);
  const updateContent = useStore((s) => s.updateContent);

  const focusedId = useStore((s) => s.focusedId);
  const setFocusedId = useStore((s) => s.setFocusedId);

  const ref = useRef<HTMLDivElement | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const lastCommittedRef = useRef<string>("");
  const composingRef = useRef(false);

  const node = nodes[nodeId];
  if (!node) return null;

  const isFocused = focusedId === nodeId;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const html = node.content || "";
    if (!isFocused) {
      if (el.innerHTML !== html) el.innerHTML = html;
      lastCommittedRef.current = html;
    }
  }, [node.content, isFocused]);

  useEffect(() => {
    if (!isFocused) return;
    ref.current?.focus();
  }, [isFocused]);

  const flushToStore = () => {
    const el = ref.current;
    if (!el) return;
    const html = cleanupZwsp(el.innerHTML);
    if (html !== lastCommittedRef.current) {
      lastCommittedRef.current = html;
      // ✅ 防止 Uncaught promise
      void updateContent(nodeId, html).catch(console.error);
    }
  };

  const scheduleFlush = () => {
    if (pendingTimerRef.current) window.clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = window.setTimeout(() => {
      pendingTimerRef.current = null;
      if (composingRef.current) return;
      flushToStore();
    }, 120);
  };

  const clearPending = () => {
    if (pendingTimerRef.current) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  };

  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <div style={{ width: 720 }}>
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          className="bp-title-editor"
          style={{ textAlign: "left" }}
          onFocus={() => setFocusedId(nodeId)}
          onBlur={() => {
            clearPending();
            flushToStore();
            // ✅ 用 isFocused，避免 stale focusedId
            if (isFocused) setFocusedId(null);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            flushToStore();
          }}
          onInput={() => scheduleFlush()}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
              e.preventDefault();
              const el = ref.current;
              if (!el) return;
              applyBold(el);
              scheduleFlush();
            }
          }}
        />
      </div>
    </div>
  );
}
