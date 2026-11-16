import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // noUncheckedIndexedAccess makes fixed-size tuple/index reads optional; `!` is the intended escape hatch.
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
