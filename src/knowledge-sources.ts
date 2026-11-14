export const sourceNames = ["fivem", "kq_link", "ox_lib", "oxmysql", "qbx", "qbcore", "esx"] as const;
export type SourceName = typeof sourceNames[number];

export const sources: Record<SourceName, { title: string; url: string }> = {
  fivem: { title: "FiveM documentation and native reference", url: "https://docs.fivem.net/" },
  kq_link: { title: "KuzQuality KQ Link docs and installed resource", url: "https://docs.kuzquality.com/kq-link/kq-link-or-installation-guide" },
  ox_lib: { title: "Overextended ox_lib", url: "https://overextended.dev/docs/ox_lib" },
  oxmysql: { title: "Overextended oxmysql", url: "https://overextended.dev/docs/oxmysql" },
  qbx: { title: "Qbox / qbx_core", url: "https://docs.qbox.re/" },
  qbcore: { title: "QBCore for FiveM", url: "https://github.com/qbcore-framework/qb-docs" },
  esx: { title: "ESX Legacy", url: "https://docs.esx-framework.org/en" },
};

export type Document = {
  id: string;
  title: string;
  text: string;
  kind: "guide" | "native" | "local_source";
  url?: string;
  path?: string;
  revision?: string;
  apiSet?: "client" | "server" | "shared";
  keywords?: string;
};

export type Snapshot = { version: 1; updated: string; documents: Document[] };
