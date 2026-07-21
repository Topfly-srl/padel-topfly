import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextVitals,
  ...nextTypescript,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "next-env.d.ts",
      // Client Prisma generato: file @ts-nocheck, non va lintato.
      "src/generated/**",
    ],
  },
];

export default eslintConfig;
