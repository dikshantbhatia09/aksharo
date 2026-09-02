/**
 * Native application menu (brief §5): standard roles per platform, plus an
 * "Aksharo" app menu on macOS.
 */
import { Menu, type MenuItemConstructorOptions, app, shell } from "electron";

import { BRAND } from "@montaj/config/brand";

import { isOpenExternalAllowed } from "../security/allowlist.js";

export function buildAppMenu(openSupportUrl: string): Menu {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [isMac ? { role: "close" as const } : { role: "quit" as const }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" as const },
        { role: "redo" as const },
        { type: "separator" as const },
        { role: "cut" as const },
        { role: "copy" as const },
        { role: "paste" as const },
        { role: "selectAll" as const },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" as const },
        { role: "toggleDevTools" as const },
        { type: "separator" as const },
        { role: "resetZoom" as const },
        { role: "zoomIn" as const },
        { role: "zoomOut" as const },
        { type: "separator" as const },
        { role: "togglefullscreen" as const },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" as const }, { role: "zoom" as const }],
    },
    {
      label: "Help",
      submenu: [
        {
          label: `${BRAND.name} Support`,
          click: () => {
            if (isOpenExternalAllowed(openSupportUrl)) void shell.openExternal(openSupportUrl);
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
