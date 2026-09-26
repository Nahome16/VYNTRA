/**
 * Permiso requerido por cada ruta del panel. Es la misma fuente que usa el menu
 * lateral, de modo que una ruta oculta en el menu tampoco se puede abrir por URL.
 */
export const routePermissions: Array<{ href: string; permission: string }> = [
  { href: "/sistema", permission: "system:manage" },
  { href: "/dashboard", permission: "dashboard:read" },
  { href: "/empleados", permission: "employees:read" },
  { href: "/asistencia", permission: "attendance:read" },
  { href: "/dispositivos", permission: "devices:read" },
  { href: "/descargas", permission: "devices:manage" },
  { href: "/auditoria", permission: "audit:read" },
  { href: "/ajustes", permission: "settings:manage" },
];

function matchesRoute(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Permiso requerido para `pathname`, o null si la ruta no es del panel protegido. */
export function requiredPermissionFor(pathname: string | null | undefined) {
  if (!pathname) return null;
  return routePermissions.find((route) => matchesRoute(pathname, route.href))?.permission || null;
}

export function hasPermission(permissions: string[] | null | undefined, permission: string) {
  return Boolean(permissions?.includes(permission));
}
