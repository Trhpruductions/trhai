import { useEffect, useState } from "react";
import { generateProject, planProject, type ProjectSpec } from "@ascend/shared";
import { Surface, Empty } from "../Surface";
import type { SurfaceContext } from "../AppShell";
import "./build.css";

// Build: turn a sentence into working software.
//
// The whole point of this screen is that you see the data model *before* any
// files are written. The generator is deterministic, so the spec below is
// exactly what will be produced — there is no gap between the preview and the
// result, and no reason to make the user generate first to find out.

type Generated = { path: string; content: string };

function SpecView({ spec }: { spec: ProjectSpec }) {
  return (
    <div className="col">
      <div className="row wrap build-meta">
        <span className="chip chip-live">{spec.title}</span>
        <span className="chip mono">generated-projects/{spec.slug}</span>
        {spec.features.map((feature) => <span key={feature} className="chip">{feature}</span>)}
      </div>

      {spec.entities.map((entity) => (
        <div key={entity.name} className="panel entity">
          <div className="row spread entity-head">
            <strong className="mono">{entity.name}</strong>
            <span className="label">{entity.fields.length} fields</span>
          </div>
          <ul className="field-list">
            {entity.fields.map((field) => (
              <li key={field.name}>
                <span className="mono">{field.name}</span>
                <span className={`chip${field.type === "reference" ? " chip-live" : ""}`}>
                  {field.type === "reference" ? `→ ${field.references}` : field.type}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function BuildSurface({ context }: { context: SurfaceContext }) {
  const [request, setRequest] = useState("");
  const [spec, setSpec] = useState<ProjectSpec | null>(null);
  const [files, setFiles] = useState<Generated[] | null>(null);
  const [written, setWritten] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // A request handed over from the conversation. Consumed once, so switching
  // back to this screen later does not silently re-run an old build.
  useEffect(() => {
    if (!context.buildSeed) return;
    setRequest(context.buildSeed);
    setSpec(planProject(context.buildSeed));
    context.clearBuildSeed();
  }, [context]);

  const bridge = window.ascendDesktop?.createWorkspaceScaffold;

  function preview() {
    const trimmed = request.trim();
    if (!trimmed) return;
    setProblem(null);
    setWritten(null);
    setFiles(null);
    setSpec(planProject(trimmed));
  }

  function generate() {
    if (!spec) return;
    setFiles(generateProject(spec).map((file) => ({ path: file.path, content: file.content })));
    setWritten(null);
  }

  async function writeToDisk() {
    if (!spec || !files) return;

    if (!bridge) {
      // Said plainly rather than failing quietly: in a browser there is no way
      // to write to the workspace, and pretending otherwise would be the worst
      // outcome here.
      setProblem("Writing files needs the desktop app — a browser tab cannot write to your workspace. The files above are complete; you can still copy them.");
      return;
    }

    setProblem(null);
    let count = 0;
    for (const file of files) {
      const result = await bridge({
        request: spec.title,
        spec: {
          kind: "file",
          path: `generated-projects/${spec.slug}`,
          fileName: file.path,
          content: file.content
        }
      });
      if (result?.ok) count += 1;
    }

    setWritten(count === files.length
      ? `Wrote ${count} files to generated-projects/${spec.slug}`
      : `Wrote ${count} of ${files.length} files — see the desktop log for the rest`);
  }

  return (
    <Surface
      title="Build"
      summary="Describe an app and it generates a running REST service with storage, validation and its own tests. The model is read from your words; nothing is invented that you did not ask for."
      count={spec ? `${spec.entities.length} entities` : undefined}
      actions={spec ? <button type="button" className="btn btn-sm" onClick={() => { setSpec(null); setFiles(null); setWritten(null); }}>Start over</button> : undefined}
    >
      <div className="col build-input">
        <textarea
          className="field"
          value={request}
          rows={3}
          placeholder="Build a support desk where tickets have a title, status and priority"
          aria-label="What to build"
          onChange={(event) => setRequest(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) preview();
          }}
        />
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={preview} disabled={!request.trim()}>
            Read the model
          </button>
          {spec ? (
            <button type="button" className="btn" onClick={generate}>Generate files</button>
          ) : null}
          {files ? (
            <button type="button" className="btn" onClick={() => void writeToDisk()}>
              {bridge ? "Write to workspace" : "Write to workspace…"}
            </button>
          ) : null}
        </div>
      </div>

      {problem ? <p className="chip chip-warn build-note">{problem}</p> : null}
      {written ? <p className="chip chip-ok build-note">{written}</p> : null}

      {spec ? <SpecView spec={spec} /> : (
        <Empty title="Nothing built yet">
          Describe what you want in a sentence. You will see the entities and fields it read
          from your description before a single file is written.
        </Empty>
      )}

      {files ? (
        <div className="panel file-list">
          <div className="label file-list-head">{files.length} files</div>
          {files.map((file) => (
            <details key={file.path}>
              <summary className="mono">{file.path}</summary>
              <pre className="mono file-body">{file.content.slice(0, 4000)}</pre>
            </details>
          ))}
        </div>
      ) : null}
    </Surface>
  );
}
