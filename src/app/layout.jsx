import "./globals.css";

export const metadata = {
  title: "Orbit API - Multi-Tenant SaaS Project Management API",
  description:
    "Django + Django REST Framework + PostgreSQL reference implementation of a multi-tenant project management API, with a live JavaScript mirror you can query from the browser.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
