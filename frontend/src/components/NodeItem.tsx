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
  const rafFlushRef = useRef<number | null>(null);

  const lastCommittedRef = useRef<string>("");
  const composingRef = useRef(false);

  const isFocused = focusedId === id;
  const isTemp = id.startsWith("tmp_");

  const hasChildren =
    ((node?.hasChildren ?? false) || (node?.children?.length ?? 0) > 0) && !!node;

  const clearPending = () => {
    if (pendingTimerRef.current) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    if (rafFlushRef.current) {
      cancelAnimationFrame(rafFlushRef.current);
      rafFlushRef.current = null;
    }
  };

  useEffect(() => {
    return () => clearPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * ✅ DOM 同步策略（关键）：
   * - 非聚焦：DOM 必须跟 store 对齐（否则 loadChildren / server 校准会出现“闪一下/重复节点/焦点丢”）
   * - 聚焦：不回写 DOM（避免“输入被回写打断/内容消失”）
   */
  useEffect(() => {
    const el = editorRef.current;
    if (!el || !node) return;

    const html = node.content ?? "";

    if (!isFocused) {
      if (el.innerHTML !== html) el.innerHTML = html;
      lastCommittedRef.current = html;
      return;
    }

    // 聚焦时：只在 DOM 为空且 store 有内容时回灌一次（防止重挂载空白）
    const domEmpty =
      el.innerHTML === "" ||
      el.innerHTML === "<br>" ||
      cleanupZwsp(el.innerHTML).trim() === "";

    if (domEmpty && cleanupZwsp(html).trim() !== "") {
      el.innerHTML = html;
      lastCommittedRef.current = html;
      requestAnimationFrame(() => moveCaretToEnd(el));
    }
  }, [node?.content, isFocused, id]);

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

  const flushToStore = () => {
    const el = editorRef.current;
    if (!el) return;

    const html = cleanupZwsp(el.innerHTML);
    if (html !== lastCommittedRef.current) {
      lastCommittedRef.current = html;
      void updateContent(id, html);
    }
  };

  const scheduleFlush = () => {
    // temp：用 rAF 合并 flush（避免每键 setState 抖动），但又不会丢字
    if (isTemp) {
      if (rafFlushRef.current) return;
      rafFlushRef.current = requestAnimationFrame(() => {
        rafFlushRef.current = null;
        if (composingRef.current) return;
        flushToStore();
      });
      return;
    }

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
              flushToStore();
            }}
            onInput={scheduleFlush}
            onKeyDown={(e) => {
              const ime = composingRef.current || Boolean((e.nativeEvent as any)?.isComposing);

              if (e.key === "Enter") {
                if (ime) return;
                e.preventDefault();
                clearPending();
                flushToStore();
                void createAfter(id);
                return;
              }

              if (e.key === "Backspace") {
                if (ime) return;
                const el = editorRef.current;
                const plain = (el?.innerText || "").replace(/\u200B/g, "").trim();
                if (plain.length === 0) {
                  e.preventDefault();
                  clearPending();
                  flushToStore();
                  void deleteIfEmpty(id);
                  return;
                }
              }

              if (e.key === "Tab") {
                e.preventDefault();
                clearPending();
                flushToStore();
                void (e.shiftKey ? outdent(id) : indent(id));
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
