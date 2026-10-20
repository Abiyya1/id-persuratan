import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pengelola Nomor Surat',
  description:
    'Penomoran surat tanpa duplikasi dengan sinkronisasi Google Sheets yang andal.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
