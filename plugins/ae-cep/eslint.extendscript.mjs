// A dedicated, minimal ESLint config for `src/jsx/*.jsx` — ExtendScript, not React JSX (the
// `.jsx` extension is CEP/Adobe convention for ExtendScript host files, e.g. the
// `ScriptPath` entry in `CSXS/manifest.xml`; there is no React here).
//
// ExtendScript is ES3-based (Adobe's own docs: "based on JavaScript (ECMA-262 edition 3)",
// https://ae-scripting.docsforadobe.dev/). ESLint has no built-in "ecmaVersion 3" parser
// target, so this config approximates the ES3 subset the brief asks for
// ("small ExtendScript-compatible ES3 subset... with a lint config that forbids ES5+
// features") two ways: `parserOptions.ecmaVersion: 5` (rejects ES6+ syntax outright — arrow
// functions, let/const, classes, template literals, destructuring, spread/rest, for-of) plus
// `no-restricted-syntax` for the handful of ES5-only *additions* over ES3 that are still valid
// ES5 syntax (`Array.prototype.forEach/map/filter/reduce`, `Object.keys`, `JSON.parse`/
// `stringify` are actually fine — CEP's ExtendScript engine polyfills `JSON`, see
// `aksharo.jsx`'s own use of it — but `Array.prototype.forEach` et al are NOT polyfilled and
// silently fail on ExtendScript's real (non-V8) engine, hence they're the ones actually banned
// below rather than a blanket "no ES5").
import globals from "globals";

export default [
  {
    files: ["src/jsx/**/*.jsx"],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: "script",
      globals: {
        ...globals.es3,
        // ExtendScript/CEP host globals used by aksharo.jsx (not browser/node globals).
        app: "readonly",
        $: "readonly",
        File: "readonly",
        Folder: "readonly",
        CompItem: "readonly",
        ImportOptions: "readonly",
        MarkerValue: "readonly",
        JSON: "readonly",
      },
    },
    rules: {
      "no-var": "off",
      "prefer-const": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name=/^(forEach|map|filter|reduce|reduceRight|some|every|indexOf|lastIndexOf)$/]",
          message:
            "Array.prototype.forEach/map/filter/... is ES5 and not reliably available in ExtendScript's ES3 engine — use a plain indexed for loop instead.",
        },
        {
          selector: "CallExpression[callee.object.name='Object'][callee.property.name='keys']",
          message: "Object.keys is ES5 — use a for-in loop with hasOwnProperty instead.",
        },
        {
          selector: "FunctionExpression[params.length>0] > AssignmentPattern",
          message: "Default parameters are ES6 — not valid in ExtendScript.",
        },
      ],
    },
  },
];
