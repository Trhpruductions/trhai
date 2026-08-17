import { allPersonalities, personalityById, type PersonalityId } from "../../personalities";
import { Surface } from "../Surface";
import type { SurfaceContext } from "../AppShell";

// Settings: how the assistant sounds, and what it is obliged to say.
//
// The safety constraints are shown as part of each profile rather than buried
// in a footnote. Three of these always append a professional-advice
// disclaimer, and that is enforced in the response path — it is a property of
// the profile, so it belongs where the profile is chosen.

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
    </Surface>
  );
}
