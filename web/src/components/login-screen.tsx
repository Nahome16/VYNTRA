"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth-provider";

export function LoginScreen() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState("admin@vyntra.local");
  const [password, setPassword] = useState("Vyntra2026");
  const [statusText, setStatusText] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setStatusText("Validando credenciales...");
    try {
      await login(email, password);
      setStatusText("Sesion activa");
      router.replace("/dashboard");
    } catch {
      setStatusText("Credenciales incorrectas");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark">V</div>
        <h1>VYNTRA Control</h1>
        <p>Ingreso administrativo por empresa para revisar operaciones, equipos y reporteria.</p>
        <form onSubmit={handleLogin} className="login-form">
          <label>
            Correo
            <input value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            Contrasena
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button type="submit" disabled={loading}>
            {loading ? "Validando..." : "Iniciar sesion"}
          </button>
        </form>
        <span className="status-line">{statusText || "Sesion protegida por empresa y rol"}</span>
      </section>
    </main>
  );
}
