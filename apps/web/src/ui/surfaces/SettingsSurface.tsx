import { useEffect, useState } from "react";
import { allPersonalities, personalityById, type PersonalityId } from "../../personalities";
import { Surface } from "../Surface";
import type { SurfaceContext } from "../AppShell";
import { webEnv } from "../../env";
import { useSpeech } from "../../state/useSpeech";

// Settings: how the assistant sounds, and what it is obliged to say.
//
// The safety constraints are shown as part of each profile rather than buried
// in a footnote. Three of these always append a professional-advice
// disclaimer, and that is enforced in the response path — it is a property of
// the profile, so it belongs where the profile is chosen.

type ApiBuildInfo = {
  apiVersion: string;
  webVersion: string;
  desktopVersion: string;
  environment: string;
  gitCommit: string | null;
  gitCommitShort: string | null;
  gitBranch: string | null;
  gitCommitDate: string | null;
  gitDirty: boolean | null;
  serverStartedAt: string;
};

type DesktopBuildInfo = NonNullable<
  Awaited<ReturnType<NonNullable<NonNullable<typeof window.ascendDesktop>["getBuildInfo"]>>>
>;

/**
 * What build is actually running, read from the API and — when present —
 * from the desktop shell wrapping it.
 *
 * Found live: three differently-aged, differently-architected installs of
 * this app existed on one machine at once, all under the same name, and
 * there was no way to tell which one a given window actually was without
 * comparing file timestamps by hand. This is that answer, always on screen.
 */
function BuildInformation() {
  const [api, setApi] = useState<ApiBuildInfo | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [desktop, setDesktop] = useState<DesktopBuildInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch(`${webEnv.apiBaseUrl}/v1/build-info`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((payload) => { if (!cancelled) setApi(payload?.data ?? null); })
      .catch(() => { if (!cancelled) setApiError("Could not reach the API to read its build info."); });

    // Only present inside the Electron shell; a plain browser tab has
    // nothing at window.ascendDesktop, and that is a normal, expected state,
    // not a failure to report.
    const bridge = window.ascendDesktop?.getBuildInfo;
    if (bridge) {
      bridge().then((result) => { if (!cancelled && result?.ok) setDesktop(result); }).catch(() => {});
    }

    return () => { cancelled = true; };
  }, []);

  const summaryText = () => {
    const lines = [
      api ? `API ${api.apiVersion} · Web ${api.webVersion} · Desktop ${api.desktopVersion}` : null,
      api ? `Commit ${api.gitCommitShort ?? "unknown"} on ${api.gitBranch ?? "unknown branch"}` : null,
      api?.gitDirty ? "Uncommitted changes present" : null,
      api ? `Environment: ${api.environment}` : null,
      desktop ? `Desktop process: ${desktop.environment}, launched via ${desktop.launchedVia}` : null
    ].filter((line): line is string => Boolean(line));
    return lines.join("\n");
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summaryText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused by the browser; the text is still on
      // screen to select by hand, so this is not worth surfacing as an error.
    }
  };

  return (
    <div className="panel build-info">
      <div className="row spread">
        <strong>About this build</strong>
        {api ? (
          <button type="button" className="btn btn-sm" onClick={copy}>
            {copied ? "Copied" : "Copy for a bug report"}
          </button>
        ) : null}
      </div>

      {apiError ? <p className="muted">{apiError}</p> : null}

      {api ? (
        <dl className="build-info-grid">
          <dt>Versions</dt>
          <dd>API {api.apiVersion} · Web {api.webVersion} · Desktop {api.desktopVersion}</dd>

          <dt>Commit</dt>
          <dd title={api.gitCommit ?? undefined}>
            {api.gitCommitShort ?? "unknown"}
            {api.gitBranch ? ` on ${api.gitBranch}` : ""}
            {api.gitDirty ? <span className="chip chip-warn">uncommitted changes</span> : null}
          </dd>

          <dt>Commit date</dt>
          <dd>{api.gitCommitDate ? new Date(api.gitCommitDate).toLocaleString() : "unknown"}</dd>

          <dt>Environment</dt>
          <dd>{api.environment}</dd>

          {desktop ? (
            <>
              <dt>Desktop shell</dt>
              <dd>{desktop.environment} · launched via {desktop.launchedVia}</dd>
              <dt>App path</dt>
              <dd className="mono build-info-path" title={desktop.appPath}>{desktop.appPath}</dd>
            </>
          ) : (
            <>
              <dt>Desktop shell</dt>
              <dd className="muted">Not running inside the desktop app — this is a browser tab.</dd>
            </>
          )}
        </dl>
      ) : apiError ? null : (
        <p className="muted">Reading build information…</p>
      )}
    </div>
  );
}

