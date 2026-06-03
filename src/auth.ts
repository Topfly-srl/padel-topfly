import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { appConfig, hasMicrosoftAuthConfig, isAllowedCompanyEmail } from "@/lib/config";
import { upsertUserProfile } from "@/lib/users";

const microsoftProvider = hasMicrosoftAuthConfig()
  ? [
      MicrosoftEntraID({
        clientId: appConfig.microsoft.clientId,
        clientSecret: appConfig.microsoft.clientSecret,
        issuer: `https://login.microsoftonline.com/${appConfig.microsoft.tenantId}/v2.0`,
      }),
    ]
  : [];

const devProvider = appConfig.authDevMode
  ? [
      Credentials({
        id: "dev-login",
        name: "Dev Login",
        credentials: {},
        async authorize() {
          return {
            id: "dev-user",
            email: appConfig.devUser.email,
            name: appConfig.devUser.name,
          };
        },
      }),
    ]
  : [];

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [...microsoftProvider, ...devProvider],
  pages: {
    signIn: "/signin",
  },
  session: {
    strategy: "jwt",
  },
  trustHost: true,
  callbacks: {
    async signIn({ user }) {
      const email = user.email?.toLowerCase();

      if (!email || !isAllowedCompanyEmail(email)) {
        return false;
      }

      if (!appConfig.databaseConfigured) {
        return true;
      }

      await upsertUserProfile({
        email,
        name: user.name ?? null,
        image: user.image ?? null,
      });

      return true;
    },
    async jwt({ token, user }) {
      const email = (user?.email ?? token.email)?.toLowerCase();

      if (!email || !isAllowedCompanyEmail(email)) {
        return token;
      }

      if (!appConfig.databaseConfigured) {
        token.userId = "dev-user";
        token.role = appConfig.adminEmails.has(email) ? "ADMIN" : "USER";
        return token;
      }

      const dbUser = await upsertUserProfile({
        email,
        name: user?.name ?? token.name ?? null,
        image: user?.image ?? token.picture ?? null,
      });

      token.userId = dbUser.id;
      token.role = dbUser.role;

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = typeof token.userId === "string" ? token.userId : "";
        session.user.role = token.role === "ADMIN" ? "ADMIN" : "USER";
      }

      return session;
    },
  },
});
