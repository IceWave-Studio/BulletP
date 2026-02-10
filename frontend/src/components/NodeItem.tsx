// src/components/NodeItem.tsx
import { useEffect, useRef } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useStore } from "../store";

function cleanupZwsp(html: string) {
  return html.replace(/\u200B/g, "");
}

function moveCaretToEnd(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
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

export const NodeItem = ({ id, level = 0 }: { id: string; level?: number }) => {
  const node = useStore((s) => s.nodes[id]);

  const toggleCollapse = useStore((s) => s.toggleCollapse);
  const updateContent = useStore((s) => s.updateContent);
  const setRootId = useStore((s) => s.setRootId);

  const focusedId = useStore((s) => s.focusedId);
  const setFocusedId = useStore((s) => s.setFocusedId);

  const caretToEndId = useStore((s) => s.caretToEndId);
  const setCaretToEndId = useStore((s) => s.setCaretToEndId);

  const createAfter = useStore((s) => s.createAfter);
  const deleteIfEmpty = useStore((s) => s.deleteIfEmpty);
  const indent = useStore((s) => s.indent);
  const outdent = useStore((s) => s.outdent);
  const moveFocusUp = useStore((s) => s.moveFocusUp);
  const moveFocusDown = useStore((s) => s.moveFocusDown);

  const editorRef = useRef<HTMLDivElement | null>(null);

  const pendingTimerRef = useRef<number | null>(null);
  const lastCommittedRef = useRef<string>("");
  const composingRef = useRef(false);

  // ✅ NEW: DOM 最新快照（只在 onInput 后更新，保证是“已经写入 DOM 的最终值”）
  const latestDomHtmlRef = useRef<string>("");

  const isFocused = focusedId === id;
  const hasChildren =
    ((node?.hasChildren ?? false) || (node?.children?.length ?? 0) > 0) && !!node;

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;

    const html = node?.content ?? "";

    if (!isFocused) {
      if (el.innerHTML !== html) el.innerHTML = html;
      lastCommittedRef.current = html;
      latestDomHtmlRef.current = cleanupZwsp(el.innerHTML);
      return;
    }

    const domEmpty =
      el.innerHTML === "" ||
      el.innerHTML === "<br>" ||
      cleanupZwsp(el.innerHTML).trim() === "";

    if (domEmpty && cleanupZwsp(html).trim() !== "") {
      el.innerHTML = html;
      lastCommittedRef.current = html;
      latestDomHtmlRef.current = cleanupZwsp(el.innerHTML);

      requestAnimationFrame(() => moveCaretToEnd(el));
    }
  }, [node?.content, isFocused]);

  useEffect(() => {
    if (!isFocused) return;
    editorRef.current?.focus();
  }, [isFocused]);

  useEffect(() => {
    if (!isFocused) return;
    if (caretToEndId !== id) return;
    const el = editorRef.current;
    if (!el) return;

    requestAnimationFrame(() => {
      moveCaretToEnd(el);
      setCaretToEndId(null);
    });
  }, [isFocused, caretToEndId, id, setCaretToEndId]);

  const clearPending = () => {
    if (pendingTimerRef.current) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  };

  // ✅ 强制把“最新 DOM 快照”提交到 store（解决丢字/冒字核心）
  const flushToStore = () => {
    const el = editorRef.current;
    if (!el) return;

    // 优先使用 latestDomHtmlRef（只在 input 后更新，保证是“最新真实 DOM 值”）
    // 如果它为空（例如首次 focus），退回读 innerHTML
    const html = latestDomHtmlRef.current || cleanupZwsp(el.innerHTML);

    if (html !== lastCommittedRef.current) {
      lastCommittedRef.current = html;
      void updateContent(id, html).catch(console.error);
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

  if (!node) return null;

  const bulletCollapsed = hasChildren && !!node.isCollapsed;

  return (
    <div className="flex flex-col">
      <div
        className="bp-row"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingLeft: level * 28,
          margin: "6px 0",
        }}
      >
        <div
          style={{
            width: 18,
            height: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#D1D5DB",
            cursor: hasChildren ? "pointer" : "default",
            flex: "0 0 auto",
          }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => hasChildren && toggleCollapse(id)}
        >
          {hasChildren ? (
            node.isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />
          ) : (
            <span style={{ display: "inline-block", width: 16 }} />
          )}
        </div>

        <div
          className={`bp-bullet-wrap ${bulletCollapsed ? "bp-bullet-collapsed" : ""}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            setRootId(id);
          }}
          title="Zoom In"
        >
          <svg width="12" height="12" viewBox="0 0 8 8" className="bp-bullet-dot" aria-hidden="true">
            <circle cx="4" cy="4" r="3" />
          </svg>
        </div>

        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            className="bp-editor"
            style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
            onFocus={() => setFocusedId(id)}
            onBlur={() => {
              clearPending();
              flushToStore();
              if (isFocused) setFocusedId(null);
            }}
            onCompositionStart={() => (composingRef.current = true)}
            onCompositionEnd={() => {
              composingRef.current = false;
              // ✅ composition 结束时 DOM 才稳定，把最新快照更新到 ref 再 flush
              const el = editorRef.current;
              if (el) latestDomHtmlRef.current = cleanupZwsp(el.innerHTML);
              flushToStore();
            }}
            onInput={() => {
              // ✅ input 发生时 DOM 已经更新，把“真实最新”写进 ref
              const el = editorRef.current;
              if (el) latestDomHtmlRef.current = cleanupZwsp(el.innerHTML);
              scheduleFlush();
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
                e.preventDefault();
                const el = editorRef.current;
                if (!el) return;
                applyBold(el);
                // bold 会改 DOM，更新 ref 再 flush
                latestDomHtmlRef.current = cleanupZwsp(el.innerHTML);
                scheduleFlush();
                return;
              }

              if (e.key === "Enter") {
                const ime = composingRef.current || Boolean((e.nativeEvent as any)?.isComposing);
                if (ime) return;

                e.preventDefault();
                clearPending();

                // ✅ 关键：Enter 前先提交“最新快照”
                flushToStore();

                void createAfter(id).catch(console.error);
                return;
              }

              if (e.key === "Backspace") {
                const ime = composingRef.current || Boolean((e.nativeEvent as any)?.isComposing);
                if (ime) return;

                const el = editorRef.current;
                const plain = (el?.innerText || "").replace(/\u200B/g, "").trim();
                if (plain.length === 0) {
                  e.preventDefault();
                  clearPending();

                  // ✅ 关键：Delete 前也先提交“最新快照”（避免删空后冒字）
                  flushToStore();

                  void deleteIfEmpty(id).catch(console.error);
                  return;
                }
              }

              if (e.key === "Tab") {
                e.preventDefault();
                clearPending();

                // ✅ 关键：缩进/反缩进前先提交“最新快照”
                flushToStore();

                void (e.shiftKey ? outdent(id) : indent(id)).catch(console.error);
                return;
              }

              if (e.key === "ArrowUp") {
                e.preventDefault();
                moveFocusUp();
                return;
              }

              if (e.key === "ArrowDown") {
                e.preventDefault();
                moveFocusDown();
                return;
              }
            }}
          />
        </div>
      </div>

      {!node.isCollapsed && hasChildren && (
        <div>
          {node.children.map((cid) => (
            <NodeItem key={cid} id={cid} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
};
