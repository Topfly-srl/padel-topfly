import { redirect } from "next/navigation";
import Image from "next/image";
import { signIn } from "@/auth";
import { appConfig, hasMicrosoftAuthConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/server-auth";

export default async function SignInPage() {
  const user = await getCurrentUser();

  if (user) {
    redirect("/");
  }

  async function signInWithMicrosoft() {
    "use server";
    await signIn("microsoft-entra-id", { redirectTo: "/" });
  }

  async function signInDev() {
    "use server";
    await signIn("dev-login", { redirectTo: "/" });
  }

  const microsoftReady = hasMicrosoftAuthConfig();

  return (
    <main className="signin-shell">
      <section className="signin-card">
        <div className="signin-brand">
          <Image
            src="/topfly-logo.png"
            alt="TOPFLY GPS solutions"
            width={678}
            height={147}
            priority
          />
        </div>
        <p className="eyebrow">Padel aziendale</p>
        <h1>Entra e prenota il campo</h1>
        <p className="signin-copy">
          Accesso riservato agli account del dominio {appConfig.allowedDomain}.
        </p>

        {microsoftReady ? (
          <form action={signInWithMicrosoft}>
            <button className="primary-button full-width" type="submit">
              Continua con Microsoft 365
            </button>
          </form>
        ) : (
          <div className="notice">
            Configura Microsoft Entra ID per abilitare il login aziendale.
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
