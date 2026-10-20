import type { Metadata, Viewport } from "next";
import { Geist, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: "italic", variable: "--font-serif" });

export const metadata: Metadata = {
  title: "Code Meeting Answerer",
  description: "Answer codebase questions live in meetings, with exact file and line sources. No login, nothing stored.",
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='9' fill='%233DDC97'/><path d='M12 11l-5 5 5 5M20 11l5 5-5 5' stroke='%2303140c' stroke-width='2.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>",
  },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0a0c0d" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${sans.variable} ${mono.variable} ${serif.variable}`} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
