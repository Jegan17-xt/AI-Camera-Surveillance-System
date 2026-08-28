import { Routes, Route, Navigate } from "react-router-dom";
import AdminLayout from "./admin/AdminLayout";
import AdminProtectedRoute from "./admin/AdminProtectedRoute";
import SubscriptionPayment from "./admin/pages/SubscriptionPayment";
import SiteManagement from "./admin/pages/SiteManagement";
import UserCameraOverviewPage from "./admin/pages/UserCameraOverviewPage";
import UserLayout from "./user/UserLayout";
import UserProtectedRoute from "./user/UserProtectedRoute";
import ModuleRoute from "./components/ModuleRoute";
import NotFoundRedirect from "./components/NotFoundRedirect";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import LiveCamera from "./pages/LiveCamera";
import UnknownPersonAnalytics from "./pages/UnknownPersonAnalytics";
import CameraManagement from "./pages/CameraManagement";
import NormalCamera from "./pages/NormalCamera";
import UserManagement from "./pages/UserManagement";
import RegisteredPersons from "./pages/RegisteredPersons";
import UnknownPersons from "./pages/UnknownPersons";
import Attendance from "./pages/Attendance";
import Reports from "./pages/Reports";
import Settings from "./pages/Settings";
import Profile from "./pages/Profile";
import Subscription from "./pages/Subscription";
import Notifications from "./pages/Notifications";
import Forbidden from "./pages/Forbidden";

import SuperAdminLayout from "./super-admin/layouts/SuperAdminLayout";
import { AdminThemeProvider } from "./super-admin/context/AdminThemeContext";
import SuperAdminProtectedRoute from "./super-admin/SuperAdminProtectedRoute";
import SuperAdminLogin from "./super-admin/pages/SuperAdminLogin";
import AdminDashboard from "./super-admin/pages/AdminDashboard";
import AdminCustomers from "./super-admin/pages/AdminCustomers";
import AdminCustomerDetails from "./super-admin/pages/AdminCustomerDetails";
import AdminCompanyDetails from "./super-admin/pages/AdminCompanyDetails";
import AdminManagement from "./super-admin/pages/AdminManagement";
import AdminOverview from "./super-admin/pages/AdminOverview";
import AdminOverviewDetail from "./super-admin/pages/AdminOverviewDetail";
import AdminOverviewUserDetail from "./super-admin/pages/AdminOverviewUserDetail";
import AdminBillingPricing from "./super-admin/pages/AdminBillingPricing";
import AdminBillingOverview from "./super-admin/pages/AdminBillingOverview";
import AdminBillingSubscriptions from "./super-admin/pages/AdminBillingSubscriptions";
import AdminBillingPaymentsLog from "./super-admin/pages/AdminBillingPaymentsLog";
import AdminBillingPaymentHistory from "./super-admin/pages/AdminBillingPaymentHistory";
import AdminChangePassword from "./super-admin/pages/AdminChangePassword";
import AdminSystemSettings from "./super-admin/pages/AdminSystemSettings";
import AdminActivityLogs from "./super-admin/pages/AdminActivityLogs";

