import type { Metadata, Viewport } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Code Meeting Answerer",
  description: "Answer codebase questions live in meetings, with exact file and line sources. No login, nothing stored.",
  icons: { icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%231F6F5C'/><text x='16' y='22' font-family='monospace' font-size='16' font-weight='700' text-anchor='middle' fill='white'>?</text></svg>" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#F6F5F1" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
