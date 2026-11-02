/**
 * The worker's Python, embedded as text by the child bundle's `.py` loader
 * (`child-bundle.ts`).
 */
declare module "*.py" {
  const source: string;
  export default source;
}
