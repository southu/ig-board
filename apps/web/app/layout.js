export const metadata = {
  title: 'Boardroom — The Image Group',
  description: 'Private governance BI for The Image Group board.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
