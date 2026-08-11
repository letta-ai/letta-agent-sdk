import type { Metadata } from "next";
import "@/styles/globals.css";
import "@/styles/tokens.css";

export const metadata: Metadata = {
  title: "Letta Agent SDK chat",
  description: "A teaching project for a persistent Agent SDK chat interface",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
