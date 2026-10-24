import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard is also opened from the host's local virtual-network address.
  // Next 16 requires this host for dev scripts and the HMR websocket.
  allowedDevOrigins: ['172.31.208.1'],
  // jsPDF (+ autotable) generates the Buying Plan month report on the server (cron +
  // admin action). Its Node build must be required at runtime, not bundled — bundling
  // trips over its optional browser-only peers (canvas, html2canvas, dompurify).
  serverExternalPackages: ["jspdf", "jspdf-autotable"],
};

export default nextConfig;
