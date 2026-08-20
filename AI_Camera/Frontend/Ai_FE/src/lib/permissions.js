// Single source of truth for role/module permission checks. Every
// component that needs to know what a logged-in user can see or do
// should import from here rather than inlining `user?.modules?.includes(...)`
// — keeps the checks consistent and makes them easy to audit in one place.

export const isSuperAdmin = (user) => user?.role === "Super Admin";

export const isCompanyAdmin = (user) => user?.role === "Company Admin";

export const isUser = (user) => user?.role === "User";

export const hasModule = (user, moduleKey) => Boolean(user?.modules?.includes(moduleKey));

export const hasAnyModule = (user, ...moduleKeys) => moduleKeys.some((key) => hasModule(user, key));

export const roleLabel = (user) => user?.role_label || user?.role || "";