/**
 * Which voice reads replies aloud.
 *
 * Speech synthesis here is the operating system's: the voices run on this
 * machine, nothing is uploaded and no account is involved. What the machine
 * has installed therefore decides how human it sounds, which is not something
 * the app can change — so when only the older voices are present, this says
 * so and says where the better ones come from, rather than leaving "it sounds
 * robotic" unanswered.
 */
function VoiceSettings({ personality }: { personality: PersonalityId }) {
  const speech = useSpeech();

  if (!speech.availability.available) {
    return (
      <div className="panel voice-settings">
        <strong>Voice</strong>
        <p className="muted">{speech.availability.reason}</p>
      </div>
    );
  }

  return (
    <div className="panel voice-settings">
      <div className="row spread">
        <strong>Voice</strong>
        <button
          type="button"
          className={`btn btn-sm${speech.enabled ? " btn-on" : ""}`}
          aria-pressed={speech.enabled}
          onClick={() => speech.setEnabled(!speech.enabled)}
        >
          {speech.enabled ? "On" : "Off"}
        </button>
      </div>

      <p className="muted voice-desc">
        Replies are read aloud by this machine&apos;s own voices. Nothing is uploaded, and
        the speed and pitch follow whichever personality is active.
      </p>

      <label className="voice-field">
        <span className="label">Which voice</span>
        <select
          className="field"
          value={speech.voiceName ?? ""}
          aria-label="Which voice"
          onChange={(event) => speech.setVoiceName(event.target.value || null)}
        >
          <option value="">Best available</option>
          {speech.voices.map((voice) => (
            <option key={voice.name} value={voice.name}>
              {voice.name}{voice.localService ? "" : " (sends text off this machine)"}
            </option>
          ))}
        </select>
      </label>

      <div className="row voice-actions">
        <button type="button" className="btn btn-sm"
          onClick={() => speech.speaking
            ? speech.stop()
            : speech.speak("This is how I will read replies aloud.", personality)}>
          {speech.speaking ? "Stop" : "Hear it"}
        </button>
      </div>

      {/* The honest answer to "why does it sound robotic". These are Windows
          settings, not something this app can install for you. */}
      {speech.onlyLegacyVoices ? (
        <p className="faint voice-note">
          Only the older built-in voices are installed on this machine, which is why speech
          sounds synthetic. Windows 11 has far more natural ones under
          <b> Settings → Accessibility → Narrator → Add natural voices</b>. They run locally
          too, and this app will use them automatically once they are installed.
        </p>
      ) : null}
    </div>
  );
}

export function SettingsSurface({ context }: { context: SurfaceContext }) {
  const active = personalityById(context.personality);

  return (
    <Surface
      title="Settings"
      summary="Personality changes tone and the prompts it suggests. It does not change what the assistant knows or is willing to claim."
      count={active.label}
      readable={false}
    >
      <div className="personality-grid">
        {allPersonalities().map((profile) => {
          const selected = profile.id === context.personality;

          return (
            <button
              key={profile.id}
              type="button"
              className={`panel personality${selected ? " selected" : ""}`}
              aria-pressed={selected}
              onClick={() => context.setPersonality(profile.id as PersonalityId)}
            >
              <div className="row spread">
                <strong>{profile.label}</strong>
                {selected ? <span className="chip chip-live">Active</span> : null}
              </div>
              <p className="muted personality-desc">{profile.summary}</p>
              {profile.responseStyle.mandatoryDisclaimer ? (
                <span className="chip chip-warn personality-note">Always adds a professional-advice disclaimer</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <VoiceSettings personality={context.personality} />
      <BuildInformation />
    </Surface>
  );
}
