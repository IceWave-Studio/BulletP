// src/components/LoginEmail.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";

const grayLight = "#D1D5DB";
const gray = "#9CA3AF";
const black = "#111827";

function isValidEmail(email: string) {
  const e = email.trim().toLowerCase();
  return e.includes("@") && e.includes(".");
}

export default function LoginEmail() {
  const setAuth = useStore((s) => s.setAuth);

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");

  const [step, setStep] = useState<"email" | "code">("email");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [cooldown, setCooldown] = useState(0); // seconds

  const emailOk = useMemo(() => isValidEmail(email), [email]);
  const codeOk = useMemo(() => /^\d{6}$/.test(code.trim()), [code]);

  const emailRef = useRef<HTMLInputElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // autofocus
    if (step === "email") emailRef.current?.focus();
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setInterval(() => {
      setCooldown((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [cooldown]);

  const sendCode = async () => {
    setErr(null);
    if (!emailOk) {
      setErr("请输入正确的邮箱地址。");
      return;
    }
    if (cooldown > 0) return;

    setLoading(true);
    try {
      const res = await api.emailStart({ email: email.trim().toLowerCase() });
      // 后端返回 expires_in（秒），我们给一个 resend cooldown（比如 30 秒）
      setStep("code");
      setCooldown(Math.min(60, Math.max(20, Math.floor(res.expires_in / 10)))); // 20~60s
    } catch (e: any) {
      setErr(e?.message || "发送失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  };

  const verify = async () => {
    setErr(null);
    if (!emailOk) {
      setErr("邮箱不正确。");
      setStep("email");
      return;
    }
    if (!codeOk) {
      setErr("请输入 6 位数字验证码。");
      return;
    }

    setLoading(true);
    try {
      const res = await api.emailVerify({
        email: email.trim().toLowerCase(),
        code: code.trim(),
      });

      // ✅ 登录态落 store + localStorage
      setAuth(res.user_id, res.home_id, email.trim().toLowerCase());
      // 之后路由/页面切换由你的 App 外层决定（比如根据 userId 渲染 MainApp）
    } catch (e: any) {
      setErr(e?.message || "验证码错误或已过期。");
    } finally {
      setLoading(false);
    }
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    if (loading) return;

    if (step === "email") sendCode();
    else verify();
  };

  return (
    <div className="h-screen w-screen bg-white text-gray-900 font-sans overflow-hidden">
      {/* 顶部极简 Header（对齐主站风格） */}
      <div
        style={{
          height: 56,
          borderBottom: "1px solid rgba(0,0,0,0.08)",
          display: "flex",
          alignItems: "center",
          padding: "0 18px",
        }}
      >
        <div
          style={{
            fontFamily: "ui-serif, Georgia, Cambria, Times New Roman, Times, serif",
            fontWeight: 800,
            fontSize: 28,
            letterSpacing: 0.2,
          }}
        >
          BulletP
        </div>
        <div style={{ marginLeft: 12, color: gray, fontSize: 13 }}>
          Email Login
        </div>
      </div>

      {/* 居中卡片 */}
      <div className="flex items-center justify-center" style={{ height: "calc(100vh - 56px)" }}>
        <div
        style={{
            width: 440,
            boxSizing: "border-box", // ✅ 防溢出
            border: "1px solid rgba(0,0,0,0.10)",
            borderRadius: 18,
            boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
            padding: 22,
        }}
        >

          <div style={{ fontSize: 18, fontWeight: 800, color: black }}>
            {step === "email" ? "Sign in with Email" : "Enter verification code"}
          </div>

          <div style={{ marginTop: 8, fontSize: 13, color: gray, lineHeight: 1.5 }}>
            {step === "email"
              ? "We’ll send a one-time code to your email (dev mode: code prints in backend logs)."
              : `Code sent to ${email.trim().toLowerCase()} · Please enter the 6-digit code.`}
          </div>

          {/* Email input */}
          <div style={{ marginTop: 18 }}>
            <label style={{ display: "block", fontSize: 12, color: gray, marginBottom: 6 }}>
              Email
            </label>
            <input
              ref={emailRef}
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setErr(null);
              }}
              onKeyDown={onEnter}
              disabled={loading || step === "code"} // code step 锁 email，保持一致性
              placeholder="you@example.com"
              style={{
                width: "100%",
                boxSizing: "border-box", 
                height: 44,
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.12)",
                padding: "0 12px",
                outline: "none",
                color: black,
                background: step === "code" ? "rgba(0,0,0,0.03)" : "white",
              }}
            />
          </div>

          {/* Code input */}
          <div style={{ marginTop: 14, display: step === "code" ? "block" : "none" }}>
            <label style={{ display: "block", fontSize: 12, color: gray, marginBottom: 6 }}>
              6-digit code
            </label>
            <input
              ref={codeRef}
              value={code}
              onChange={(e) => {
                // 只允许数字
                const v = e.target.value.replace(/[^\d]/g, "").slice(0, 6);
                setCode(v);
                setErr(null);
              }}
              onKeyDown={onEnter}
              disabled={loading}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              style={{
                width: "100%",
                boxSizing: "border-box", 
                height: 44,
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.12)",
                padding: "0 12px",
                outline: "none",
                letterSpacing: 4,
                fontWeight: 700,
                color: black,
              }}
            />
          </div>

          {/* Error */}
          {err && (
            <div
              style={{
                marginTop: 12,
                background: "rgba(239,68,68,0.08)",
                border: "1px solid rgba(239,68,68,0.18)",
                color: "rgb(185,28,28)",
                borderRadius: 12,
                padding: "10px 12px",
                fontSize: 13,
              }}
            >
              {err}
            </div>
          )}

          {/* Buttons */}
          <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
            {step === "email" ? (
              <button
                onClick={sendCode}
                disabled={loading || !emailOk || cooldown > 0}
                style={{
                  flex: 1,
                  height: 44,
                  borderRadius: 12,
                  background: loading || !emailOk ? "rgba(17,24,39,0.25)" : black,
                  color: "white",
                  fontWeight: 800,
                  cursor: loading || !emailOk ? "default" : "pointer",
                }}
              >
                {loading ? "Sending..." : cooldown > 0 ? `Wait ${cooldown}s` : "Send code"}
              </button>
            ) : (
              <>
                <button
                  onClick={() => {
                    setStep("email");
                    setCode("");
                    setErr(null);
                    // 允许修改邮箱
                    window.setTimeout(() => emailRef.current?.focus(), 0);
                  }}
                  disabled={loading}
                  style={{
                    width: 110,
                    height: 44,
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.12)",
                    color: black,
                    fontWeight: 700,
                    cursor: loading ? "default" : "pointer",
                    background: "white",
                  }}
                  onMouseEnter={(e) => {
                    if (loading) return;
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,0,0,0.04)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = "white";
                  }}
                >
                  Back
                </button>

                <button
                  onClick={verify}
                  disabled={loading || !codeOk}
                  style={{
                    flex: 1,
                    height: 44,
                    borderRadius: 12,
                    background: loading || !codeOk ? "rgba(17,24,39,0.25)" : black,
                    color: "white",
                    fontWeight: 800,
                    cursor: loading || !codeOk ? "default" : "pointer",
                  }}
                >
                  {loading ? "Signing in..." : "Sign in"}
                </button>
              </>
            )}
          </div>

          {/* Resend / hint */}
          {step === "code" && (
            <div
              style={{
                marginTop: 12,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 12,
                color: gray,
              }}
            >
              <span>Didn’t receive it?</span>
              <button
                onClick={sendCode}
                disabled={loading || cooldown > 0}
                style={{
                  color: cooldown > 0 ? grayLight : black,
                  fontWeight: 700,
                  cursor: loading || cooldown > 0 ? "default" : "pointer",
                }}
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend"}
              </button>
            </div>
          )}

          {/* tiny footer */}
          <div style={{ marginTop: 18, fontSize: 12, color: grayLight }}>
            Tip: press Enter to continue.
          </div>
        </div>
      </div>
    </div>
  );
}
