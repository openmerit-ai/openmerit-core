import type { Metadata } from "next";
import { Gabarito } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const gabarito = Gabarito({
  subsets: ["latin"],
  variable: "--font-gabarito",
});

export const metadata: Metadata = {
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
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={gabarito.variable}>
      <body>{children}</body>
    </html>
  );
}