// The Company Admin (/admin/*) and User (/user/*) portals mount the same
// module-gated page set — reusing the identical page components either
// way. Which of those pages a specific account can actually reach is
// governed entirely by ModuleRoute + that account's granted modules. 11
// of the system's 12 modules live here (see constants/modules.js
// MODULES) — only subscription_payment stays Company-Admin-exclusive,
// declared separately below.
function ModulePortalRoutes() {
  return (
    <Route element={<ModuleRoute />}>
      <Route path="dashboard" element={<Dashboard />} />
      <Route path="live-camera" element={<LiveCamera />} />
      <Route path="unknown-person-analytics" element={<UnknownPersonAnalytics />} />
      <Route path="camera-management" element={<CameraManagement />} />
      <Route path="normal-camera" element={<NormalCamera />} />
      <Route path="user-management" element={<UserManagement />} />
      <Route path="registered-persons" element={<RegisteredPersons />} />
      <Route path="unknown-persons" element={<UnknownPersons />} />
      <Route path="attendance" element={<Attendance />} />
      <Route path="reports" element={<Reports />} />
      <Route path="settings" element={<Settings />} />
    </Route>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/user/login" replace />} />

      {/* ============ Super Admin Portal ============ */}
      <Route element={<AdminThemeProvider />}>
        <Route path="/super-admin" element={<Navigate to="/super-admin/dashboard" replace />} />
        <Route path="/super-admin/login" element={<SuperAdminLogin />} />

        <Route element={<SuperAdminProtectedRoute />}>
          <Route element={<SuperAdminLayout />}>
            <Route path="/super-admin/dashboard" element={<AdminDashboard />} />
            <Route path="/super-admin/company-management" element={<AdminCustomers />} />
            <Route path="/super-admin/company-management/:id/details" element={<AdminCompanyDetails />} />
            <Route path="/super-admin/company-management/:id" element={<AdminCustomerDetails />} />
            <Route path="/super-admin/admin-management" element={<AdminManagement />} />
            <Route path="/super-admin/admin-overview" element={<AdminOverview />} />
            <Route path="/super-admin/admin-overview/:id" element={<AdminOverviewDetail />} />
            <Route path="/super-admin/admin-overview/:id/users/:userId" element={<AdminOverviewUserDetail />} />
            <Route path="/super-admin/billing/overview" element={<AdminBillingOverview />} />
            <Route path="/super-admin/billing/pricing" element={<AdminBillingPricing />} />
            <Route path="/super-admin/billing/subscriptions" element={<AdminBillingSubscriptions />} />
            <Route path="/super-admin/billing/payments" element={<AdminBillingPaymentsLog />} />
            <Route path="/super-admin/billing/payment-history" element={<AdminBillingPaymentHistory />} />
            <Route path="/super-admin/password" element={<AdminChangePassword />} />
            <Route path="/super-admin/system-settings" element={<AdminSystemSettings />} />
            <Route path="/super-admin/audit-logs" element={<AdminActivityLogs />} />
          </Route>
        </Route>
      </Route>

      {/* ============ Company Admin Portal ============ */}
      <Route path="/admin/login" element={<Login />} />

      <Route path="/admin" element={<AdminProtectedRoute />}>
        <Route element={<AdminLayout />}>
          <Route index element={<Navigate to="/admin/dashboard" replace />} />

          {/* Company-Admin-exclusive, module-gated page — see
              constants/modules.js COMPANY_ADMIN_ONLY_MODULES. Wrapped in
              ModuleRoute exactly like the shared pages below, so a direct
              URL visit to this page before the Super Admin has granted it
              redirects to /admin/403 instead of rendering. Never mounted
              under /user/* — this is the Company Admin's own billing. */}
          <Route element={<ModuleRoute />}>
            <Route path="subscription-payment" element={<SubscriptionPayment />} />
            <Route path="sites" element={<SiteManagement />} />
          </Route>

          {ModulePortalRoutes()}

          {/* Company-Admin-exclusive, not module-gated (no Super Admin
              grant/lock involved — every Company Admin can always reach
              it, same as Profile/Subscription/Notifications below).
              Never mounted under /user/*; guarded purely by
              AdminProtectedRoute's role check above, matching the
              backend's company_admin_required on GET
              /dashboard/user-camera-overview. */}
          <Route path="user-camera-overview" element={<UserCameraOverviewPage />} />

          {/* Account-level, not module-gated — every logged-in account
              can always reach its own Profile/Payment/Notifications. */}
          <Route path="profile" element={<Profile />} />
          <Route path="subscription" element={<Subscription />} />
          <Route path="notifications" element={<Notifications />} />

          <Route path="403" element={<Forbidden />} />
        </Route>
      </Route>

      {/* ============ User Portal ============ */}
      <Route path="/user/login" element={<Login />} />

      <Route path="/user" element={<UserProtectedRoute />}>
        <Route element={<UserLayout />}>
          <Route index element={<Navigate to="/user/dashboard" replace />} />

          {ModulePortalRoutes()}

          <Route path="profile" element={<Profile />} />
          <Route path="subscription" element={<Subscription />} />
          <Route path="notifications" element={<Notifications />} />

          <Route path="403" element={<Forbidden />} />
        </Route>
      </Route>

      {/* Any URL that isn't one of the above (typos, stale bookmarks,
          hand-typed paths that were never real routes) — send the
          visitor to wherever they belong instead of a blank page. */}
      <Route path="*" element={<NotFoundRedirect />} />
    </Routes>
  );
}
