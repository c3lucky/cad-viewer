import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  base: "/cad-viewer-admin/",
  plugins: [vue()],
});
