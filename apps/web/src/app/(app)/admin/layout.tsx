import { IconShield } from "@/components/icons";
import { requireAdmin } from "@/lib/auth";
import { AdminNav } from "./admin-nav";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <IconShield className="h-4 w-4 text-gold" />
        <span className="text-2xs font-medium uppercase tracking-wider text-muted">Admin</span>
      </div>
      <AdminNav />
      {children}
    </div>
  );
}
