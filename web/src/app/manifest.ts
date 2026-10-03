import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "VYNTRA Estacion de Marcaje",
    short_name: "VYNTRA",
    description: "Estacion web para registro de jornada laboral.",
    start_url: "/estacion",
    display: "standalone",
    background_color: "#f5f7fa",
    theme_color: "#2b5ce6",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "48x48",
        type: "image/x-icon",
      },
      {
        src: "/brand/vyntra-icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/brand/vyntra-icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
