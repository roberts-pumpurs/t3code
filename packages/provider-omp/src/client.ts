import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OmpSettings } from "./settings.ts";

export const ompClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("omp"),
  label: "Oh My Pi",
  settingsSchema: OmpSettings,
  // The pi glyph with a plug from the oh-my-pi repository's assets/icon.svg.
  icon: {
    viewBox: "0 -15 120 120",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      { d: "M10 8H110V20H10ZM25 20H37V82H25ZM75 20H87V55H75Z" },
      {
        d: "M71 55H91V71H71ZM76 59V67H79V59ZM82 59V67H85V59Z",
        fillRule: "evenodd",
        fill: { light: "#F97316", dark: "#F97316" },
      },
    ],
  },
});
