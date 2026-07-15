import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chasing · 逃出校园",
  description: "轻量级浏览器校园追逐游戏。",
  openGraph: {
    title: "Chasing · 逃出校园",
    description: "穿过学校迷宫，躲开追捕者，跑向出口。",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "Chasing 逃出校园" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Chasing · 逃出校园",
    description: "穿过学校迷宫，躲开追捕者，跑向出口。",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
