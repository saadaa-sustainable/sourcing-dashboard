import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // jsPDF (+ autotable) generates the Buying Plan month report on the server (cron +
  // admin action). Its Node build must be required at runtime, not bundled — bundling
  // trips over its optional browser-only peers (canvas, html2canvas, dompurify).
  serverExternalPackages: ["jspdf", "jspdf-autotable"],
};

export default nextConfig;
