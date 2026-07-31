import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });

// Next doesn't apply basePath to metadata icon/manifest URLs, so prefix them
// ourselves (same env next.config uses). "/" collapses to "" for root sites.
const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const basePath = rawBasePath === "/" ? "" : rawBasePath.replace(/\/$/, "");

export const metadata: Metadata = {
  title: "Vidu Kadhu",
  description: "It's not him. The ultimate Telugu party game.",
  manifest: `${basePath}/manifest.json`,
  icons: { icon: `${basePath}/icon.svg` },
};

export const viewport: Viewport = {
  themeColor: "#FF7A00",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={geist.variable}>{children}</body>
    </html>
  );
}