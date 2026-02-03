// src/types.ts
export interface Node {
  id: string;
  content: string;
  children: string[];
  parentId: string | null;   // ✅ 用于 zoom out / indent/outdent / breadcrumb
  isCollapsed?: boolean;
  isCompleted?: boolean;
}

export interface TreeState {
  nodes: Record<string, Node>;
  rootId: string;
}
