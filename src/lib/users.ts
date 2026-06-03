import type { UserRole } from "@prisma/client";
import { appConfig, isAdminEmail } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/types";

export type UpsertUserProfileInput = {
  email: string;
  name: string | null;
  image?: string | null;
};

export async function upsertUserProfile(input: UpsertUserProfileInput) {
  const email = input.email.toLowerCase();
  const role: UserRole = isAdminEmail(email) ? "ADMIN" : "USER";

  return prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: input.name,
      image: input.image ?? null,
      role,
      lastLoginAt: new Date(),
    },
    update: {
      name: input.name,
      image: input.image ?? null,
      role,
      lastLoginAt: new Date(),
    },
  });
}

export async function getOrCreateDevUser() {
  return upsertUserProfile({
    email: appConfig.devUser.email,
    name: appConfig.devUser.name,
    image: null,
  });
}

export function toCurrentUser(user: {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
}): CurrentUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}
