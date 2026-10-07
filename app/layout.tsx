import type { Metadata } from "next";
import { EXTENSION_ERROR_GUARD_SCRIPT } from "@/src/extensionErrorGuard";
import "./globals.css";

export const metadata: Metadata = {
  title: "舰装格局 · 二维飞船配装工具",
  description: "绘制飞船内部空间，创建装备模块，并通过拖拽完成配装。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head>
        <script
          id="frontier-extension-error-guard"
          dangerouslySetInnerHTML={{ __html: EXTENSION_ERROR_GUARD_SCRIPT }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
