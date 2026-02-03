// src/App.tsx
import { useEffect } from "react";
import { useStore } from "./store";
import LoginEmail from "./components/LoginEmail";
import MainApp from "./MainApp";

/**
 * App = 登录态 gate
 *
 * - 未登录：LoginEmail
 * - 已登录：MainApp
 */
export default function App() {
  const hydrateAuth = useStore((s) => s.hydrateAuth);
  const userId = useStore((s) => s.userId);
  const homeId = useStore((s) => s.homeId);

  useEffect(() => {
    hydrateAuth();
  }, [hydrateAuth]);

  if (!userId || !homeId) {
    return <LoginEmail />;
  }

  return <MainApp />;
}
