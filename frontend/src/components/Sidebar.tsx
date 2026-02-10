import { useMemo } from "react";
import { ChevronDown, ChevronRight, ChevronLeft } from "lucide-react";
import { useStore } from "../store";

const PRIMARY_TEXT = "#111827";
const SIDEBAR_TEXT = "#111827";
const SIDEBAR_MUTED = "#9CA3AF";

const NAVBAR_H = 56;
const ICON = 22;
const grayLight = "#D1D5DB";

type Props = {
  onSelect: (id: string) => void;
  onClose?: () => void;
};

type FlatRow = {
  id: string;
  parentId: string | null;
  text: string;
  level: number;
  hasChildren: boolean;
  isCollapsed: boolean;
};

function clampDepth(level: number) {
  return Math.min(Math.max(level, 0), 4);
}

function htmlToText(html: string) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

function buildRowsFromStore(nodes: Record<string, any>, homeId: string, maxLevel = 4): FlatRow[] {
  const out: FlatRow[] = [];
  const home = nodes[homeId];
  if (!home) return out;

  const walk = (id: string, level: number) => {
    const n = nodes[id];
    if (!n) return;

    const lv = clampDepth(level);
    if (lv > maxLevel) return;

    const loadedKids = Array.isArray(n.children) ? n.children : [];
    const hintHasKids = n.hasChildren === true;
    const hasChildren = hintHasKids || loadedKids.length > 0;

    const isCollapsed = n.isCollapsed === true;

    out.push({
      id: n.id,
      parentId: n.parentId ?? null,
      text: n.content ?? "",
      level: lv,
      hasChildren,
      isCollapsed,
    });

    if (!hasChildren) return;
    if (isCollapsed) return;
    if (lv >= maxLevel) return;

    for (const cid of loadedKids) walk(cid, lv + 1);
  };

  const top = Array.isArray(home.children) ? home.children : [];
  for (const cid of top) walk(cid, 0);

  return out;
}

export default function Sidebar({ onSelect, onClose }: Props) {
  // ✅ 不订阅 nodes，避免每次输入都刷新 sidebar
  const homeId = useStore((s) => s.homeId);
  const rootId = useStore((s) => s.rootId);
  const toggleCollapse = useStore((s) => s.toggleCollapse);

  // ✅ 关键：用 sidebarVersion 作为 sidebar 的“刷新信号”
  const sidebarVersion = useStore((s) => s.sidebarVersion);

  const rows = useMemo(() => {
    if (!homeId) return [];
    const nodes = useStore.getState().nodes;
    return buildRowsFromStore(nodes, homeId, 4);
  }, [homeId, sidebarVersion]);

  const sidebarBg = "#f3f2f2ff";

  return (
    <aside
      style={{
        width: 290,
        height: "100vh",
        background: sidebarBg,
        borderRight: "1px solid rgba(0,0,0,0.08)",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          height: NAVBAR_H,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 14px",
          background: sidebarBg,
          color: PRIMARY_TEXT,
          fontWeight: 700,
          fontSize: 22,
          letterSpacing: 0.2,
        }}
      >
        <div style={{ lineHeight: 1 }}>BulletP</div>

        <button
          onClick={() => onClose?.()}
          aria-label="Close sidebar"
          title="Close sidebar"
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
          <ChevronLeft size={ICON} color={grayLight} />
        </button>
      </div>

      <div style={{ padding: "10px 8px" }}>
        {!homeId && (
          <div style={{ padding: "10px 10px", color: SIDEBAR_MUTED, fontSize: 13 }}>Loading...</div>
        )}

        {homeId && rows.length === 0 && (
          <div style={{ padding: "10px 10px", color: SIDEBAR_MUTED, fontSize: 13 }}>
            No items under Home
          </div>
        )}

        {rows.map((r) => {
          const showArrow = r.hasChildren;
          const isActive = r.id === rootId;
          const collapsedWithKids = r.hasChildren && r.isCollapsed;

          return (
            <div
              key={r.id}
              className={[
                "bp-row",
                "flex items-center gap-2",
                "px-2 py-[6px]",
                "rounded-lg",
                "select-none",
                collapsedWithKids ? "bg-[rgba(243,244,246,0.10)]" : "bg-transparent",
                "hover:bg-[rgba(243,244,246,0.16)]",
              ].join(" ")}
              style={{
                paddingLeft: 8 + r.level * 18,
                cursor: "default",
              }}
            >
              <button
                style={{
                  width: 18,
                  height: 18,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  opacity: showArrow ? 1 : 0,
                  cursor: showArrow ? "pointer" : "default",
                  flex: "0 0 auto",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!showArrow) return;
                  toggleCollapse(r.id);
                }}
                aria-label={showArrow ? "toggle" : "no children"}
              >
                {showArrow ? (r.isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />) : null}
              </button>

              {/* ✅ 去掉 bullet：留一个很小的 spacer，让文字不要贴着箭头 */}
              <span style={{ width: 4, flex: "0 0 auto" }} />

              <button
                onClick={() => {
                  onSelect(r.id);
                  // onClose?.();
                }}
                title={r.text}
                style={{
                  flex: "1 1 auto",
                  minWidth: 0,
                  textAlign: "left",
                  color: isActive ? PRIMARY_TEXT : SIDEBAR_TEXT,
                  fontWeight: isActive ? 600 : 400,
                  cursor: "pointer",
                  padding: "2px 4px",
                }}
              >
                <span
                  style={{
                    display: "block",
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    textOverflow: "ellipsis",
                    fontSize: 14,
                  }}
                >
                  {htmlToText(r.text || "Untitled")}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
