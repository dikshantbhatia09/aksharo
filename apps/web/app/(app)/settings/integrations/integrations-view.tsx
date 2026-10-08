"use client";

import {
  Layers,
  Radio,
  RefreshCw,
  Video,
} from "lucide-react";
import * as React from "react";

import {
  useConnectZoomOAuth,
  useDisconnectZoom,
  useImportGoogleMeet,
  useImportRiverside,
  useImportZoomMeeting,
  useUpdateZoomSettings,
  useWorkspaceId,
  useZoomAuthorizeUrl,
  useZoomEvents,
  useZoomIntegration,
  type RiversideStudioTrack,
} from "@montaj/api-client";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmAction,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  Skeleton,
  toast,
} from "@montaj/ui";

import { SettingsGroup, SettingsSection } from "@/components/settings/section";

export function IntegrationsView(): React.JSX.Element {
  return (
    <SettingsSection
      title="Meeting & Studio Connectors"
      description="Connect Zoom Cloud, Riverside.fm, and Google Meet for automatic cloud recording ingestion, multi-speaker track separation, and immediate clips generation."
      testId="settings-integrations"
    >
      <ZoomIntegrationCard />
      <RiversideStudioCard />
      <GoogleMeetCard />
      <RecentEventsLedgerCard />
    </SettingsSection>
  );
}

// -----------------------------------------------------------------------------
// Zoom Cloud Connector
// -----------------------------------------------------------------------------

