"use client";

/**
 * Settings > Notifications (2026-09-29): "Notify me on this device".
 *
 * Turning it on is the only thing that ever asks the browser for permission,
 * and only on the click: a prompt nobody asked for is how a site gets blocked
 * for good. It then registers the service worker (`public/sw.js`), subscribes
 * this browser with the deployment's key, and hands the subscription to the
 * API; turning it off undoes both. On every visit an existing subscription is
 * sent again, so the API's copy follows the browser's (the endpoint can change
 * under it), and one made with an old key is dropped rather than left dead.
 */
import * as React from "react";

import {
  useDeletePushSubscription,
  usePushPublicKey,
  useSavePushSubscription,
} from "@montaj/api-client";
import { BRAND } from "@montaj/config";
import { Card } from "@montaj/ui";

import { ConsentToggle } from "@/components/auth/age-consent-step";
import { SettingsSection } from "@/components/settings/section";
import {
  currentSubscription,
  pushSupported,
  subscribeThisBrowser,
  subscribedWith,
  subscriptionBody,
} from "@/lib/push/browser-push";

type DeviceState = "checking" | "unsupported" | "unavailable" | "denied" | "off" | "on";

const STATE_NOTE: Readonly<Partial<Record<DeviceState, string>>> = Object.freeze({
  // Not a promise about iPhones: Safari there only notifies an installed web
  // app, which needs a manifest this app does not have yet.
  unsupported: `This browser cannot show notifications from ${BRAND.name}. Chrome, Edge or Firefox on a computer, or Chrome on Android, can.`,
  unavailable: "Notifications on devices are not switched on for this account yet.",
  denied:
    "Notifications are blocked for this site in your browser's settings. Allow them there, then turn this on.",
});

export function NotificationsView(): React.JSX.Element {
  const key = usePushPublicKey();
  const save = useSavePushSubscription();
  const remove = useDeletePushSubscription();
  const [state, setState] = React.useState<DeviceState>("checking");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const publicKey = key.data?.publicKey ?? null;
  const keyLoaded = key.isSuccess;
  const { mutate: resync } = save;

  // Where this browser stands, once the key is known. Never asks for anything.
  React.useEffect(() => {
    if (!keyLoaded) return;
    if (!pushSupported()) {
      setState("unsupported");
      return;
    }
    if (publicKey === null) {
      setState("unavailable");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const subscription = await currentSubscription();
        if (cancelled) return;
        if (subscription === null || Notification.permission !== "granted") {
          setState("off");
          return;
        }
        if (!subscribedWith(subscription, publicKey)) {
          // Made with a key this deployment no longer signs with: it can
          // never be delivered to, so it goes rather than looking "on".
          await subscription.unsubscribe();
          if (!cancelled) setState("off");
          return;
        }
        resync(subscriptionBody(subscription));
        setState("on");
      } catch {
        if (!cancelled) setState("off");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keyLoaded, publicKey, resync]);

  const turnOn = async (): Promise<void> => {
    if (publicKey === null) return;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setState(permission === "denied" ? "denied" : "off");
      return;
    }
    const subscription = await subscribeThisBrowser(publicKey);
    await save.mutateAsync(subscriptionBody(subscription));
    setState("on");
  };

  const turnOff = async (): Promise<void> => {
    const subscription = await currentSubscription();
    if (subscription !== null) {
      // The server's copy first: a browser that unsubscribed but whose row
      // stayed would only be found out by the next failed delivery.
      await remove.mutateAsync(subscription.endpoint).catch(() => undefined);
      await subscription.unsubscribe();
    }
    setState("off");
  };

  const change = (on: boolean): void => {
    setError(null);
    setBusy(true);
    void (on ? turnOn() : turnOff())
      .catch(() => {
        setError(
          on
            ? "We could not turn notifications on in this browser. Try again in a moment."
            : "We could not turn notifications off in this browser. Try again in a moment.",
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  // eslint-disable-next-line security/detect-object-injection -- a DeviceState literal
  const note = STATE_NOTE[state];
  const switchable = state === "on" || state === "off";

  return (
    <SettingsSection
      title="Notifications"
      description="What we tell you, and where."
      testId="settings-notifications"
    >
      <Card className="flex flex-col gap-4">
        <h2 className="text-fg-0 text-base font-semibold">On this device</h2>
        <ConsentToggle
          id="settings-push-device"
          label="Notify me on this device"
          description="We tell this browser when your clips are ready, when a video is finished or has stopped, and when a video needs something from you, even with this tab closed. Nothing else."
          checked={state === "on"}
          disabled={!switchable || busy}
          onChange={change}
        />
        {note === undefined ? null : (
          <p className="text-fg-2 m-0 text-xs" data-testid="push-device-note">
            {note}
          </p>
        )}
        {error === null ? null : (
          <p className="text-fg-1 m-0 text-xs" role="alert" data-testid="push-device-error">
            {error}
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-2">
        <h2 className="text-fg-0 text-base font-semibold">In the app</h2>
        <p className="text-fg-2 text-sm">
          The bell at the top of every page keeps each of these, so nothing is lost if you were away
          when it arrived.
        </p>
        <p className="text-fg-2 text-sm">
          Emails about your account itself (confirming your address, sign-in links, approving a
          device) are always sent. Product emails are a separate choice, under Privacy.
        </p>
      </Card>
    </SettingsSection>
  );
}
