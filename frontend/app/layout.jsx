import './style.css';

export const metadata = { title: 'Oscillation Cartographer', description: 'Live PMU and DE1 detector dashboard' };

export default function Layout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
