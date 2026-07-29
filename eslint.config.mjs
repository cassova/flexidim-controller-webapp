import next from "eslint-config-next";

// eslint-config-next ships a flat-config array in Next 16, so it is spread
// directly rather than going through the FlatCompat shim.
const config = [
  { ignores: [".next/**", "node_modules/**", "work/**", "next-env.d.ts"] },
  ...next,
];

export default config;
