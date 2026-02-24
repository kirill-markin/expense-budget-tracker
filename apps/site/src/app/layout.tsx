import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Expense Budget Tracker",
  description: "Open-source personal finance tracker",
};

export default function RootLayout(props: Readonly<{ children: React.ReactNode }>) {
  const { children } = props;

  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
