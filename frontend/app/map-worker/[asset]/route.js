import { readFile } from 'node:fs/promises';
import path from 'node:path';

const assets = new Set(['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']);

export async function GET(_request, { params }) {
  const { asset } = await params;
  if (!assets.has(asset)) return new Response(null, { status: 404 });
  const script = await readFile(path.join(process.cwd(), 'node_modules', 'maplibre-gl', 'dist', asset));
  return new Response(script, {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
  });
}
