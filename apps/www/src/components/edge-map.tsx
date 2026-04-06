"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import createGlobe from "cobe";

// Edge node locations [lat, lng] with stagger groups for ripple
const markers = [
  { location: [40.71, -74.01] as [number, number], size: 0.06, group: 0 },   // US East (origin)
  { location: [37.78, -122.41] as [number, number], size: 0.06, group: 1 },  // US West
  { location: [19.43, -99.13] as [number, number], size: 0.04, group: 1 },   // Mexico City
  { location: [-23.55, -46.63] as [number, number], size: 0.05, group: 2 },  // São Paulo
  { location: [51.51, -0.13] as [number, number], size: 0.06, group: 2 },    // London
  { location: [48.86, 2.35] as [number, number], size: 0.05, group: 2 },     // Paris
  { location: [50.11, 8.68] as [number, number], size: 0.06, group: 3 },     // Frankfurt
  { location: [59.33, 18.07] as [number, number], size: 0.04, group: 3 },    // Stockholm
  { location: [60.17, 24.94] as [number, number], size: 0.04, group: 3 },    // Helsinki
  { location: [-33.93, 18.42] as [number, number], size: 0.04, group: 3 },   // Cape Town
  { location: [25.20, 55.27] as [number, number], size: 0.05, group: 4 },    // Dubai
  { location: [19.08, 72.88] as [number, number], size: 0.05, group: 4 },    // Mumbai
  { location: [1.35, 103.82] as [number, number], size: 0.05, group: 5 },    // Singapore
  { location: [35.68, 139.69] as [number, number], size: 0.06, group: 5 },   // Tokyo
  { location: [37.57, 126.98] as [number, number], size: 0.05, group: 5 },   // Seoul
  { location: [-33.87, 151.21] as [number, number], size: 0.05, group: 6 },  // Sydney
];

const TOTAL_GROUPS = 7;
const RIPPLE_INTERVAL = 200; // ms between groups

export function EdgeMap({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const globeRef = useRef<ReturnType<typeof createGlobe> | null>(null);
  const phiRef = useRef(0);
  const activeRef = useRef(active);
  const activatedGroupRef = useRef(-1);
  const activationStartRef = useRef<number | null>(null);

  activeRef.current = active;

  // Track when active first becomes true
  useEffect(() => {
    if (active && activationStartRef.current === null) {
      activationStartRef.current = performance.now();
    }
  }, [active]);

  // Animation loop
  useEffect(() => {
    let frameId: number;

    const animate = () => {
      if (!globeRef.current) {
        frameId = requestAnimationFrame(animate);
        return;
      }

      phiRef.current += 0.003;

      // Ripple: activate groups over time
      if (activeRef.current && activationStartRef.current !== null) {
        const elapsed = performance.now() - activationStartRef.current;
        activatedGroupRef.current = Math.min(
          Math.floor(elapsed / RIPPLE_INTERVAL),
          TOTAL_GROUPS - 1
        );
      }

      globeRef.current.update({
        phi: phiRef.current,
        markers: markers.map((m) => {
          const visible = m.group <= activatedGroupRef.current;
          // Pulse: markers briefly grow when their group just activated
          const justActivated =
            activationStartRef.current !== null &&
            Math.abs(
              performance.now() -
                activationStartRef.current -
                m.group * RIPPLE_INTERVAL
            ) < 400;
          const pulse = justActivated ? 1.6 : 1;
          return {
            location: m.location,
            size: visible ? m.size * pulse : 0,
          };
        }),
      });

      frameId = requestAnimationFrame(animate);
    };

    frameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameId);
  }, []);

  // Create globe
  useEffect(() => {
    if (!canvasRef.current) return;

    const width = canvasRef.current.offsetWidth;

    const globe = createGlobe(canvasRef.current, {
      devicePixelRatio: 2,
      width: width * 2,
      height: width * 2,
      phi: 0,
      theta: 0.25,
      dark: 1,
      diffuse: 1.2,
      mapSamples: 16000,
      mapBrightness: 2.5,
      baseColor: [0.15, 0.15, 0.18],
      markerColor: [0.35, 0.83, 0.9],
      glowColor: [0.08, 0.08, 0.1],
      markers: [],
    });

    globeRef.current = globe;

    const onResize = () => {
      if (!canvasRef.current) return;
      const w = canvasRef.current.offsetWidth;
      globe.update({ width: w * 2, height: w * 2 });
    };
    window.addEventListener("resize", onResize);

    return () => {
      globe.destroy();
      globeRef.current = null;
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div className="relative w-full max-w-[400px] aspect-square">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ contain: "layout paint size" }}
      />
      {/* Ripple glow that expands when deploying */}
      <AnimatePresence>
        {active && (
          <motion.div
            initial={{ opacity: 0, scale: 0.3 }}
            animate={{ opacity: 1, scale: 0.75 }}
            transition={{ duration: 1.5, ease: "easeOut" }}
            className="absolute inset-0 -z-10 rounded-full bg-accent/[0.06] blur-3xl"
          />
        )}
      </AnimatePresence>
      {/* Deploy count badge */}
      <AnimatePresence>
        {active && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: (TOTAL_GROUPS * RIPPLE_INTERVAL) / 1000, duration: 0.4 }}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-accent/30 bg-background/80 backdrop-blur-sm px-3 py-1"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            <span className="text-[11px] font-mono text-accent">
              300+ edge locations
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