function ZoomIntegrationCard(): React.JSX.Element {
  const { data: integration, isLoading } = useZoomIntegration();
  const updateSettings = useUpdateZoomSettings();
  const disconnect = useDisconnectZoom();
  const getAuthUrl = useZoomAuthorizeUrl();
  const importManual = useImportZoomMeeting();

  const [autoRepurpose, setAutoRepurpose] = React.useState(true);
  const [minDurationMin, setMinDurationMin] = React.useState(10);
  const [nameFilter, setNameFilter] = React.useState("");
  const [manualMeetingId, setManualMeetingId] = React.useState("");
  const [manualTopic, setManualTopic] = React.useState("");
  const [isManualOpen, setIsManualOpen] = React.useState(false);

  const isConnected =
    !!integration &&
    !("connected" in integration && (integration as { connected?: boolean }).connected === false);

  React.useEffect(() => {
    if (isConnected && "autoRepurpose" in integration) {
      setAutoRepurpose(integration.autoRepurpose ?? true);
      setMinDurationMin(Math.round((integration.minDurationSec ?? 600) / 60));
      setNameFilter(integration.nameFilter ?? "");
    }
  }, [integration, isConnected]);

  const handleSaveSettings = async () => {
    try {
      await updateSettings.mutateAsync({
        autoRepurpose,
        minDurationSec: minDurationMin * 60,
        nameFilter: nameFilter.trim() || undefined,
      });
      toast.success("Zoom ingestion settings updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update Zoom settings");
    }
  };

  const handleConnect = async () => {
    try {
      const res = await getAuthUrl.mutateAsync();
      if (res?.url) {
        window.location.href = res.url;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start Zoom connection");
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect.mutateAsync();
      toast.success("Zoom Cloud disconnected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect Zoom");
    }
  };

  const handleManualImport = async () => {
    if (!manualMeetingId.trim()) return;
    try {
      await importManual.mutateAsync({
        meetingId: manualMeetingId.trim(),
        topic: manualTopic.trim() || undefined,
      });
      toast.success(`Meeting ${manualMeetingId} import initiated`);
      setIsManualOpen(false);
      setManualMeetingId("");
      setManualTopic("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import Zoom meeting");
    }
  };

  if (isLoading) {
    return (
      <SettingsGroup title="Zoom Cloud" description="Automated cloud recording ingestion.">
        <Skeleton className="h-40 w-full rounded-md" />
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="Zoom Cloud"
      description="Connect your Zoom account to automatically ingest cloud recordings the moment a meeting or webinar ends."
    >
      <Card className="flex flex-col gap-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
              <Video className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-fg-0">Zoom Cloud Account</span>
                {isConnected ? (
                  <Badge tone="accepted">Connected</Badge>
                ) : (
                  <Badge tone="neutral">Not connected</Badge>
                )}
              </div>
              <p className="text-xs text-fg-2">
                {isConnected && "zoomEmail" in integration
                  ? `Connected as ${integration.zoomEmail}`
                  : "Requires Zoom Pro, Business, or Enterprise with Cloud Recording enabled"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isConnected ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsManualOpen(true)}
                  data-testid="zoom-manual-import-btn"
                >
                  Import Meeting ID
                </Button>
                <ConfirmAction
                  title="Disconnect Zoom Cloud?"
                  description="Automatic cloud recording ingestion will stop. Existing projects and clips will remain untouched."
                  confirmLabel="Disconnect"
                  onConfirm={handleDisconnect}
                  trigger={
                    <Button variant="ghost" size="sm" className="text-danger hover:text-danger">
                      Disconnect
                    </Button>
                  }
                />
              </>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={handleConnect}
                disabled={getAuthUrl.isPending}
                data-testid="zoom-connect-btn"
              >
                {getAuthUrl.isPending ? "Connecting..." : "Connect Zoom"}
              </Button>
            )}
          </div>
        </div>

        {isConnected && (
          <div className="flex flex-col gap-4 border-t border-border pt-4">
            <div className="text-sm font-medium text-fg-0">Ingestion & Repurposing Rules</div>

            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 cursor-pointer text-sm text-fg-1">
                <Checkbox
                  checked={autoRepurpose}
                  onCheckedChange={(checked) => setAutoRepurpose(Boolean(checked))}
                />
                <span>Automatically create repurposing runs when recording finishes</span>
              </label>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label="Minimum duration (minutes)"
                  htmlFor="zoom-min-duration"
                  hint="Skip short test calls or quick huddles"
                >
                  <Input
                    id="zoom-min-duration"
                    type="number"
                    min={1}
                    max={300}
                    value={minDurationMin}
                    onChange={(e) => setMinDurationMin(Number(e.target.value) || 1)}
                  />
                </Field>

                <Field
                  label="Topic / Name filter (optional)"
                  htmlFor="zoom-name-filter"
                  hint="Only import meetings containing tag or keyword"
                >
                  <Input
                    id="zoom-name-filter"
                    placeholder="e.g. #webinar, Podcast, All-Hands"
                    value={nameFilter}
                    onChange={(e) => setNameFilter(e.target.value)}
                  />
                </Field>
              </div>

              <div className="flex justify-end pt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSaveSettings}
                  disabled={updateSettings.isPending}
                  data-testid="zoom-save-settings-btn"
                >
                  {updateSettings.isPending ? "Saving..." : "Save Preferences"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Manual Import Dialog */}
      <Dialog open={isManualOpen} onOpenChange={setIsManualOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Zoom Cloud Meeting</DialogTitle>
            <DialogDescription>
              Enter a past Zoom Cloud meeting ID to download its video and isolated audio tracks.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 py-2">
            <Field label="Meeting ID" htmlFor="zoom-manual-meeting-id" hint="Numeric Zoom Meeting ID">
              <Input
                id="zoom-manual-meeting-id"
                placeholder="e.g. 89234567890"
                value={manualMeetingId}
                onChange={(e) => setManualMeetingId(e.target.value)}
              />
            </Field>

            <Field label="Topic / Title (optional)" htmlFor="zoom-manual-topic">
              <Input
                id="zoom-manual-topic"
                placeholder="e.g. Client Strategy Session"
                value={manualTopic}
                onChange={(e) => setManualTopic(e.target.value)}
              />
            </Field>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsManualOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleManualImport}
              disabled={!manualMeetingId.trim() || importManual.isPending}
            >
              {importManual.isPending ? "Importing..." : "Start Ingestion"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}

// -----------------------------------------------------------------------------
// Riverside.fm Studio Connector
// -----------------------------------------------------------------------------

function RiversideStudioCard(): React.JSX.Element {
  const importRiverside = useImportRiverside();

  const [isOpen, setIsOpen] = React.useState(false);
  const [sessionId, setSessionId] = React.useState("");
  const [sessionTitle, setSessionTitle] = React.useState("");
  const [hostUrl, setHostUrl] = React.useState("");
  const [guestName, setGuestName] = React.useState("");
  const [guestUrl, setGuestUrl] = React.useState("");

  const handleImport = async () => {
    if (!sessionId.trim() || !hostUrl.trim()) return;

    const tracks: RiversideStudioTrack[] = [
      {
        speakerName: "Host",
        videoUrl: hostUrl.trim(),
        audioUrl: hostUrl.trim(),
        role: "host",
      },
    ];

    if (guestUrl.trim()) {
      tracks.push({
        speakerName: guestName.trim() || "Guest",
        videoUrl: guestUrl.trim(),
        audioUrl: guestUrl.trim(),
        role: "guest",
      });
    }

    try {
      await importRiverside.mutateAsync({
        sessionId: sessionId.trim(),
        sessionTitle: sessionTitle.trim() || undefined,
        tracks,
      });
      toast.success("Riverside session imported with multi-speaker tracks");
      setIsOpen(false);
      setSessionId("");
      setSessionTitle("");
      setHostUrl("");
      setGuestName("");
      setGuestUrl("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import Riverside session");
    }
  };

  return (
    <SettingsGroup
      title="Riverside.fm Studio"
      description="Ingest multi-track studio recordings with isolated host and guest camera/mic channels."
    >
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-purple-500/10 text-purple-500">
              <Layers className="size-5" />
            </div>
            <div>
              <div className="font-medium text-fg-0">Riverside Studio Multi-Track Ingestion</div>
              <p className="text-xs text-fg-2">
                Ingest separate isolated speaker streams without mixed audio degradation
              </p>
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsOpen(true)}
            data-testid="riverside-import-btn"
          >
            Import Studio Session
          </Button>
        </div>
      </Card>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Riverside.fm Studio Session</DialogTitle>
            <DialogDescription>
              Provide the direct download URLs for individual host and guest tracks.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 py-2">
            <Field label="Session ID" htmlFor="riverside-session-id" hint="Unique studio session identifier">
              <Input
                id="riverside-session-id"
                placeholder="e.g. riv_studio_99182"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
              />
            </Field>

            <Field label="Session Title (optional)" htmlFor="riverside-session-title">
              <Input
                id="riverside-session-title"
                placeholder="e.g. Founder Interview Ep. 4"
                value={sessionTitle}
                onChange={(e) => setSessionTitle(e.target.value)}
              />
            </Field>

            <Field label="Host Video / Audio URL" htmlFor="riverside-host-url" hint="Direct link to primary speaker track">
              <Input
                id="riverside-host-url"
                placeholder="https://..."
                value={hostUrl}
                onChange={(e) => setHostUrl(e.target.value)}
              />
            </Field>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Field label="Guest Name (optional)" htmlFor="riverside-guest-name">
                <Input
                  id="riverside-guest-name"
                  placeholder="e.g. Dr. Jane Smith"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                />
              </Field>
              <Field label="Guest Video URL (optional)" htmlFor="riverside-guest-url">
                <Input
                  id="riverside-guest-url"
                  placeholder="https://..."
                  value={guestUrl}
                  onChange={(e) => setGuestUrl(e.target.value)}
                />
              </Field>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleImport}
              disabled={!sessionId.trim() || !hostUrl.trim() || importRiverside.isPending}
            >
              {importRiverside.isPending ? "Importing..." : "Import Tracks"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}

// -----------------------------------------------------------------------------
// Google Meet Connector
// -----------------------------------------------------------------------------

function GoogleMeetCard(): React.JSX.Element {
  const importMeet = useImportGoogleMeet();

  const [isOpen, setIsOpen] = React.useState(false);
  const [meetCode, setMeetCode] = React.useState("");
  const [recordingFileId, setRecordingFileId] = React.useState("");
  const [title, setTitle] = React.useState("");

  const handleImport = async () => {
    if (!meetCode.trim() || !recordingFileId.trim()) return;

    try {
      await importMeet.mutateAsync({
        meetCode: meetCode.trim(),
        recordingFileId: recordingFileId.trim(),
        title: title.trim() || undefined,
      });
      toast.success("Google Meet recording queued for ingestion");
      setIsOpen(false);
      setMeetCode("");
      setRecordingFileId("");
      setTitle("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import Google Meet recording");
    }
  };

  return (
    <SettingsGroup
      title="Google Meet"
      description="Import Google Meet cloud recordings stored in Google Drive."
    >
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-green-500/10 text-green-500">
              <Radio className="size-5" />
            </div>
            <div>
              <div className="font-medium text-fg-0">Google Meet Recording Import</div>
              <p className="text-xs text-fg-2">
                Ingest meeting recordings saved directly to Meet Recordings Google Drive folder
              </p>
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsOpen(true)}
            data-testid="meet-import-btn"
          >
            Import Meet Recording
          </Button>
        </div>
      </Card>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Google Meet Recording</DialogTitle>
            <DialogDescription>
              Enter the Google Meet code and Google Drive File ID of the saved recording.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 py-2">
            <Field label="Meet Code" htmlFor="meet-code" hint="Meeting code in abc-defg-hij format">
              <Input
                id="meet-code"
                placeholder="e.g. abc-defg-hij"
                value={meetCode}
                onChange={(e) => setMeetCode(e.target.value)}
              />
            </Field>

            <Field label="Drive File ID" htmlFor="meet-drive-id" hint="The ID from Google Drive sharing link">
              <Input
                id="meet-drive-id"
                placeholder="e.g. 1a2B3c4D5e6F..."
                value={recordingFileId}
                onChange={(e) => setRecordingFileId(e.target.value)}
              />
            </Field>

            <Field label="Title (optional)" htmlFor="meet-title">
              <Input
                id="meet-title"
                placeholder="e.g. Q3 Roadmap Review"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleImport}
              disabled={!meetCode.trim() || !recordingFileId.trim() || importMeet.isPending}
            >
              {importMeet.isPending ? "Importing..." : "Import Recording"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}

// -----------------------------------------------------------------------------
// Recent Events Ledger Card
// -----------------------------------------------------------------------------

function RecentEventsLedgerCard(): React.JSX.Element {
  const { data: events, isLoading, refetch } = useZoomEvents();

  return (
    <SettingsGroup
      title="Recording Ingestion Ledger"
      description="Persistent idempotent history of recent Zoom webhook recording events and ingestion states."
    >
      <Card className="flex flex-col p-5">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <span className="text-sm font-medium text-fg-0">Recent Webhook Deliveries</span>
          <Button variant="ghost" size="sm" onClick={() => refetch()} className="gap-1 text-xs">
            <RefreshCw className="size-3" /> Refresh
          </Button>
        </div>

        {isLoading ? (
          <div className="flex flex-col gap-2 py-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : !events || events.length === 0 ? (
          <EmptyState
            title="No recording events yet"
            description="When Zoom finishes processing a cloud recording, the webhook ledger event will appear here automatically."
            className="py-8"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-fg-1">
              <thead>
                <tr className="border-b border-border/50 text-fg-2">
                  <th className="py-2.5 px-2 font-medium">Meeting ID</th>
                  <th className="py-2.5 px-2 font-medium">Topic</th>
                  <th className="py-2.5 px-2 font-medium">Duration</th>
                  <th className="py-2.5 px-2 font-medium">Files</th>
                  <th className="py-2.5 px-2 font-medium">Status</th>
                  <th className="py-2.5 px-2 font-medium">Received</th>
                </tr>
              </thead>
              <tbody className="divide-y border-b border-border/30">
                {events.map((evt) => (
                  <tr key={evt.id} className="hover:bg-neutral-500/5">
                    <td className="py-2 px-2 font-mono text-fg-0">{evt.meetingId}</td>
                    <td className="py-2 px-2 max-w-[200px] truncate">{evt.topic}</td>
                    <td className="py-2 px-2">{evt.durationMin}m</td>
                    <td className="py-2 px-2">{evt.fileCount}</td>
                    <td className="py-2 px-2">
                      <Badge
                        tone={
                          evt.status === "COMPLETED"
                            ? "accepted"
                            : evt.status === "PROCESSING"
                              ? "info"
                              : evt.status === "IGNORED"
                                ? "warning"
                                : "neutral"
                        }
                      >
                        {evt.status}
                      </Badge>
                    </td>
                    <td className="py-2 px-2 text-fg-2">
                      {new Date(evt.createdAt).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </SettingsGroup>
  );
}
