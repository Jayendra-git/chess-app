/// <reference types="vite/client" />

// allow importing images and styles in TS files
declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.png' {
  const src: string
  export default src
}

declare module '*.css'
