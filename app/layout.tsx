import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://chasing-school-escape.gavingao.chatgpt.site"),
  title: "Chasing · 3D 主题逃生战役",
  description: "10 关电影化 3D 潜逃战役：穿越校园、医院、消防站与工厂，断开视线、藏进主题柜并逃出生天。",
  openGraph: {
    title: "Chasing · 3D 主题逃生战役",
    description: "校园、医院、消防站、工厂四大主题；切断追捕者视线，藏好，再冲向出口。",
    images: [{
      url: "/chasing-social-card.jpg",
      width: 1200,
      height: 630,
      alt: "玩家穿过校园与工厂主题迷宫，避开正在搜索的追捕者",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Chasing · 3D 主题逃生战役",
    description: "10 关四主题 3D 潜逃：断开视线、藏好、再冲向出口。",
    images: ["/chasing-social-card.jpg"],
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
