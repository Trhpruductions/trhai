/// <reference types="vite/client" />

declare global {
  interface Window {
    ascendDesktop?: {
      appName: string;
      version: string;
      createWorkspaceScaffold?: (payload: {
        request: string;
        spec: {
          kind: string;
          path: string;
          fileName: string;
          content: string;
        };
      }) => Promise<{
        ok?: boolean;
        created?: boolean;
        path?: string;
        message?: string;
        error?: string;
      }>;
    };
  }
}

export {};
