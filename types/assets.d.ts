// Static assets are inlined as text by the bundle; the DSH client loader has no
// asset pipeline of its own.
declare module '*.css' {
  const content: string;
  export default content;
}
