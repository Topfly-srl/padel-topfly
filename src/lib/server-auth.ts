import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { appConfig, isAdminEmail, isAllowedCompanyEmail } from "@/lib/config";
import { getOrCreateDevUser, toCurrentUser, upsertUserProfile } from "@/lib/users";
import type { CurrentUser } from "@/lib/types";

export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (appConfig.authDevMode) {
    if (!appConfig.databaseConfigured) {
      return {
        id: "dev-user",
        email: appConfig.devUser.email,
        name: appConfig.devUser.name,
        role: isAdminEmail(appConfig.devUser.email) ? "ADMIN" : "USER",
      };
    }

    return toCurrentUser(await getOrCreateDevUser());
  }

  const session = await auth();
  const sessionUser = session?.user;
  const email = sessionUser?.email?.toLowerCase();

  if (!email || !isAllowedCompanyEmail(email)) {
    return null;
  }

  const user = await upsertUserProfile({
    email,
    name: sessionUser?.name ?? null,
    image: sessionUser?.image ?? null,
  });

  return toCurrentUser(user);
}

export async function requireCurrentUser() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/signin");
  }

  return user;
}

export async function requireApiUser() {
  const user = await getCurrentUser();

  if (!user) {
    throw new Response(JSON.stringify({ error: "Accesso richiesto." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return user;
}

export function assertAdmin(user: CurrentUser) {
  if (user.role !== "ADMIN") {
    throw new Response(JSON.stringify({ error: "Serve un account admin." }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
}
