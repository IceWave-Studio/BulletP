import { useEffect } from "react";
import { useStore } from "./store";
import LoginEmail from "./components/LoginEmail";
import MainApp from "./MainApp";

export default function App() {
  const hydrateAuth = useStore((s) => s.hydrateAuth);
  const userId = useStore((s) => s.userId);
  const homeId = useStore((s) => s.homeId);

  useEffect(() => {
    hydrateAuth();
  }, [hydrateAuth]);

  // ✅ 未登录：显示登录页
  if (!userId || !homeId) return <LoginEmail />;

  // ✅ 已登录：进入主界面
  return <MainApp />;
}
