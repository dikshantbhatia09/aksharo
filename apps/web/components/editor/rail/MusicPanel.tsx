"use client";

import * as React from "react";

import {
  MusicPickerDrawer,
  type MusicPickerDrawerProps,
  type MusicTrackItem,
} from "../music-picker-drawer";

export { MusicPickerDrawer, type MusicPickerDrawerProps, type MusicTrackItem };

export function MusicPanel(props: MusicPickerDrawerProps): React.JSX.Element {
  return <MusicPickerDrawer {...props} />;
}

