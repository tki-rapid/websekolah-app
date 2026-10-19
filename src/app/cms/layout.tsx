import { getSession } from "@/lib/auth/cookies";
import { logoutAction } from "../login/actions";
import { NavLink } from "@/components/nav-link";
import { MODULE_ORDER, SINGLETON_ORDER, TYPES } from "@/lib/content/types";

export default async function CmsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getSession();
  return (
    <>
      <header className="topbar">
        <div>
          <span className="brand">WebSekolah · CMS</span>
          <nav aria-label="Navigasi utama">
            <NavLink href="/cms" exact>Ringkasan</NavLink>
            <NavLink href="/cms/media">Media</NavLink>
            <NavLink href="/cms/settings">Pengaturan</NavLink>
            <NavLink href="/cms/audit">Aktivitas</NavLink>
          </nav>
          {ctx ? <form action={logoutAction}><button className="btn inline sm" type="submit">Keluar ({ctx.user.email})</button></form> : null}
        </div>
      </header>
      <nav className="sub-nav" aria-label="Modul konten">
        {MODULE_ORDER.map((t) => <NavLink key={t} href={`/cms/${t}`}>{TYPES[t]!.label}</NavLink>)}
        {SINGLETON_ORDER.map((t) => <NavLink key={t} href={`/cms/${t}`}>{TYPES[t]!.label}</NavLink>)}
      </nav>
      {children}
    </>
  );
}
