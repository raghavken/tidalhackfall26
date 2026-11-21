'use client';

// three.js procedural substation. Rebuilds the model when the target
// substation changes; every frame it reads the latest live sample (via a ref,
// no React re-render) to drive the glow and the 0.25 Hz sway.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { modelParams, SEVERITY_GLOW } from '../lib/substationModel.mjs';

const OSC_HZ = 0.25;
const MAT = {
  ground: new THREE.MeshStandardMaterial({ color: '#16211b', roughness: 1 }),
  gravel: new THREE.MeshStandardMaterial({ color: '#3a3f46', roughness: 0.95 }),
  steel: new THREE.MeshStandardMaterial({ color: '#8f9aa7', metalness: 0.6, roughness: 0.45 }),
  tower: new THREE.LineBasicMaterial({ color: '#9aa6b4' }),
  fence: new THREE.LineBasicMaterial({ color: '#56606c' }),
  transformer: new THREE.MeshStandardMaterial({ color: '#4c5664', metalness: 0.3, roughness: 0.6 }),
  insulator: new THREE.MeshStandardMaterial({ color: '#b9a48a', roughness: 0.7 }),
  house: new THREE.MeshStandardMaterial({ color: '#c8c2b4', roughness: 0.85 }),
  roof: new THREE.MeshStandardMaterial({ color: '#59606a', roughness: 0.8 }),
};

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
}

function cylinder(r, h, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), material);
  mesh.position.set(x, y, z);
  return mesh;
}

/** Lattice tower as line segments: 4 tapering legs + bracing + cross-arms. */
function latticeTower(height) {
  const base = height * 0.16;
  const top = height * 0.04;
  const points = [];
  const corner = (r, y) => [[-r, y, -r], [r, y, -r], [r, y, r], [-r, y, r]];
  const levels = 6;
  let previous = corner(base, 0);
  for (let i = 1; i <= levels; i++) {
    const y = height * i / levels;
    const ring = corner(base + (top - base) * i / levels, y);
    for (let k = 0; k < 4; k++) {
      points.push(previous[k], ring[k], ring[k], ring[(k + 1) % 4], previous[k], ring[(k + 1) % 4]);
    }
    previous = ring;
  }
  for (const [f, s] of [[0.72, 0.32], [0.86, 0.26]]) {     // cross-arms
    points.push([-height * s, height * f, 0], [height * s, height * f, 0]);
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p)));
  return new THREE.LineSegments(geometry, MAT.tower);
}

/** Sagging conductor (tube) between two points. */
function conductor(from, to, material, sag = 2.5) {
  const mid = from.clone().lerp(to, 0.5);
  mid.y -= sag;
  return new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(from, mid, to), 24, 0.09, 5),
    material);
}

function buildSubstation(params, glowMaterial, beaconMaterial) {
  const root = new THREE.Group();
  const sway = new THREE.Group(); // conductors + busbars: oscillate with the signal
  const { width: W, depth: D } = params.yard;

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(W * 6, D * 6), MAT.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  root.add(ground);
  const yard = new THREE.Mesh(new THREE.PlaneGeometry(W, D), MAT.gravel);
  yard.rotation.x = -Math.PI / 2;
  root.add(yard);

  // Fence: posts + two rails
  const fencePts = [];
  const corners = [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]];
  for (let i = 0; i < 4; i++) {
    const [a, b] = [corners[i], corners[(i + 1) % 4]];
    for (const h of [0.4, 2.4]) fencePts.push(new THREE.Vector3(a[0], h, a[1]), new THREE.Vector3(b[0], h, b[1]));
    const steps = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6));
    for (let s = 0; s < steps; s++) {
      const x = a[0] + (b[0] - a[0]) * s / steps;
      const z = a[1] + (b[1] - a[1]) * s / steps;
      fencePts.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 2.6, z));
    }
  }
  root.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(fencePts), MAT.fence));

  // Bays: one per voltage level, spread across the yard depth
  const bayCount = params.bays.length;
  params.bays.forEach((bay, i) => {
    const z = -D / 2 + D * (i + 1) / (bayCount + 1);
    const span = W * 0.7;
    const h = bay.height;
    root.add(box(0.6, h, 0.6, MAT.steel, -span / 2, h / 2, z));      // gantry posts + beam
    root.add(box(0.6, h, 0.6, MAT.steel, span / 2, h / 2, z));
    root.add(box(span, 0.6, 0.6, MAT.steel, 0, h, z));
    for (const dz of [-1.6, 0, 1.6]) {                               // 3-phase busbars (glowing)
      const bus = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, span * 0.96, 8), glowMaterial);
      bus.rotation.z = Math.PI / 2;
      bus.position.set(0, h * 0.82, z + dz);
      sway.add(bus);
    }
    const breakers = Math.max(1, Math.round(params.breakers / bayCount));
    for (let b = 0; b < breakers; b++) {                             // breakers + insulators
      const x = -span / 2 + span * (b + 1) / (breakers + 1);
      root.add(cylinder(0.7, 2.2, MAT.steel, x, 1.1, z + 3.5));
      root.add(cylinder(0.25, 2.4, MAT.insulator, x, 3.4, z + 3.5));
    }
    for (let t = 0; t < bay.towers; t++) {                           // incoming line(s)
      const towerH = h * 2.1;
      const tx = (t - (bay.towers - 1) / 2) * span * 0.5;
      const tz = z + bay.side * (D / 2 + 28 + t * 4);
      const tower = latticeTower(towerH);
      tower.position.set(tx, 0, tz);
      root.add(tower);
      for (const dx of [-towerH * 0.25, 0, towerH * 0.25]) {
        sway.add(conductor(new THREE.Vector3(tx + dx, towerH * 0.72, tz),
          new THREE.Vector3(dx * 0.6, h * 0.82, z), glowMaterial, 3));
      }
    }
  });

  // Transformers in a row across the yard front
  for (let i = 0; i < params.transformers; i++) {
    const x = -W * 0.25 + (W * 0.5) * (params.transformers === 1 ? 0.5 : i / (params.transformers - 1));
    const t = new THREE.Group();
    t.add(box(7, 5, 4.5, MAT.transformer, 0, 2.5, 0));
    for (let f = -2; f <= 2; f++) t.add(box(0.25, 3.5, 5.5, MAT.transformer, f * 1.3, 2.4, 0)); // radiator fins
    for (const bx of [-2, 0, 2]) t.add(cylinder(0.25, 2.6, MAT.insulator, bx, 6.2, 0));         // bushings
    t.position.set(x, 0, D * 0.3);
    root.add(t);
  }

  // Control house with a beacon (FPGA verdict)
  const hx = -W / 2 + 10;
  const hz = D / 2 - 8;
  root.add(box(14, 4, 8, MAT.house, hx, 2, hz));
  root.add(box(14.6, 0.5, 8.6, MAT.roof, hx, 4.25, hz));
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 12), beaconMaterial);
  beacon.position.set(hx + 4, 5.4, hz);
  root.add(beacon);

  root.add(sway);
  return { root, sway, radius: Math.max(W, D) };
}

