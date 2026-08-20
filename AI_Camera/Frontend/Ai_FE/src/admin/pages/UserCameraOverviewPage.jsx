import PageHeader from "../../components/ui/PageHeader";
import UserCameraOverview from "../../components/UserCameraOverview";

// Company-Admin-exclusive standalone page (see App.jsx — mounted only
// under /admin/*, never /user/*, and not wrapped in ModuleRoute, same
// pattern as this portal's account-level pages: guarded purely by
// AdminProtectedRoute's role check, exactly matching the backend's own
// company_admin_required gate on GET /dashboard/user-camera-overview).
// All the actual data-fetching/rendering logic lives in the shared
// components/UserCameraOverview.jsx — this page is just that component
// under its own PageHeader, reused unchanged from when it lived inside
// pages/Dashboard.jsx.
export default function UserCameraOverviewPage() {
  return (
    <div>
      <PageHeader
        eyebrow="Overview"
        title="User & Camera Overview"
        description="Total users, active users, and camera assignment status across your company."
      />
      <UserCameraOverview />
    </div>
  );
}
