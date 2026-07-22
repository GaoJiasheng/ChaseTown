import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://chasing-school-escape.gavingao.chatgpt.site"),
  title: "Chasing · 逃出校园",
  description: "电影化 3D 校园潜逃游戏：断开视线、藏进储物柜、判断时机并逃向警察。",
  openGraph: {
    title: "Chasing · 逃出校园",
    description: "断开追捕者视线，藏进储物柜，判断时机并逃向警察。",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "Chasing 逃出校园" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Chasing · 逃出校园",
    description: "断开追捕者视线，藏进储物柜，判断时机并逃向警察。",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body>{children}</body>
    </html>
  );
}
