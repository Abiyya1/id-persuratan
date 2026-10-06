import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Document Labeling & ID Management',
  description:
    'Atomic document numbering with resilient Google Sheets sync.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
