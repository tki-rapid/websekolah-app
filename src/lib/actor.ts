import type { Principal } from "@/lib/auth/rbac";

/** Who is acting, resolved from the authenticated session — services never accept identity from input. */
export type Actor = {
  principal: Principal;
  userId: string;
  email: string;
  tenantId: string | null; // school admin: own school; super admin: null
  ip?: string;
  reauthOk?: boolean; // authentication within the last 10 minutes (PRD §10)
};
