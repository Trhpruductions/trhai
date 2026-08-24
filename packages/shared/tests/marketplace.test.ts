import test from "node:test";
import assert from "node:assert/strict";
import {
  activateAgent,
  activeAgent,
  agentById,
  allAgents,
  emptyMarketplaceState,
  formatInstalls,
  installAgent,
  isInstalled,
  latestVersion,
  parseMarketplaceState,
  readMarketplaceState,
  uninstallAgent,
  writeMarketplaceState
} from "../src/marketplace.js";

test("the catalog covers the vision's seed agent categories", () => {
  assert.deepEqual(
    allAgents().map((agent) => agent.role),
    [
      "Programmer",
      "Designer",
      "Lawyer",
      "Doctor",
      "Researcher",
      "Marketer",
      "Financial advisor",
      "Streamer",
      "Content creator",
      "Game developer"
    ]
  );
});

test("every agent carries the full entity model the vision specifies", () => {
  for (const agent of allAgents()) {
    assert.ok(agent.avatar.length > 0, `${agent.id} has no avatar`);
    assert.ok(agent.name.length > 0 && agent.role.length > 0, `${agent.id} has no name/role`);
    assert.ok(agent.description.length > 30, `${agent.id} has no real description`);
    assert.ok(agent.rating > 0 && agent.rating <= 5, `${agent.id} has an impossible rating`);
    assert.ok(agent.installs > 0, `${agent.id} has no usage signal`);
    assert.ok(agent.versions.length >= 1, `${agent.id} has no version history`);
    for (const version of agent.versions) {
      assert.match(version.releasedOn, /^\d{4}-\d{2}-\d{2}$/, `${agent.id} version needs a date`);
      assert.ok(version.notes.length > 5, `${agent.id} ${version.version} has no update notes`);
    }
    // An installed agent must actually change something.
    assert.ok(agent.suggestions.length >= 3, `${agent.id} contributes no suggestions`);
    assert.ok(agent.focus.length > 10, `${agent.id} has no focus line`);
  }
});

test("version history is newest first", () => {
  for (const agent of allAgents()) {
    const dates = agent.versions.map((version) => version.releasedOn);
    const sorted = [...dates].sort().reverse();
    assert.deepEqual(dates, sorted, `${agent.id} version history is out of order`);
    assert.equal(latestVersion(agent).releasedOn, sorted[0]);
  }
});

test("installing an agent makes it active straight away", () => {
  // Otherwise installing appears to do nothing and the real step is undiscovered.
  const state = installAgent(emptyMarketplaceState, "programmer");

  assert.equal(isInstalled(state, "programmer"), true);
  assert.equal(state.activeAgentId, "programmer");
  assert.equal(activeAgent(state)?.name, "Ada");
});

test("installing a second agent does not steal the active slot", () => {
  const state = installAgent(installAgent(emptyMarketplaceState, "programmer"), "designer");

  assert.deepEqual(state.installed, ["programmer", "designer"]);
  assert.equal(state.activeAgentId, "programmer");
});

test("installing is idempotent and unknown ids are refused", () => {
  const once = installAgent(emptyMarketplaceState, "programmer");

  assert.deepEqual(installAgent(once, "programmer"), once);
  assert.deepEqual(installAgent(once, "not-an-agent"), once);
});

test("uninstalling the active agent hands off instead of dangling", () => {
  const state = installAgent(installAgent(emptyMarketplaceState, "programmer"), "designer");
  const after = uninstallAgent(state, "programmer");

  assert.deepEqual(after.installed, ["designer"]);
  assert.equal(after.activeAgentId, "designer");
});

test("uninstalling the only agent clears the active slot", () => {
  const state = installAgent(emptyMarketplaceState, "programmer");

  assert.equal(uninstallAgent(state, "programmer").activeAgentId, null);
});

test("an agent that is not installed cannot be activated", () => {
  const state = installAgent(emptyMarketplaceState, "programmer");

  assert.equal(activateAgent(state, "designer").activeAgentId, "programmer");
  assert.equal(activateAgent(state, null).activeAgentId, null);
});

test("stored state is narrowed against the current catalog", () => {
  // A saved state outlives the catalog that produced it.
  assert.deepEqual(
    parseMarketplaceState({ installed: ["programmer", "retired-agent", "programmer"], activeAgentId: "retired-agent" }),
    { installed: ["programmer"], activeAgentId: null }
  );
  assert.deepEqual(parseMarketplaceState("nope"), emptyMarketplaceState);
  // An active id that was never installed is not trusted.
  assert.deepEqual(
    parseMarketplaceState({ installed: [], activeAgentId: "programmer" }),
    emptyMarketplaceState
  );
});

test("marketplace state round-trips and a hostile storage never throws", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  } as unknown as Storage;

  const state = installAgent(emptyMarketplaceState, "researcher");
  writeMarketplaceState(storage, "mk", state);
  assert.deepEqual(readMarketplaceState(storage, "mk"), state);

  const hostile = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    }
  } as unknown as Storage;

  assert.deepEqual(readMarketplaceState(hostile, "mk"), emptyMarketplaceState);
  assert.doesNotThrow(() => writeMarketplaceState(hostile, "mk", state));
});

test("install counts format for display", () => {
  assert.equal(formatInstalls(940), "940");
  assert.equal(formatInstalls(12400), "12.4k");
  assert.equal(formatInstalls(5000), "5k");
});

test("agents carrying professional-advice risk say so in their description", () => {
  // These roles invite questions the app must not answer as an authority.
  for (const id of ["lawyer", "doctor", "financial-advisor"]) {
    const agent = agentById(id);
    assert.ok(agent, `${id} missing`);
    assert.match(
      agent.description,
      /not a substitute|does not recommend/i,
      `${id} must not present itself as a professional`
    );
  }
});
