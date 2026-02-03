import { useState } from "react";
import { api } from "../api";
import { useStore } from "../store";

export default function Login() {
  const setAuth = useStore((s) => s.setAuth);

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setError(null);
    setLoading(true);
    try {
      await api.emailStart({ email });
      setStep("code");
    } catch (e: any) {
      setError(e.message ?? "Failed to send code");
    } finally {
      setLoading(false);
    }
  }

  async function verify() {
    setError(null);
    setLoading(true);
    try {
      const res = await api.emailVerify({ email, code });
      setAuth(res.user_id, res.home_id, email);
    } catch (e: any) {
      setError(e.message ?? "Invalid code");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <div className="w-80 rounded border bg-white p-6 space-y-4">
        <h1 className="text-xl font-semibold text-center">BulletP</h1>

        {step === "email" ? (
          <>
            <input
              className="w-full border p-2 rounded"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button
              className="w-full border rounded p-2 hover:bg-gray-100"
              disabled={loading || !email}
              onClick={sendCode}
            >
              {loading ? "Sending…" : "Send Code"}
            </button>
          </>
        ) : (
          <>
            <input
              className="w-full border p-2 rounded"
              placeholder="Verification Code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button
              className="w-full border rounded p-2 hover:bg-gray-100"
              disabled={loading || !code}
              onClick={verify}
            >
              {loading ? "Verifying…" : "Verify"}
            </button>
          </>
        )}

        {error && <div className="text-sm text-red-600">{error}</div>}
      </div>
    </div>
  );
}

