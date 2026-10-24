import { createContext, useContext, type ReactNode } from "react";
import {
  resolveSiteConfig,
  toClientSiteConfig,
  type ClientSiteConfig,
} from "@doxahq/site-config";

const SiteConfigContext = createContext<ClientSiteConfig>(
  toClientSiteConfig(resolveSiteConfig({}))
);

export function SiteConfigProvider({
  config,
  children,
}: {
  config: ClientSiteConfig;
  children: ReactNode;
}) {
  return (
    <SiteConfigContext.Provider value={config}>
      {children}
    </SiteConfigContext.Provider>
  );
}

export function useSiteConfig(): ClientSiteConfig {
  return useContext(SiteConfigContext);
}
