import { Routes, Route, Navigate } from "react-router-dom";
import AdminLayout from "./admin/AdminLayout";
import AdminProtectedRoute from "./admin/AdminProtectedRoute";
import CurrentPlan from "./admin/pages/CurrentPlan";
import BillingPayment from "./admin/pages/BillingPayment";
import PaymentHistory from "./admin/pages/PaymentHistory";
import SiteManagement from "./admin/pages/SiteManagement";
import UserCameraOverviewPage from "./admin/pages/UserCameraOverviewPage";
import AISettings from "./admin/pages/AISettings";
import NotificationSettings from "./admin/pages/NotificationSettings";
import DetectionSettings from "./admin/pages/DetectionSettings";
import CompanySettings from "./admin/pages/CompanySettings";
import UserAISettings from "./user/pages/AISettings";
import UserNotificationSettings from "./user/pages/NotificationSettings";
import UserDetectionSettings from "./user/pages/DetectionSettings";
import UserCompanySettings from "./user/pages/CompanySettings";
import UserLayout from "./user/UserLayout";
import UserProtectedRoute from "./user/UserProtectedRoute";
import ModuleRoute from "./components/ModuleRoute";
import NotFoundRedirect from "./components/NotFoundRedirect";
import DynamicManifestLink from "./components/DynamicManifestLink";
import Landing from "./pages/Landing";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import LiveCamera from "./pages/LiveCamera";
import UnknownPersonAnalytics from "./pages/UnknownPersonAnalytics";
import CameraManagement from "./pages/CameraManagement";
import NormalCamera from "./pages/NormalCamera";
import UserManagement from "./pages/UserManagement";
import RegisteredPersons from "./pages/RegisteredPersons";
import UnknownPersons from "./pages/UnknownPersons";
import DetectionEvents from "./pages/DetectionEvents";
import Attendance from "./pages/Attendance";
import Reports from "./pages/Reports";
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
import AdminWebsiteSettings from "./super-admin/pages/AdminWebsiteSettings";
import AdminActivityLogs from "./super-admin/pages/AdminActivityLogs";
import AdminLeads from "./super-admin/pages/AdminLeads";

// The Company Admin (/admin/*) and User (/user/*) portals mount the same
// module-gated page set — reusing the identical page components either
// way. Which of those pages a specific account can actually reach is
// governed entirely by ModuleRoute + that account's granted modules.
// Most of the system's modules live here (see constants/modules.js
// MODULES) — only subscription_payment and site_management stay
// Company-Admin-exclusive, declared separately below.
//
// `includeDashboard` is false only for the Company Admin portal call
// below — the Dashboard page/route has been removed from /admin/* (it
// had no sidebar entry there already; Company Admin now lands on
// /admin/user-management after login instead). /user/dashboard is
// unaffected — every other call site defaults to true.
//
// Settings is deliberately NOT in this shared list — both portals used
// to mount the same combined pages/Settings.jsx here, but each now has
// its own 4-page split (registered separately below, right next to
// subscription-payment/sites for Admin) — see constants/modules.js
// SETTINGS_PAGES.
function ModulePortalRoutes({ includeDashboard = true } = {}) {
  return (
    <Route element={<ModuleRoute />}>
      {includeDashboard && <Route path="dashboard" element={<Dashboard />} />}
      <Route path="live-camera" element={<LiveCamera />} />
      <Route path="unknown-person-analytics" element={<UnknownPersonAnalytics />} />
      <Route path="camera-management" element={<CameraManagement />} />
      <Route path="normal-camera" element={<NormalCamera />} />
      <Route path="user-management" element={<UserManagement />} />
      <Route path="registered-persons" element={<RegisteredPersons />} />
      <Route path="unknown-persons" element={<UnknownPersons />} />
      <Route path="detection-events" element={<DetectionEvents />} />
      <Route path="attendance" element={<Attendance />} />
      <Route path="reports" element={<Reports />} />
    </Route>
  );
}

export default function App() {
  return (
    <>
      <DynamicManifestLink />
      <Routes>
      {/* Public Zynez marketing / landing page — the only unauthenticated
          content route. CTAs link into the existing /user/login flow;
          it never renders inside any portal layout or touches auth. */}
      <Route path="/" element={<Landing />} />

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
            <Route path="/super-admin/website-settings" element={<AdminWebsiteSettings />} />
            <Route path="/super-admin/audit-logs" element={<AdminActivityLogs />} />
            <Route path="/super-admin/leads" element={<AdminLeads />} />
          </Route>
        </Route>
      </Route>

      {/* ============ Company Admin Portal ============ */}
      <Route path="/admin/login" element={<Login />} />

      <Route path="/admin" element={<AdminProtectedRoute />}>
        <Route element={<AdminLayout />}>
          {/* Dashboard was removed from the Company Admin portal (no
              sidebar entry, no route) — land on the first real admin
              page instead, same as the top of ADMIN_SIDEBAR_GROUPS in
              constants/modules.js. */}
          <Route index element={<Navigate to="/admin/user-management" replace />} />

          {/* Company-Admin-exclusive, module-gated pages — see
              constants/modules.js SUBSCRIPTION_PAYMENT_PAGES. Wrapped in
              ModuleRoute exactly like the shared pages below, so a direct
              URL visit to any of these before the Super Admin has granted
              "subscription_payment" redirects to /admin/403 instead of
              rendering. Never mounted under /user/* — this is the Company
              Admin's own billing, split into 3 fully separate pages/routes
              (no shared anchor scroll, no shared state) — see
              constants/modules.js ADMIN_SIDEBAR_GROUPS' Subscription &
              Payment group. */}
          <Route element={<ModuleRoute />}>
            <Route path="current-plan" element={<CurrentPlan />} />
            <Route path="billing-payment" element={<BillingPayment />} />
            <Route path="payment-history" element={<PaymentHistory />} />
            <Route path="sites" element={<SiteManagement />} />

            {/* The old single /admin/settings page, split into 4 —
                see constants/modules.js ADMIN_SETTINGS_PAGES + admin/pages/
                {AISettings,NotificationSettings,DetectionSettings,
                CompanySettings}.jsx. Same "settings" module gate as
                before; never mounted under /user/*, which keeps the
                original combined Settings page via
                ModulePortalRoutes({ includeSettings: true }) below. */}
            <Route path="ai-settings" element={<AISettings />} />
            <Route path="notification-settings" element={<NotificationSettings />} />
            <Route path="detection-settings" element={<DetectionSettings />} />
            <Route path="company-settings" element={<CompanySettings />} />
          </Route>

          {ModulePortalRoutes({ includeDashboard: false })}

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

          {/* The old single /user/settings page (formerly
              pages/Settings.jsx, now deleted — see the 2026-09-01 split
              memory), split into 4 — see constants/modules.js
              SETTINGS_PAGES + user/pages/{AISettings,
              NotificationSettings,DetectionSettings,CompanySettings}.jsx.
              Same "settings" module gate as before. */}
          <Route element={<ModuleRoute />}>
            <Route path="ai-settings" element={<UserAISettings />} />
            <Route path="notification-settings" element={<UserNotificationSettings />} />
            <Route path="detection-settings" element={<UserDetectionSettings />} />
            <Route path="company-settings" element={<UserCompanySettings />} />
          </Route>

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
    </>
  );
}
