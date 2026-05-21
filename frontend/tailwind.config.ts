import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Sunrise design tokens (mirror :root CSS vars in globals.css)
        sky: {
          deep: "#050913",
          mid:  "#0e1428",
        },
        ink: {
          DEFAULT: "#f6f7fb",
          soft:    "rgb(246 247 251 / 0.78)",
          mute:    "rgb(246 247 251 / 0.55)",
          faint:   "rgb(246 247 251 / 0.32)",
        },
        cream: "#FFE9C8",
        honey: "#FFD08A",
        amber: "#FFB36A",
        coral: "#FF8A52",
        state: {
          open:      "#46d391",
          submitted: "#FFD66A",
          review:    "#66D8D0",
          paid:      "#6cd9a8",
          expired:   "#93A2B8",
        },
        tag: {
          content: "#46d391",
          dev:     "#7AB8FF",
          design:  "#FF9477",
          data:    "#66D8D0",
          other:   "#93A2B8",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["var(--font-jbmono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      backdropBlur: {
        glass: "22px",
      },
      boxShadow: {
        glass: "inset 0 1px 0 rgba(255,255,255,0.10), 0 8px 28px rgba(0,0,0,0.22)",
        "glass-cta": "inset 0 1px 0 rgba(255,255,255,0.30), 0 8px 28px rgba(255,140,80,0.28)",
        "glass-nav": "inset 0 1px 0 rgba(255,255,255,0.10), 0 12px 40px rgba(0,0,0,0.35)",
      },
    },
  },
  plugins: [],
};
export default config;
