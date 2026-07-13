/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{vue,js}"],
  theme: {
    extend: {
      colors: {
        ink: "#17202a",
        muted: "#5d6977",
        line: "#d9e0e7",
        panel: "#ffffff",
        canvas: "#f5f7f9",
        accent: "#0a6ea8",
      },
    },
  },
  plugins: [],
};
