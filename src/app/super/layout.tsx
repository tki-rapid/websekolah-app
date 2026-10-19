import { getSession } from "@/lib/auth/cookies";
import { logoutAction } from "../login/actions";
import { NavLink } from "@/components/nav-link";

export default async function SuperLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getSession();
  return (
    <>
      <header className="topbar">
        <div>
          <span className="brand">WebSekolah · Super</span>
          <nav aria-label="Navigasi utama">
            <NavLink href="/super" exact>Ringkasan</NavLink>
            <NavLink href="/super/tenants">Sekolah</NavLink>
          </nav>
          {ctx ? <form action={logoutAction}><button className="btn inline sm" type="submit">Keluar ({ctx.user.email})</button></form> : null}
        </div>
      </header>
      {children}
    </>
  );
}
