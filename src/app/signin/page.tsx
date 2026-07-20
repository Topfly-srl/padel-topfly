import { redirect } from "next/navigation";
import Image from "next/image";
import { signIn } from "@/auth";
import { appConfig, hasMicrosoftAuthConfig } from "@/lib/config";
import { appPath } from "@/lib/app-path";
import { getCurrentUser } from "@/lib/server-auth";

export default async function SignInPage() {
  const user = await getCurrentUser();

  if (user?.role === "ADMIN") {
    redirect("/admin");
  }

  async function signInWithMicrosoft() {
    "use server";
    await signIn("microsoft-entra-id", { redirectTo: "/admin" });
  }

  async function signInDev() {
    "use server";
    await signIn("dev-login", { redirectTo: "/admin" });
  }

  const microsoftReady = hasMicrosoftAuthConfig();

  return (
    <main className="signin-shell">
      <section className="signin-card">
        <div className="signin-brand">
          <Image
            src={appPath("/topfly-logo.png")}
            alt="TOPFLY GPS solutions"
            width={678}
            height={147}
            priority
          />
        </div>
        <p className="eyebrow">Padel aziendale</p>
        <h1>Accesso admin</h1>
        <p className="signin-copy">
          Area riservata a chi gestisce blocchi, storico e override prenotazioni.
        </p>

        {user ? (
          <div className="notice error" role="alert">Account Microsoft valido, ma non abilitato come admin.</div>
        ) : null}

        {microsoftReady ? (
          <form action={signInWithMicrosoft}>
            <button className="primary-button full-width" type="submit">
              Entra con Microsoft 365
            </button>
          </form>
        ) : (
          <div className="notice">
            {"Configura Microsoft Entra ID per abilitare l'accesso admin."}
          </div>
        )}

        {appConfig.authDevMode ? (
          <form action={signInDev}>
            <button className="ghost-button full-width" type="submit">
              Entra in modalita dev
            </button>
          </form>
        ) : null}
      </section>
    </main>
  );
}
