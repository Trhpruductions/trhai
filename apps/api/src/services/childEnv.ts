// The environment a program TRH AI starts is given.
//
// A command the assistant runs, or an app it built and starts, gets the environment
// the service itself runs in - which, when the owner has put the data key or an engine
// key in `.env`, holds that key. The person could read `.env` themselves, so it is not
// a secret from them; it is a secret from a program the model wrote, and from a
// command a page talked the model into. So TRH AI's own secrets are left out of what a
// child is given. Everything else stays: PATH, HOME, the proxy settings - what the
// person's own shell would have.

/** TRH AI's own variables whose value is a key, a secret, a token or a password. */
const ownSecret = /^(TRHAI|ASSIST|ASCEND|VEXORA)_.*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i;

/** Names that are a key however they are spelled. */
const alwaysOut = new Set(["TRHAI_DATA_KEY", "TRHAI_ENGINE_API_KEY"]);

export function isOwnSecretVariable(name: string): boolean {
  return alwaysOut.has(name.toUpperCase()) || ownSecret.test(name);
}

/** The environment for a child process: the service's, without the service's own secrets. */
export function childEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || isOwnSecretVariable(name)) continue;
    out[name] = value;
  }
  return out;
}
