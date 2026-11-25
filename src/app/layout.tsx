import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { RegisterSW } from "@/components/RegisterSW";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Personal OS", template: "%s · Personal OS" },
  description: "Assistente esecutivo personale: agenda, lavoro, sonno, allenamento, studio.",
  applicationName: "Personal OS",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "Personal OS", statusBarStyle: "default" },
  icons: { icon: "/icon.svg", apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f6f2" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0f0e" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="it" suppressHydrationWarning>
      <head>
        {/* tema scelto manualmente applicato prima del rendering (evita il lampo); script con nonce CSP */}
        <script
          nonce={nonce}
          // eslint-disable-next-line react/no-danger -- contenuto statico, nessun input utente
          dangerouslySetInnerHTML={{ __html: "try{var t=localStorage.getItem('pos-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}" }}
        />
      </head>
      <body>
        <a className="skip" href="#contenuto">Vai al contenuto</a>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
