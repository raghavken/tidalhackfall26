import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

export const metadata = {
  title: 'Oscillation Cartographer',
  description: 'Live PMU monitor with grid map, 3D substations, FPGA diagnosis and Nemotron analysis',
};

export default function Layout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
