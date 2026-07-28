import type { DesktopAPI } from "../shared/ipc.js";

declare global {
  interface Window {
    api: DesktopAPI;
  }
}

declare module "*.png" {
  const url: string;
  export default url;
}

export {};
