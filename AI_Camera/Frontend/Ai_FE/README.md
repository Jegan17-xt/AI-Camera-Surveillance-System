# Sentinel AI — Camera Surveillance Dashboard

A modern, dark-themed glassmorphism dashboard UI for an AI Camera Surveillance System, built with React + Vite + Tailwind CSS. Frontend only — all data is dummy JSON, no backend/API calls.

## Tech Stack

- React 19 + Vite
- Tailwind CSS v4
- React Router DOM (page navigation)
- lucide-react (icons)

## Getting Started

```bash
npm install
npm run dev
```

Then open the printed local URL (typically `http://localhost:5173`).

To build for production:

```bash
npm run build
npm run preview
```

## Folder Structure

```
src/
  components/     Reusable UI building blocks (Sidebar, Navbar, StatCard, etc.)
    ui/            Small generic primitives (Button, GlassCard, Modal, SearchInput, StatusBadge, Toggle, PageHeader)
  pages/          One file per route/page
  layouts/        DashboardLayout (sidebar + navbar + page outlet)
  data/           Dummy JSON-style data used across pages
  assets/         Static assets
```

## Pages

- **Dashboard** — stat cards, live camera preview grid, recent activity feed, attendance summary chart, unknown detection summary
- **Live Camera** — full grid of all camera streams (placeholders) with online/offline status
- **Registered Persons** — searchable grid of enrolled persons + "Add Person" modal
- **Unknown Persons** — detected unknown faces with date/time/detection count/last seen, filterable by date
- **Attendance** — searchable, date-filterable attendance table (Name, Date, In Time, Out Time, Status)
- **Reports** — daily/monthly report generation with CSV/PDF export buttons (UI only)
- **Settings** — Camera, AI, and Notification settings panels

## Notes

- All data in `src/data/*.js` is static dummy data — no backend, no API calls.
- Download/export buttons are UI-only placeholders (no real file generation).
- Design: dark navy base with cyan/blue accent glow, glassmorphism surfaces (blurred translucent panels), and a camera-viewfinder corner-bracket motif used throughout to reinforce the surveillance theme.
