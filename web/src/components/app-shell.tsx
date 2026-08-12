"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect } from "react";
import { useAuth } from "@/components/auth-provider";

const navItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/empleados", label: "Empleados" },
  { href: "/asistencia", label: "Asistencia" },
  { href: "/ajustes", label: "Ajustes" },
];

export function AppShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { ready, user, logout } = useAuth();

  useEffect(() => {
    if (ready && !user) router.replace("/login");
  }, [ready, router, user]);

  if (!ready || !user) {
    return (
      <main className="loading-shell">
        <div className="brand-mark">V</div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">V</div>
          <div>
            <strong>VYNTRA</strong>
            <span>Control</span>
          </div>
        </div>
        <nav>
          {navItems.map((item) => (
            <Link
              href={item.href}
              key={item.href}
              className={pathname.startsWith(item.href) ? "active" : ""}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="user-box">
          <span>{user.company}</span>
          <strong>{user.full_name}</strong>
          <small>{user.email} - {user.role}</small>
          <button className="ghost-button" onClick={logout}>Salir</button>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <h1>{title}</h1>
            <p>{description}</p>
          </div>
          {actions}
        </header>
        {children}
      </section>
    </main>
  );
}