function disposeTree(object) {
  object.traverse(node => node.geometry?.dispose?.());
}

/**
 * target: { key, kind: 'station'|'preview', stationIndex, substation }
 * severity: requested severity for the station (or 'preview')
 * amplitudeMhz: oscillation amplitude for that severity
 * verdict: 'alarm' | 'clear' | null
 * latest: ref to the latest live sample
 */
export default function SubstationScene({ target, severity, amplitudeMhz, verdict, latest }) {
  const container = useRef(null);
  const view = useRef(null);
  const props = useRef({});
  props.current = { target, severity, amplitudeMhz, verdict };

  // Renderer, camera, controls and animation loop: created once
  useEffect(() => {
    const host = container.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b1420');
    scene.fog = new THREE.Fog('#0b1420', 250, 900);
    scene.add(new THREE.HemisphereLight('#cfe1ff', '#1a2418', 1.1));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(120, 200, 80);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 1, 3000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    controls.maxPolarAngle = Math.PI * 0.47;
    let idleTimer;
    controls.addEventListener('start', () => { controls.autoRotate = false; clearTimeout(idleTimer); });
    controls.addEventListener('end', () => {
      idleTimer = setTimeout(() => { controls.autoRotate = true; }, 8000);
    });

    const glowMaterial = new THREE.MeshStandardMaterial({ color: '#2a313b', emissive: '#e8eef6',
      emissiveIntensity: 0.4, metalness: 0.3, roughness: 0.5 });
    const beaconMaterial = new THREE.MeshStandardMaterial({ color: '#333a44', emissive: '#555c66',
      emissiveIntensity: 0.4 });
    view.current = { renderer, scene, camera, controls, glowMaterial, beaconMaterial, model: null };

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      if (document.hidden) return; // pause while the tab is hidden
      const t = clock.getElapsedTime();
      const { target: tg, severity: sev, amplitudeMhz: amp, verdict: vd } = props.current;
      const live = tg?.kind === 'station' ? latest.current?.deviation_mhz?.[tg.stationIndex] : null;
      glowMaterial.emissive.set(SEVERITY_GLOW[tg?.kind === 'preview' ? 'preview' : sev] || SEVERITY_GLOW.normal);
      glowMaterial.emissiveIntensity = live == null ? 0.35 : 0.3 + Math.min(1, Math.abs(live) / 30) * 1.7;
      const model = view.current.model;
      if (model) {
        const strength = tg?.kind === 'station' ? Math.min(1, (amp || 0) / 30) : 0;
        const wave = Math.sin(2 * Math.PI * OSC_HZ * t);
        model.sway.position.y = wave * 0.9 * strength;
        model.sway.rotation.x = wave * 0.006 * strength;
      }
      if (vd === 'alarm') {
        beaconMaterial.emissive.set('#ff3030');
        beaconMaterial.emissiveIntensity = 1.2 + Math.sin(t * 6) * 0.8;
      } else if (vd === 'clear') {
        beaconMaterial.emissive.set('#36d67a');
        beaconMaterial.emissiveIntensity = 1.1;
      } else {
        beaconMaterial.emissive.set('#555c66');
        beaconMaterial.emissiveIntensity = 0.4;
      }
      controls.update();
      renderer.render(scene, camera);
    });

    const resize = new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = host;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    resize.observe(host);

    return () => {
      clearTimeout(idleTimer);
      resize.disconnect();
      renderer.setAnimationLoop(null);
      if (view.current.model) disposeTree(view.current.model.root);
      glowMaterial.dispose();
      beaconMaterial.dispose();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      view.current = null;
    };
  }, [latest]);

  // Rebuild the model when the substation changes
  const key = target?.key ?? 'none';
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (v.model) {
      v.scene.remove(v.model.root);
      disposeTree(v.model.root);
    }
    const model = buildSubstation(modelParams(target?.substation ?? null), v.glowMaterial, v.beaconMaterial);
    v.scene.add(model.root);
    v.model = model;
    const r = model.radius;
    v.camera.position.set(r * 1.05, r * 0.75, r * 1.25);
    v.controls.target.set(0, 6, 0);
    v.controls.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return <div ref={container} className="scene" role="img"
    aria-label={`3D model of ${target?.substation?.name || 'a generic substation'}`} />;
}
