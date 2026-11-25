export const metadata = {
  title: "Purchasing Agent MCP Server",
  description: "Read-only MCP server for an AI purchasing agent team (fictional data)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "48px auto", padding: "0 20px", lineHeight: 1.6 }}>
        {children}
      </body>
    </html>
  );
}
