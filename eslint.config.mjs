import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "security-reports/**", "integrations/ironedge/patch/**", "public/sw.js"] },
  {
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "react/no-danger": "error",
    },
  },
];

export default config;
