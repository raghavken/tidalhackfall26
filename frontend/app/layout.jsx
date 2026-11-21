import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

export const metadata = {
  title: 'GridSent',
  description: 'Power grid oscillation analysis: simulated PMU telemetry, FPGA detection and diagnostics',
};

export default function Layout({ children }) {
  return <html lang="en"><body>{children}</body></html>;
}
