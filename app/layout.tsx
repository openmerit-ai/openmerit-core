import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://openmerit.lazim.chatgpt.site"),
  title: "OpenMerit — Intelligence control plane for autonomous agents",
  description:
    "Open-source control infrastructure that keeps every agent role on the best known qualified inference configuration.",
  applicationName: "OpenMerit",
  keywords: [
    "AI agents",
    "inference",
    "model evaluation",
    "control plane",
    "open source",
  ],
  alternates: {
    canonical: "/",
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
