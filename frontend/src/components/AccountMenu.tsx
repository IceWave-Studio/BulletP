import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

export default function AccountMenu(props: {
  onLogout?: () => void;
}) {
  const email = useStore((s) => s.email);
  const clearAuth = useStore((s) => s.clearAuth);

  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const grayLight = "#D1D5DB";
  const gray = "#9CA3AF";
  const black = "#111827";

  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };

    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const doLogout = () => {
    setOpen(false);
    clearAuth();
    props.onLogout?.();
  };

  return (
    <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        ref={btnRef}
        aria-label="Account menu"
        title="Menu"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          background: "transparent",
        }}
        onMouseEnter={(e) => {
          if (open) return;
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
        }}
      >
        <span style={{ fontSize: 22, lineHeight: "22px", color: grayLight }}>⋮</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          style={{
            position: "absolute",
            top: 46,
            right: 0,
            width: 240,
            background: "white",
            border: "1px solid rgba(0,0,0,0.10)",
            borderRadius: 14,
            boxShadow: "0 18px 40px rgba(0,0,0,0.10)",
            padding: 8,
            zIndex: 9999,
          }}
        >
          <button
            onClick={doLogout}
            style={{
              width: "100%",
              height: 40,
              borderRadius: 12,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "0 10px",
              cursor: "pointer",
              color: black,
              fontWeight: 600,
              background: "transparent",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.06)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
          >
            <span style={{ fontSize: 16, color: gray }}>↪</span>
            <span>Log out</span>
          </button>

          <div
            style={{
              height: 1,
              background: "rgba(0,0,0,0.06)",
              margin: "8px 6px",
            }}
          />

          <div
            style={{
              padding: "4px 10px 8px 10px",
              color: gray,
              fontSize: 12,
              lineHeight: 1.4,
              userSelect: "text",
            }}
            title={email ?? ""}
          >
            {email ? email : "Not signed in"}
          </div>
        </div>
      )}
    </div>
  );
}
