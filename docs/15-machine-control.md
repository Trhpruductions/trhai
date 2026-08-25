# Machine control

TRHAI can run commands on this machine — install a package, run a build, open
an application, inspect the system — and report back what actually happened.

It is **off until you switch it on**, and it switches itself off again. This
document is about that boundary, because it is the only capability in the
build that is not bounded by the workspace, and the reasoning behind it is not
obvious from the code alone.

## What makes this different from everything else

Every other thing the assistant can do is fenced. `write_file`, `build_app`,
the Files surface — all of them resolve through `resolveInWorkspace`, which
refuses any path that lands outside a single directory you chose. A model that
decides to write to `C:\Windows\System32` is stopped by the filesystem layer,
not by the model's good judgement.

A command has no such fence. It runs as you, with everything you can reach.
That is the entire point of it, and it is also the entire risk, so the design
is about **when it is available** rather than about what it is allowed to say.

## Why there is no blocklist

The obvious safety measure — refuse commands containing `rm -rf`, `format`,
`del /f` — was considered and rejected.

It does not work. The set of dangerous commands is open-ended, and any filter
on the text is defeated by writing the same thing into a `.bat` file and
running that instead. A blocklist would produce an assistant that cannot do
ordinary work, while still being able to do damage through whatever it was
allowed. It buys the appearance of safety and very little of the real thing.

This is the same reasoning `workspace.ts` uses for paths: it does not maintain
a list of bad patterns like `../`, it resolves the path and checks where it
landed. A boundary you can check beats a list you can always add one more
entry to.

## The boundary that is actually enforced

**It is off by default.** Not a setting to find and disable — off, until you
press the button on the front screen.

**While off, the model cannot see it.** `run_command` is withheld from the
tool list entirely rather than offered and refused. A model that can see a
tool will reason about it, mention it, and try to talk its way into using it.
One that never sees it cannot. `/v1/capabilities` agrees: it reports the tools
actually on offer, so what is described and what is enforced cannot diverge.

**Switching it on is the authorisation.** There is no second prompt per
command. Asking "are you sure?" after you have just made an explicit,
scoped, expiring grant is the same question twice — and a dialog that appears
on every command is one people click through without reading, which is worse
than one clear decision.

**The grant expires on its own**, thirty minutes after you make it. A
permission that never lapses is one nobody remembers giving. Walking away from
the machine closes it.

**Every command is recorded** with the command line, its real output, and its
exit code — success or failure alike — and the panel showing that sits on the
front screen. An assistant that can act on your machine and does not show you
what it did is asking to be trusted on its own account of events, which is the
one thing this codebase refuses to do anywhere.

**Arming authorises `run_command` and nothing else.** `forget` and
`delete_document` still ask for confirmation. It is a grant to run commands,
not a blanket lifting of the permission ladder.

## What it reports

A non-zero exit code is a **failure**, and the model is told so in the tool
result. This matters more than it sounds: given only "the command failed", a
model will invent a plausible reason; given the real stderr, it can report the
actual one.

- Output is capped at 20,000 bytes, and a truncated log says it was truncated
  rather than ending mid-line as though it were complete.
- A command still running after 120 seconds is stopped, and reported as
  possibly-partly-done rather than as finished or failed — because that is
  genuinely what is known about it.
- A command that could not start at all is distinguished from one that ran and
  exited non-zero.

## Using it

Press **"Let TRHAI use this machine"** on the front screen. The panel turns
amber while it is on and counts down the time remaining. Then ask for what you
want in ordinary words:

> Run the test suite and tell me what failed.

> What version of Python is installed?

> Install the dependencies in this project.

Press **Switch off** when you are done, or leave it and it will close itself.

## Where this is implemented

| Part | File |
| --- | --- |
| Runner, arming window, run log | `apps/api/src/services/commandRunner.ts` |
| Tool definition and the re-check at call time | `apps/api/src/services/agentTools.ts` |
| Permission level | `apps/api/src/services/toolPermissions.ts` |
| Switch, countdown, and the run log on screen | `apps/trhai-web/src/components/CommandAccess.tsx` |
| Routes | `GET/POST /v1/commands`, `/v1/commands/arm`, `/v1/commands/disarm` |

The arming state is checked twice: once when the tool list is built, and again
at the moment a command would actually run. The window can lapse between those
two points, and the check that matters is the one nearest the action.

## What it still cannot do

It runs as your user account. It does not elevate, and nothing here asks for
administrator rights — a command that needs them fails like any other and
reports why.

**Nothing unattended can use it.** A schedule firing on a timer is refused
command access outright, whatever the arming window says — switching machine
control on is a grant for working at the machine, and a timer must not inherit
it merely because the thirty-minute window is still open when it fires.

That gap was real while this document was being written. The scheduler calls
the same orchestrator the chat surface does, so a schedule running a prompt
could have reached `run_command` if the window happened to overlap. It is
gated in two places now: the tool is withheld from the list, and refused again
at the call, so a call the model writes as text rather than through the
interface is caught too. The refusal says plainly that no confirmation can
grant it, rather than telling the model to ask a user who is not there.

Automation flows were never affected — `RUN SCRIPT` goes through the desktop
shell's fixed list of named checks and has no command runner at all.
